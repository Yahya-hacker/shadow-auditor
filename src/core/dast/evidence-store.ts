import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  SandboxExecResult,
  SignedExecutionEvidence,
} from './dast-schema.js';

import {writeFileAtomic} from '../../utils/fs-atomic.js';
import {defaultTrustPath} from '../../utils/host-trust.js';
import {SCHEMA_VERSION} from '../schema/base.js';
import {
  sandboxExecResultSchema,
  signedExecutionEvidenceSchema,
} from './dast-schema.js';

const PRIVATE_KEY_FILE = 'execution-evidence-private.pem';
const PUBLIC_KEY_FILE = 'execution-evidence-public.pem';

interface UnsignedExecutionEvidence {
  artifactId: string;
  auditRunId: string;
  capturedAt: string;
  findingId: string;
  kind: 'sandbox_execution';
  payload: SandboxExecResult;
  schemaVersion: string;
}

export interface ExecutionEvidenceVerifier {
  verifyForFinding(
    artifactIds: readonly string[],
    findingId: string,
  ): SignedExecutionEvidence[];
}

interface EvidenceStoreKeys {
  privateKey: string;
  publicKey: string;
  publicKeyFingerprint: string;
}

function canonicalEvidence(value: UnsignedExecutionEvidence): string {
  return JSON.stringify({
    artifactId: value.artifactId,
    auditRunId: value.auditRunId,
    capturedAt: value.capturedAt,
    findingId: value.findingId,
    kind: value.kind,
    payload: {
      command: value.payload.command,
      durationMs: value.payload.durationMs,
      exitCode: value.payload.exitCode,
      stderr: value.payload.stderr,
      stdout: value.payload.stdout,
      timestamp: value.payload.timestamp,
    },
    schemaVersion: value.schemaVersion,
  });
}

function unsignedEvidence(
  value: SignedExecutionEvidence,
): UnsignedExecutionEvidence {
  return {
    artifactId: value.artifactId,
    auditRunId: value.auditRunId,
    capturedAt: value.capturedAt,
    findingId: value.findingId,
    kind: value.kind,
    payload: value.payload,
    schemaVersion: value.schemaVersion,
  };
}

