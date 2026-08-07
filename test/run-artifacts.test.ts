import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { RunArtifacts } from '../src/core/run-artifacts.js';
import { persistMessages } from '../src/core/services/message-persistence.js';

describe('RunArtifacts recovery', () => {
  let targetPath: string;

  beforeEach(async () => {
    targetPath = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-run-'));
  });

  afterEach(async () => {
    await fs.rm(targetPath, { force: true, recursive: true });
  });

  it('reopens an existing run without creating a new run directory', async () => {
    const created = await RunArtifacts.create(targetPath, {
      maxOutputTokens: 100,
      maxToolSteps: 10,
      mcpEnabled: false,
      model: 'test-model',
      provider: 'test-provider',
      targetPath,
      warnings: [],
    });
    const runId = path.basename(created.getRunDirectory());

    const reopened = await RunArtifacts.open(targetPath, runId);

    expect(reopened.getRunDirectory()).to.equal(created.getRunDirectory());
  });

  it('rejects run identifiers that could escape the target run directory', async () => {
    let error: unknown;
    try {
      await RunArtifacts.open(targetPath, '../outside');
    } catch (error_) {
      error = error_;
    }

    expect((error as Error).message).to.equal('Invalid run ID.');
  });

  it('persists every deterministic pipeline handoff under fixed filenames', async () => {
    const artifacts = await RunArtifacts.create(targetPath, {
      maxOutputTokens: 100,
      maxToolSteps: 10,
      mcpEnabled: false,
      model: 'test-model',
      provider: 'test-provider',
      targetPath,
      warnings: [],
    });
    await artifacts.writePipelineArtifacts({
      adversarialReport: '# Adversarial',
      codebaseReport: '# Codebase',
      finalReport: '# Final',
      repoMap: '# Repository map',
      sastReport: '# SAST',
      verdicts: [{findingId: 'CAND-001', verdict: 'CONFIRMED'}],
    });

    const pipelinePath = path.join(artifacts.getRunDirectory(), 'pipeline');
    expect((await fs.readdir(pipelinePath)).sort()).to.deep.equal([
      'adversarial-report.md',
      'codebase-report.md',
      'final-report.md',
      'repo-map.md',
      'sast-report.md',
      'verdicts.json',
    ]);
    expect(await fs.readFile(path.join(pipelinePath, 'final-report.md'), 'utf8'))
      .to.equal('# Final\n');
    expect(JSON.parse(await fs.readFile(path.join(pipelinePath, 'verdicts.json'), 'utf8')))
      .to.deep.equal([{findingId: 'CAND-001', verdict: 'CONFIRMED'}]);
  });

  it('preserves structured message content in the durable transcript', async () => {
    const artifacts = await RunArtifacts.create(targetPath, {
      maxOutputTokens: 100,
      maxToolSteps: 10,
      mcpEnabled: false,
      model: 'test-model',
      provider: 'test-provider',
      targetPath,
      warnings: [],
    });
    const content: Array<{text: string; type: 'text'}> = [
      {text: 'public answer', type: 'text'},
    ];

    await persistMessages(artifacts, [{
      content: structuredClone(content),
      role: 'assistant',
    }]);

    const record = JSON.parse(
      (await fs.readFile(path.join(artifacts.getRunDirectory(), 'messages.jsonl'), 'utf8')).trim(),
    ) as {content: unknown};
    expect(record.content).to.deep.equal(content);
  });

  it('rejects incompatible resume settings and tracks active/completed transitions', async () => {
    const artifacts = await RunArtifacts.create(targetPath, {
      maxOutputTokens: 100,
      maxToolSteps: 10,
      mcpEnabled: false,
      model: 'test-model',
      provider: 'test-provider',
      targetPath,
      warnings: [],
    });
    expect(() => artifacts.assertCompatible({
      model: 'different-model',
      provider: 'test-provider',
    })).to.throw('resume requires the same provider and model');

    await artifacts.markCompleted();
    await artifacts.markActive();
    const metadata = JSON.parse(
      await fs.readFile(path.join(artifacts.getRunDirectory(), 'session-meta.json'), 'utf8'),
    ) as {completedAt?: string};
    expect(metadata).not.to.have.property('completedAt');
  });
});
