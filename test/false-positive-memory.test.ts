import {expect} from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type {SastCandidate} from '../src/core/graph/pipeline-artifacts.js';

import {FalsePositiveStore} from '../src/core/memory/false-positive-store.js';

function candidate(filePath = 'src/handler.ts'): SastCandidate {
  return {
    affectedLocations: [{filePath, lineNumber: 1, snippet: 'unsafe(input)'}],
    confidence: 0.9,
    cwe: 'CWE-22',
    evidence: ['User input reaches a filesystem sink.'],
    findingId: 'candidate-1',
    impact: 'Arbitrary file read',
    prerequisites: ['Remote access'],
    proofOfConcept: {
      content: '../secret',
      evidenceArtifactIds: [],
      executionStatus: 'not_run',
      kind: 'payload',
      safetyNotes: 'Static proof only',
    },
    reachability: 'likely',
    remediation: 'Constrain paths.',
    reproductionSteps: ['Submit a traversal path.'],
    severity: 'high',
    sourceToSink: [
      {
        description: 'Input source',
        kind: 'source',
        location: {filePath, lineNumber: 1},
      },
      {
        description: 'Filesystem sink',
        kind: 'sink',
        location: {filePath, lineNumber: 1},
      },
    ],
    summary: 'Path traversal',
    title: 'Path traversal in file handler',
  };
}