async function readRegularFile(filePath: string): Promise<string> {
  const stats = await fs.lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Execution evidence path is not a regular file: ${filePath}`);
  }

  return fs.readFile(filePath, 'utf8');
}

export class SignedExecutionEvidenceStore implements ExecutionEvidenceVerifier {
  private readonly artifacts = new Map<string, SignedExecutionEvidence>();

  private constructor(
    private readonly auditRunId: string,
    private readonly evidenceDirectory: string,
    private readonly keys: EvidenceStoreKeys,
    private readonly trustContext: string,
  ) {}

  static async create(
    runDirectory: string,
    auditRunId: string,
    options: {trustDirectory?: string} = {},
  ): Promise<SignedExecutionEvidenceStore> {
    const evidenceDirectory = path.join(runDirectory, 'execution-evidence');
    await fs.mkdir(evidenceDirectory, {mode: 0o700, recursive: true});
    const trustDirectory = options.trustDirectory
      ?? path.dirname(defaultTrustPath(PRIVATE_KEY_FILE));
    await fs.mkdir(trustDirectory, {mode: 0o700, recursive: true});
    const privateKeyPath = path.join(trustDirectory, PRIVATE_KEY_FILE);
    const publicKeyPath = path.join(trustDirectory, PUBLIC_KEY_FILE);

    const [privateExists, publicExists] = await Promise.all([
      fs.lstat(privateKeyPath).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      }),
      fs.lstat(publicKeyPath).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      }),
    ]);

    if (privateExists !== publicExists) {
      throw new Error('Execution evidence signing key pair is incomplete.');
    }

    if (!privateExists) {
      const pair = generateKeyPairSync('ed25519');
      await Promise.all([
        writeFileAtomic(
          privateKeyPath,
          pair.privateKey.export({format: 'pem', type: 'pkcs8'}).toString(),
        ),
        writeFileAtomic(
          publicKeyPath,
          pair.publicKey.export({format: 'pem', type: 'spki'}).toString(),
        ),
      ]);
      await Promise.all([
        fs.chmod(privateKeyPath, 0o600),
        fs.chmod(publicKeyPath, 0o600),
      ]);
    }

    const [privateKey, publicKey] = await Promise.all([
      readRegularFile(privateKeyPath),
      readRegularFile(publicKeyPath),
    ]);
    const challenge = Buffer.from(`shadow-auditor:${auditRunId}`, 'utf8');
    const challengeSignature = sign(null, challenge, privateKey);
    if (!verify(null, challenge, publicKey, challengeSignature)) {
      throw new Error('Execution evidence signing key pair does not match.');
    }

    const publicKeyFingerprint = `sha256:${createHash('sha256')
      .update(publicKey)
      .digest('hex')}`;
    const trustContext = await fs.realpath(runDirectory);
    const store = new SignedExecutionEvidenceStore(
      auditRunId,
      evidenceDirectory,
      {privateKey, publicKey, publicKeyFingerprint},
      trustContext,
    );
    await store.loadArtifacts();
    return store;
  }

  async recordSandboxExecution(
    findingId: string,
    result: SandboxExecResult,
  ): Promise<SignedExecutionEvidence> {
    if (!findingId.trim()) throw new Error('A finding ID is required for execution evidence.');
    const payload = sandboxExecResultSchema.parse(result);
    const unsigned: UnsignedExecutionEvidence = {
      artifactId: randomUUID(),
      auditRunId: this.auditRunId,
      capturedAt: new Date().toISOString(),
      findingId,
      kind: 'sandbox_execution',
      payload,
      schemaVersion: SCHEMA_VERSION,
    };
    const canonical = canonicalEvidence(unsigned);
    const artifact = signedExecutionEvidenceSchema.parse({
      ...unsigned,
      digest: createHash('sha256').update(canonical).digest('hex'),
      publicKeyFingerprint: this.keys.publicKeyFingerprint,
      signature: sign(
        null,
        Buffer.from(`${canonical}\0${this.trustContext}`, 'utf8'),
        this.keys.privateKey,
      ).toString('base64'),
      signatureAlgorithm: 'Ed25519',
    });
    await writeFileAtomic(
      path.join(this.evidenceDirectory, `${artifact.artifactId}.json`),
      `${JSON.stringify(artifact, null, 2)}\n`,
    );
    this.artifacts.set(artifact.artifactId, artifact);
    return artifact;
  }

  verifyForFinding(
    artifactIds: readonly string[],
    findingId: string,
  ): SignedExecutionEvidence[] {
    const uniqueIds = [...new Set(artifactIds)];
    return uniqueIds.map((artifactId) => {
      const artifact = this.artifacts.get(artifactId);
      if (!artifact) {
        throw new Error(`Execution evidence artifact "${artifactId}" does not exist.`);
      }

      if (artifact.auditRunId !== this.auditRunId) {
        throw new Error(`Execution evidence artifact "${artifactId}" belongs to another audit run.`);
      }

      if (artifact.findingId !== findingId) {
        throw new Error(
          `Execution evidence artifact "${artifactId}" belongs to finding "${artifact.findingId}", not "${findingId}".`,
        );
      }

      this.assertValidSignature(artifact);
      return artifact;
    });
  }

  private assertValidSignature(artifact: SignedExecutionEvidence): void {
    const canonical = canonicalEvidence(unsignedEvidence(artifact));
    const digest = createHash('sha256').update(canonical).digest('hex');
    if (digest !== artifact.digest) {
      throw new Error(`Execution evidence artifact "${artifact.artifactId}" has been modified.`);
    }

    const valid = verify(
      null,
      Buffer.from(`${canonical}\0${this.trustContext}`, 'utf8'),
      this.keys.publicKey,
      Buffer.from(artifact.signature, 'base64'),
    );
    if (!valid || artifact.publicKeyFingerprint !== this.keys.publicKeyFingerprint) {
      throw new Error(`Execution evidence artifact "${artifact.artifactId}" has an invalid signature.`);
    }
  }

  private async loadArtifacts(): Promise<void> {
    const entries = await fs.readdir(this.evidenceDirectory, {withFileTypes: true});
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/i.test(entry.name)) continue;
      const artifactPath = path.join(this.evidenceDirectory, entry.name);
      const artifact = signedExecutionEvidenceSchema.parse(
        JSON.parse(await readRegularFile(artifactPath)),
      );
      if (`${artifact.artifactId}.json` !== entry.name) {
        throw new Error(`Execution evidence filename does not match artifact ID: ${entry.name}`);
      }

      this.assertValidSignature(artifact);
      if (artifact.auditRunId !== this.auditRunId) {
        throw new Error(`Execution evidence artifact "${artifact.artifactId}" belongs to another audit run.`);
      }

      this.artifacts.set(artifact.artifactId, artifact);
    }
  }
}
