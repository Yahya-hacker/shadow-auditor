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
  await writeFileAtomic(keyPath, `${key.toString('base64')}\n`);
  return key;
}

export class FalsePositiveStore {
  private invalidRecords = 0;
  private operationTail = Promise.resolve();
  private records: SuppressionRecord[] = [];
  private storeError?: string;

  private constructor(
    private readonly guard: PathGuard,
    private readonly key: Buffer,
    private readonly repositoryId: string,
    private readonly storePath: string,
    private readonly now: () => Date,
  ) {}

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
    const store = new FalsePositiveStore(
      guard,
      key,
      repositoryId,
      storePath,
      options.now ?? (() => new Date()),
    );
    await store.load();
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
  }

  async match(candidate: SastCandidate): Promise<null | SuppressionDecision> {
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

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
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
}
