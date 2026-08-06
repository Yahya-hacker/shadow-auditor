import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

import type { SastCandidate } from '../graph/pipeline-artifacts.js';
import type { EnhancedFinding } from '../output/finding-schema.js';

import { recoverAtomicWrite, writeFileAtomic } from '../../utils/fs-atomic.js';
import { createPathGuard, type PathGuard } from '../policy/path-guard.js';

const STORE_VERSION = 1;
const KEY_FILE_NAME = '.shadow-auditor-suppression-key';
const STORE_RELATIVE_PATH = path.join('.shadow-auditor', 'memory', 'false-positives.json');
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 60_000;

const locationFingerprintSchema = z.object({
  fileDigest: z.string().regex(/^[a-f0-9]{64}$/),
  filePath: z.string().min(1),
  lineNumber: z.number().int().positive(),
});

const auditEntrySchema = z.object({
  action: z.enum(['approved', 'revoked', 'reviewed']),
  actor: z.string().min(1).max(500),
  at: z.string().datetime(),
  rationale: z.string().min(1).max(10_000),
});

const suppressionRecordSchema = z.object({
  auditHistory: z.array(auditEntrySchema).min(1).max(1000),
  createdAt: z.string().datetime(),
  cwe: z.string().regex(/^CWE-\d+$/),
  expiresAt: z.string().datetime().optional(),
  findingId: z.string().min(1).max(500),
  id: z.string().uuid(),
  locations: z.array(locationFingerprintSchema).min(1).max(100),
  rationale: z.string().min(1).max(10_000),
  repositoryId: z.string().regex(/^[a-f0-9]{64}$/),
  reviewer: z.string().min(1).max(500),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['approved', 'revoked']),
  title: z.string().min(1).max(1000),
  updatedAt: z.string().datetime(),
});

const suppressionDocumentSchema = z.object({
  records: z.array(z.unknown()).max(100_000),
  version: z.literal(STORE_VERSION),
});

type SuppressionRecord = z.infer<typeof suppressionRecordSchema>;
type LocationFingerprint = z.infer<typeof locationFingerprintSchema>;

export interface SuppressionDecision {
  expiresAt?: string;
  id: string;
  rationale: string;
  reviewer: string;
}

export interface SuppressionListEntry extends SuppressionDecision {
  cwe: string;
  findingId: string;
  state: 'active' | 'expired' | 'revoked' | 'stale';
  title: string;
  updatedAt: string;
}

export interface SuppressionStoreStatus {
  invalidRecords: number;
  storeError?: string;
}

export interface SuppressionFindingInput {
  cwe: string;
  locations: EnhancedFinding['locations'];
  title: string;
  vulnId: string;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalize(record[key])}`,
    ).join(',')}}`;
  }

  return JSON.stringify(value);
}

function unsignedRecord(record: SuppressionRecord): Omit<SuppressionRecord, 'signature'> {
  const {signature: _signature, ...unsigned} = record;
  return unsigned;
}