describe('false-positive memory', () => {
  let keyPath: string;
  let repositoryPath: string;
  let tempPath: string;

  beforeEach(async () => {
    tempPath = await fs.mkdtemp(path.join(os.tmpdir(), 'false-positive-memory-'));
    repositoryPath = path.join(tempPath, 'repository');
    keyPath = path.join(tempPath, 'host-key');
    await fs.mkdir(path.join(repositoryPath, 'src'), {recursive: true});
    await fs.writeFile(path.join(repositoryPath, 'src', 'handler.ts'), 'unsafe(input);\n');
  });

  afterEach(async () => {
    await fs.rm(tempPath, {force: true, recursive: true});
  });

  it('activates only a matching human-approved decision and records revocation', async () => {
    const store = await FalsePositiveStore.open(repositoryPath, {keyPath});
    const decision = await store.approve({
      cwe: 'CWE-22',
      locations: [{filePath: 'src/handler.ts', startLine: 1}],
      title: 'Path traversal in file handler',
      vulnId: 'SHADOW-022-TEST',
    }, 'Security Reviewer', 'The route is restricted to a fixed allowlist.');

    expect(await store.match(candidate())).to.deep.equal(decision);
    expect((await store.list())[0]?.state).to.equal('active');

    await store.revoke(decision.id, 'Security Lead', 'The allowlist was removed.');
    expect(await store.match(candidate())).to.equal(null);
    expect((await store.list())[0]?.state).to.equal('revoked');
  });

  it('invalidates a decision when affected code changes', async () => {
    const store = await FalsePositiveStore.open(repositoryPath, {keyPath});
    await store.approve({
      cwe: 'CWE-22',
      locations: [{filePath: 'src/handler.ts', startLine: 1}],
      title: 'Path traversal in file handler',
      vulnId: 'SHADOW-022-TEST',
    }, 'Reviewer', 'Reviewed architecture constraint.');
    await fs.writeFile(path.join(repositoryPath, 'src', 'handler.ts'), 'unsafe(newInput);\n');

    expect(await store.match(candidate())).to.equal(null);
    expect((await store.list())[0]?.state).to.equal('stale');
  });

  it('expires decisions using host time', async () => {
    let now = new Date('2030-01-01T00:00:00.000Z');
    const store = await FalsePositiveStore.open(repositoryPath, {
      keyPath,
      now: () => now,
    });
    await store.approve({
      cwe: 'CWE-22',
      locations: [{filePath: 'src/handler.ts', startLine: 1}],
      title: 'Path traversal in file handler',
      vulnId: 'SHADOW-022-TEST',
    }, 'Reviewer', 'Temporary accepted risk.', '2030-02-01T00:00:00.000Z');
    now = new Date('2030-03-01T00:00:00.000Z');

    expect(await store.match(candidate())).to.equal(null);
    expect((await store.list())[0]?.state).to.equal('expired');
  });

  it('rejects tampered records and disables writes until repaired', async () => {
    const store = await FalsePositiveStore.open(repositoryPath, {keyPath});
    await store.approve({
      cwe: 'CWE-22',
      locations: [{filePath: 'src/handler.ts', startLine: 1}],
      title: 'Path traversal in file handler',
      vulnId: 'SHADOW-022-TEST',
    }, 'Reviewer', 'Original rationale.');
    const storePath = path.join(
      repositoryPath,
      '.shadow-auditor',
      'memory',
      'false-positives.json',
    );
    const document = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      records: Array<{rationale: string}>;
    };
    document.records[0]!.rationale = 'Forged rationale';
    await fs.writeFile(storePath, JSON.stringify(document));

    const reopened = await FalsePositiveStore.open(repositoryPath, {keyPath});
    expect(reopened.getStatus().invalidRecords).to.equal(1);
    expect(await reopened.match(candidate())).to.equal(null);
    let error: unknown;
    try {
      await reopened.approve({
        cwe: 'CWE-22',
        locations: [{filePath: 'src/handler.ts', startLine: 1}],
        title: 'Another finding',
        vulnId: 'SHADOW-022-OTHER',
      }, 'Reviewer', 'Attempted write.');
    } catch (error_) {
      error = error_;
    }

    expect((error as Error).message).to.contain('integrity validation');
  });

  it('isolates copied decisions from another repository and serializes concurrent updates', async () => {
    const store = await FalsePositiveStore.open(repositoryPath, {keyPath});
    await Promise.all([
      store.approve({
        cwe: 'CWE-22',
        locations: [{filePath: 'src/handler.ts', startLine: 1}],
        title: 'First',
        vulnId: 'SHADOW-022-FIRST',
      }, 'Reviewer', 'First rationale.'),
      store.approve({
        cwe: 'CWE-22',
        locations: [{filePath: 'src/handler.ts', startLine: 1}],
        title: 'Second',
        vulnId: 'SHADOW-022-SECOND',
      }, 'Reviewer', 'Second rationale.'),
    ]);
    expect(await store.list()).to.have.length(2);

    const otherRepository = path.join(tempPath, 'other');
    await fs.mkdir(path.join(otherRepository, 'src'), {recursive: true});
    await fs.writeFile(path.join(otherRepository, 'src', 'handler.ts'), 'unsafe(input);\n');
    await fs.mkdir(path.join(otherRepository, '.shadow-auditor', 'memory'), {recursive: true});
    await fs.copyFile(
      path.join(repositoryPath, '.shadow-auditor', 'memory', 'false-positives.json'),
      path.join(otherRepository, '.shadow-auditor', 'memory', 'false-positives.json'),
    );

    const isolated = await FalsePositiveStore.open(otherRepository, {keyPath});
    expect(isolated.getStatus().invalidRecords).to.equal(2);
    expect(await isolated.match(candidate())).to.equal(null);
  });

  it('preserves concurrent updates from independently opened stores', async () => {
    const [firstStore, secondStore] = await Promise.all([
      FalsePositiveStore.open(repositoryPath, {keyPath}),
      FalsePositiveStore.open(repositoryPath, {keyPath}),
    ]);
    await Promise.all([
      firstStore.approve({
        cwe: 'CWE-22',
        locations: [{filePath: 'src/handler.ts', startLine: 1}],
        title: 'First process',
        vulnId: 'SHADOW-022-FIRST-PROCESS',
      }, 'Reviewer', 'First independent rationale.'),
      secondStore.approve({
        cwe: 'CWE-22',
        locations: [{filePath: 'src/handler.ts', startLine: 1}],
        title: 'Second process',
        vulnId: 'SHADOW-022-SECOND-PROCESS',
      }, 'Reviewer', 'Second independent rationale.'),
    ]);

    expect(await firstStore.list()).to.have.length(2);
    const reopened = await FalsePositiveStore.open(repositoryPath, {keyPath});
    expect(await reopened.list()).to.have.length(2);
  });

  it('atomically reclaims an abandoned ownerless lock under contention', async () => {
    const [firstStore, secondStore] = await Promise.all([
      FalsePositiveStore.open(repositoryPath, {keyPath}),
      FalsePositiveStore.open(repositoryPath, {keyPath}),
    ]);
    const lockPath = path.join(
      repositoryPath,
      '.shadow-auditor',
      'memory',
      'false-positives.json.lock',
    );
    await fs.mkdir(lockPath);
    const staleTime = new Date(Date.now() - 61_000);
    await fs.utimes(lockPath, staleTime, staleTime);

    await Promise.all([
      firstStore.approve({
        cwe: 'CWE-22',
        locations: [{filePath: 'src/handler.ts', startLine: 1}],
        title: 'First recovery',
        vulnId: 'SHADOW-022-FIRST-RECOVERY',
      }, 'Reviewer', 'First recovery rationale.'),
      secondStore.approve({
        cwe: 'CWE-22',
        locations: [{filePath: 'src/handler.ts', startLine: 1}],
        title: 'Second recovery',
        vulnId: 'SHADOW-022-SECOND-RECOVERY',
      }, 'Reviewer', 'Second recovery rationale.'),
    ]);

    expect(await firstStore.list()).to.have.length(2);
  });

  it('treats malformed storage as inactive and read-only', async () => {
    const memoryPath = path.join(repositoryPath, '.shadow-auditor', 'memory');
    await fs.mkdir(memoryPath, {recursive: true});
    await fs.writeFile(path.join(memoryPath, 'false-positives.json'), '{broken');

    const store = await FalsePositiveStore.open(repositoryPath, {keyPath});
    expect(store.getStatus().storeError).to.be.a('string');
    expect(await store.match(candidate())).to.equal(null);
  });
});
