import {expect} from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {SignedExecutionEvidenceStore} from '../src/core/dast/evidence-store.js';

describe('signed execution evidence', () => {
  let runDirectory: string;
  let trustDirectory: string;

  beforeEach(async () => {
    runDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'execution-evidence-'));
    trustDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'execution-trust-'));
  });

  afterEach(async () => {
    await fs.rm(runDirectory, {force: true, recursive: true});
    await fs.rm(trustDirectory, {force: true, recursive: true});
  });

  it('binds host-observed sandbox output to a run and finding', async () => {
    const store = await SignedExecutionEvidenceStore.create(
      runDirectory,
      'run-001',
      {trustDirectory},
    );
    const artifact = await store.recordSandboxExecution('finding-001', {
      command: 'node safe-poc.js',
      durationMs: 42,
      exitCode: 0,
      stderr: '',
      stdout: 'reproduced',
      timestamp: new Date().toISOString(),
    });

    expect(store.verifyForFinding([artifact.artifactId], 'finding-001'))
      .to.deep.equal([artifact]);
    expect(() => store.verifyForFinding([artifact.artifactId], 'finding-002'))
      .to.throw('belongs to finding "finding-001"');

    const reopened = await SignedExecutionEvidenceStore.create(
      runDirectory,
      'run-001',
      {trustDirectory},
    );
    expect(reopened.verifyForFinding([artifact.artifactId], 'finding-001')[0]?.digest)
      .to.equal(artifact.digest);
  });

  it('rejects modified persisted evidence', async () => {
    const store = await SignedExecutionEvidenceStore.create(
      runDirectory,
      'run-001',
      {trustDirectory},
    );
    const artifact = await store.recordSandboxExecution('finding-001', {
      command: 'node safe-poc.js',
      durationMs: 42,
      exitCode: 1,
      stderr: 'not reproduced',
      stdout: '',
      timestamp: new Date().toISOString(),
    });
    const artifactPath = path.join(
      runDirectory,
      'execution-evidence',
      `${artifact.artifactId}.json`,
    );
    const modified = JSON.parse(await fs.readFile(artifactPath, 'utf8')) as {
      payload: {exitCode: number};
    };
    modified.payload.exitCode = 0;
    await fs.writeFile(artifactPath, JSON.stringify(modified), 'utf8');

    let error: unknown;
    try {
      await SignedExecutionEvidenceStore.create(runDirectory, 'run-001', {trustDirectory});
    } catch (error_) {
      error = error_;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain('has been modified');
  });

  it('rejects unknown and cross-run artifact references', async () => {
    const first = await SignedExecutionEvidenceStore.create(
      runDirectory,
      'run-001',
      {trustDirectory},
    );
    const artifact = await first.recordSandboxExecution('finding-001', {
      command: 'true',
      durationMs: 1,
      exitCode: 0,
      stderr: '',
      stdout: '',
      timestamp: new Date().toISOString(),
    });
    const otherDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'execution-evidence-other-'));
    try {
      const second = await SignedExecutionEvidenceStore.create(
        otherDirectory,
        'run-002',
        {trustDirectory},
      );
      expect(() => second.verifyForFinding([artifact.artifactId], 'finding-001'))
        .to.throw('does not exist');
      expect(() => first.verifyForFinding(['00000000-0000-4000-8000-000000000000'], 'finding-001'))
        .to.throw('does not exist');
    } finally {
      await fs.rm(otherDirectory, {force: true, recursive: true});
    }
  });

  it('does not trust an attacker-supplied key pair beside run artifacts', async () => {
    const attackerDirectory = path.join(runDirectory, 'execution-evidence');
    await fs.mkdir(attackerDirectory, {recursive: true});
    await fs.writeFile(
      path.join(attackerDirectory, 'execution-evidence-private.pem'),
      'attacker private key',
    );
    await fs.writeFile(
      path.join(attackerDirectory, 'execution-evidence-public.pem'),
      'attacker public key',
    );

    const store = await SignedExecutionEvidenceStore.create(
      runDirectory,
      'run-001',
      {trustDirectory},
    );
    const artifact = await store.recordSandboxExecution('finding-001', {
      command: 'true',
      durationMs: 1,
      exitCode: 0,
      stderr: '',
      stdout: '',
      timestamp: new Date().toISOString(),
    });

    expect(store.verifyForFinding([artifact.artifactId], 'finding-001')).to.have.length(1);
    expect(await fs.readdir(trustDirectory)).to.have.members([
      'execution-evidence-private.pem',
      'execution-evidence-public.pem',
    ]);
  });

  it('rejects signed artifacts copied from another target path', async () => {
    const source = await SignedExecutionEvidenceStore.create(
      runDirectory,
      'run-001',
      {trustDirectory},
    );
    const artifact = await source.recordSandboxExecution('finding-001', {
      command: 'true',
      durationMs: 1,
      exitCode: 0,
      stderr: '',
      stdout: '',
      timestamp: new Date().toISOString(),
    });
    const copiedRunDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'copied-evidence-'));
    try {
      const copiedEvidenceDirectory = path.join(copiedRunDirectory, 'execution-evidence');
      await fs.mkdir(copiedEvidenceDirectory);
      await fs.copyFile(
        path.join(runDirectory, 'execution-evidence', `${artifact.artifactId}.json`),
        path.join(copiedEvidenceDirectory, `${artifact.artifactId}.json`),
      );

      let error: unknown;
      try {
        await SignedExecutionEvidenceStore.create(
          copiedRunDirectory,
          'run-001',
          {trustDirectory},
        );
      } catch (error_) {
        error = error_;
      }

      expect((error as Error).message).to.include('invalid signature');
    } finally {
      await fs.rm(copiedRunDirectory, {force: true, recursive: true});
    }
  });
});