function signRecord(record: Omit<SuppressionRecord, 'signature'>, key: Buffer): string {
  return crypto.createHmac('sha256', key).update(canonicalize(record)).digest('hex');
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

async function digestFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function loadOrCreateKey(keyPath: string): Promise<Buffer> {
  try {
    const encoded = (await fs.readFile(keyPath, 'utf8')).trim();
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32) throw new Error('suppression signing key has an invalid length');
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const key = crypto.randomBytes(32);
  await fs.mkdir(path.dirname(keyPath), {mode: 0o700, recursive: true});
  try {
    const file = await fs.open(keyPath, 'wx', 0o600);
    try {
      await file.writeFile(`${key.toString('base64')}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }

    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      const encoded = (await fs.readFile(keyPath, 'utf8')).trim();
      const existing = Buffer.from(encoded, 'base64');
      if (existing.length === 32) return existing;
      if (Date.now() >= deadline) {
        throw new Error('suppression signing key has an invalid length');
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, LOCK_RETRY_MS);
      });
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function reclaimAbandonedLock(lockPath: string): Promise<boolean> {
  let canReclaimImmediately = false;
  try {
    const owner = JSON.parse(
      await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8'),
    ) as {createdAt?: number; pid?: number};
    if (
      typeof owner.pid === 'number' &&
      Number.isInteger(owner.pid) &&
      owner.pid > 0 &&
      processIsAlive(owner.pid)
    ) {
      return false;
    }

    canReclaimImmediately = typeof owner.pid === 'number' && Number.isInteger(owner.pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      throw error;
    }
  }

  if (!canReclaimImmediately) {
    try {
      const stats = await fs.stat(lockPath);
      if (Date.now() - stats.mtimeMs <= STALE_LOCK_MS) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  }

  const abandonedPath = `${lockPath}.abandoned-${crypto.randomUUID()}`;
  try {
    await fs.rename(lockPath, abandonedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }

  await fs.rm(abandonedPath, {force: true, recursive: true});
  return true;
}

async function removeAbandonedLock(lockPath: string): Promise<boolean> {
  const reclaimPath = `${lockPath}.reclaim`;
  try {
    await fs.mkdir(reclaimPath, {mode: 0o700});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }

  let reclaimed: boolean;
  try {
    reclaimed = await reclaimAbandonedLock(lockPath);
  } catch (operationError) {
    try {
      await fs.rm(reclaimPath, {force: true, recursive: true});
    } catch (releaseError) {
      throw new AggregateError(
        [operationError, releaseError],
        'False-positive memory lock recovery and cleanup both failed.',
      );
    }

    throw operationError;
  }

  await fs.rm(reclaimPath, {force: true, recursive: true});
  return reclaimed;
}

export class FalsePositiveStore {
  private readonly guard: PathGuard;
  private invalidRecords = 0;
  private readonly key: Buffer;
  private readonly now: () => Date;
  private operationTail = Promise.resolve();
  private records: SuppressionRecord[] = [];
  private readonly repositoryId: string;
  private storeError?: string;
  private readonly storePath: string;

  private constructor(options: {
    guard: PathGuard;
    key: Buffer;
    now: () => Date;
    repositoryId: string;
    storePath: string;
  }) {
    this.guard = options.guard;
    this.key = options.key;
    this.now = options.now;
    this.repositoryId = options.repositoryId;
    this.storePath = options.storePath;
  }

  static async open(
    repositoryPath: string,
    options: {keyPath?: string; now?: () => Date} = {},
  ): Promise<FalsePositiveStore> {
    const guard = await createPathGuard(repositoryPath);
    const repositoryId = crypto.createHash('sha256')
      .update(guard.rootRealPath)
      .digest('hex');
    const keyPath = options.keyPath ?? path.join(os.homedir(), KEY_FILE_NAME);
    const key = await loadOrCreateKey(keyPath);
    const storePath = await guard.resolvePathForWrite(STORE_RELATIVE_PATH);
    const store = new FalsePositiveStore({
      guard,
      key,
      now: options.now ?? (() => new Date()),
      repositoryId,
      storePath,
    });
    await store.withInterprocessLock(() => store.load());
    return store;
  }

  async approve(
    finding: SuppressionFindingInput,
    reviewer: string,
    rationale: string,
    expiresAt?: string,
  ): Promise<SuppressionDecision> {
    const normalizedReviewer = reviewer.trim();
    const normalizedRationale = rationale.trim();
    if (!normalizedReviewer) throw new Error('A human reviewer identity is required.');
    if (!normalizedRationale) throw new Error('A suppression rationale is required.');
    const normalizedExpiry = expiresAt ? new Date(expiresAt).toISOString() : undefined;
    if (normalizedExpiry && Date.parse(normalizedExpiry) <= this.now().getTime()) {
      throw new Error('Suppression expiry must be in the future.');
    }

    return this.serialize(async () => {
      this.assertWritable();
      const now = this.now().toISOString();
      const locations = await this.fingerprintLocations(
        finding.locations.map((location) => ({
          filePath: location.filePath,
          lineNumber: location.startLine ?? 1,
        })),
      );
      const unsigned: Omit<SuppressionRecord, 'signature'> = {
        auditHistory: [{
          action: 'approved',
          actor: normalizedReviewer,
          at: now,
          rationale: normalizedRationale,
        }],
        createdAt: now,
        cwe: finding.cwe,
        ...(normalizedExpiry ? {expiresAt: normalizedExpiry} : {}),
        findingId: finding.vulnId,
        id: crypto.randomUUID(),
        locations,
        rationale: normalizedRationale,
        repositoryId: this.repositoryId,
        reviewer: normalizedReviewer,
        status: 'approved',
        title: finding.title,
        updatedAt: now,
      };
      const record = {...unsigned, signature: signRecord(unsigned, this.key)};
      this.records.push(record);
      await this.persist();
      return this.toDecision(record);
    });
  }

  getStatus(): SuppressionStoreStatus {
    return {
      invalidRecords: this.invalidRecords,
      ...(this.storeError ? {storeError: this.storeError} : {}),
    };
  }

  async list(): Promise<SuppressionListEntry[]> {
    return this.serialize(async () => {
      const now = this.now().getTime();
      return Promise.all(this.records.map(async (record) => {
        let stale = false;
        try {
          const current = await this.fingerprintLocations(record.locations);
          stale = !this.locationsEqual(record.locations, current);
        } catch {
          stale = true;
        }

        const state: SuppressionListEntry['state'] =
          record.status === 'revoked' ? 'revoked'
            : record.expiresAt && Date.parse(record.expiresAt) <= now ? 'expired'
              : stale ? 'stale'
                : 'active';
        return {
          ...this.toDecision(record),
          cwe: record.cwe,
          findingId: record.findingId,
          state,
          title: record.title,
          updatedAt: record.updatedAt,
        };
      }));
    });
  }

  async match(candidate: SastCandidate): Promise<null | SuppressionDecision> {
    return this.serialize(async () => {
      if (this.storeError) return null;
      let locations: LocationFingerprint[];
      try {
        locations = await this.fingerprintLocations(candidate.affectedLocations);
      } catch {
        return null;
      }

      const now = this.now().getTime();
      const match = this.records.find((record) =>
        record.status === 'approved' &&
        record.repositoryId === this.repositoryId &&
        (!record.expiresAt || Date.parse(record.expiresAt) > now) &&
        record.cwe === candidate.cwe &&
        this.locationsEqual(record.locations, locations),
      );
      return match ? this.toDecision(match) : null;
    });
  }

  async revoke(
    id: string,
    reviewer: string,
    rationale: string,
  ): Promise<SuppressionDecision> {
    return this.serialize(async () => {
      this.assertWritable();
      const index = this.records.findIndex((record) => record.id === id);
      if (index === -1) throw new Error(`Suppression "${id}" was not found.`);
      const current = this.records[index]!;
      const now = this.now().toISOString();
      const unsigned: Omit<SuppressionRecord, 'signature'> = {
        ...unsignedRecord(current),
        auditHistory: [...current.auditHistory, {
          action: 'revoked',
          actor: reviewer.trim(),
          at: now,
          rationale: rationale.trim(),
        }],
        rationale: rationale.trim(),
        reviewer: reviewer.trim(),
        status: 'revoked',
        updatedAt: now,
      };
      if (!unsigned.reviewer || !unsigned.rationale) {
        throw new Error('Revocation requires a human reviewer and rationale.');
      }

      const updated = {...unsigned, signature: signRecord(unsigned, this.key)};
      this.records[index] = updated;
      await this.persist();
      return this.toDecision(updated);
    });
  }

  private assertWritable(): void {
    if (this.storeError || this.invalidRecords > 0) {
      throw new Error(
        'False-positive memory failed integrity validation. Repair or remove the invalid store before changing suppressions.',
      );
    }
  }

  private async fingerprintLocations(
    locations: ReadonlyArray<{filePath: string; lineNumber?: number; startLine?: number}>,
  ): Promise<LocationFingerprint[]> {
    const fingerprints = await Promise.all(locations.map(async (location) => {
      const absolutePath = await this.guard.resolveExistingPath(location.filePath);
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) throw new Error(`Suppression location is not a regular file: ${location.filePath}`);
      return {
        fileDigest: await digestFile(absolutePath),
        filePath: normalizeRelativePath(this.guard.toRelative(absolutePath)),
        lineNumber: location.lineNumber ?? location.startLine ?? 1,
      };
    }));
    return fingerprints.sort((left, right) =>
      left.filePath.localeCompare(right.filePath) || left.lineNumber - right.lineNumber,
    );
  }

  private async load(): Promise<void> {
    this.invalidRecords = 0;
    this.records = [];
    this.storeError = undefined;
    await recoverAtomicWrite(this.storePath);
    let raw: string;
    try {
      raw = await fs.readFile(this.storePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    try {
      const document = suppressionDocumentSchema.parse(JSON.parse(raw));
      for (const candidate of document.records) {
        const parsed = suppressionRecordSchema.safeParse(candidate);
        if (!parsed.success) {
          this.invalidRecords++;
          continue;
        }

        const record = parsed.data;
        const expected = signRecord(unsignedRecord(record), this.key);
        if (
          record.repositoryId !== this.repositoryId ||
          !crypto.timingSafeEqual(Buffer.from(record.signature), Buffer.from(expected))
        ) {
          this.invalidRecords++;
          continue;
        }

        this.records.push(record);
      }
    } catch (error) {
      this.storeError = error instanceof Error ? error.message : String(error);
    }
  }

  private locationsEqual(
    left: readonly LocationFingerprint[],
    right: readonly LocationFingerprint[],
  ): boolean {
    return left.length === right.length && left.every((location, index) => {
      const other = right[index];
      return other !== undefined &&
        location.fileDigest === other.fileDigest &&
        location.filePath === other.filePath &&
        location.lineNumber === other.lineNumber;
    });
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath), {mode: 0o700, recursive: true});
    await writeFileAtomic(
      this.storePath,
      `${JSON.stringify({records: this.records, version: STORE_VERSION}, null, 2)}\n`,
    );
  }

  private async releaseInterprocessLock(
    lockPath: string,
    ownerPath: string,
    token: string,
  ): Promise<void> {
    const releasedPath = `${lockPath}.released-${token}`;
    try {
      const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8')) as {token?: string};
      if (owner.token !== token) {
        throw new Error('False-positive memory lock ownership changed unexpectedly.');
      }

      await fs.rename(lockPath, releasedPath);
      await fs.rm(releasedPath, {force: true, recursive: true});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const execute = () => this.withInterprocessLock(async () => {
      await this.load();
      return operation();
    });
    const result = this.operationTail.then(execute, execute);
    this.operationTail = result.then(() => {}, () => {});
    return result;
  }

  private toDecision(record: SuppressionRecord): SuppressionDecision {
    return {
      ...(record.expiresAt ? {expiresAt: record.expiresAt} : {}),
      id: record.id,
      rationale: record.rationale,
      reviewer: record.reviewer,
    };
  }

  private async withInterprocessLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.storePath}.lock`;
    const ownerPath = path.join(lockPath, 'owner.json');
    const token = crypto.randomUUID();
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    await fs.mkdir(path.dirname(this.storePath), {mode: 0o700, recursive: true});

    while (true) {
      const candidatePath = `${lockPath}.candidate-${token}`;
      try {
        await fs.mkdir(candidatePath, {mode: 0o700});
        await fs.writeFile(
          path.join(candidatePath, 'owner.json'),
          JSON.stringify({createdAt: Date.now(), pid: process.pid, token}),
          {encoding: 'utf8', flag: 'wx', mode: 0o600},
        );
      } catch (error) {
        try {
          await fs.rm(candidatePath, {force: true, recursive: true});
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Failed to initialize and clean up a false-positive memory lock candidate.',
          );
        }

        throw error;
      }

      let acquisitionError: unknown;
      try {
        await fs.rename(candidatePath, lockPath);
        break;
      } catch (error) {
        acquisitionError = error;
      }

      try {
        await fs.rm(candidatePath, {force: true, recursive: true});
      } catch (cleanupError) {
        throw new AggregateError(
          [acquisitionError, cleanupError],
          'Failed to acquire and clean up a false-positive memory lock candidate.',
        );
      }

      const acquisitionCode = (acquisitionError as NodeJS.ErrnoException).code;
      if (acquisitionCode !== 'EEXIST' && acquisitionCode !== 'ENOTEMPTY') {
        throw acquisitionError;
      }

      if (await removeAbandonedLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for the false-positive memory lock.');
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, LOCK_RETRY_MS);
      });
    }

    let result: T;
    try {
      result = await operation();
    } catch (operationError) {
      try {
        await this.releaseInterprocessLock(lockPath, ownerPath, token);
      } catch (releaseError) {
        throw new AggregateError(
          [operationError, releaseError],
          'False-positive memory operation and lock cleanup both failed.',
        );
      }

      throw operationError;
    }

    await this.releaseInterprocessLock(lockPath, ownerPath, token);
    return result;
  }
}
