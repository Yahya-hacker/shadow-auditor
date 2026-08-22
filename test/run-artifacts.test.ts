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

  it('reads back the full transcript oldest first, skipping malformed lines', async () => {
    const artifacts = await RunArtifacts.create(targetPath, {
      maxOutputTokens: 100,
      maxToolSteps: 10,
      mcpEnabled: false,
      model: 'test-model',
      provider: 'test-provider',
      targetPath,
      warnings: [],
    });
    await persistMessages(artifacts, [
      {content: 'first user turn', role: 'user'},
      {content: [{text: 'first answer', type: 'text'}], role: 'assistant'},
    ]);
    // A crash left a truncated trailing line; readMessages must skip it.
    await fs.appendFile(
      path.join(artifacts.getRunDirectory(), 'messages.jsonl'),
      '{"role":"user","content":"partial',
      'utf8',
    );

    const history = await artifacts.readMessages();
    expect(history.map((event) => event.role)).to.deep.equal(['user', 'assistant']);
    expect(history[0]!.content).to.equal('first user turn');
    expect(history[1]!.content).to.deep.equal([{text: 'first answer', type: 'text'}]);
  });

  it('returns an empty transcript when no messages were recorded', async () => {
    const artifacts = await RunArtifacts.create(targetPath, {
      maxOutputTokens: 100,
      maxToolSteps: 10,
      mcpEnabled: false,
      model: 'test-model',
      provider: 'test-provider',
      targetPath,
      warnings: [],
    });
    expect(await artifacts.readMessages()).to.deep.equal([]);
  });

    it('heals a truncated trailing JSONL line before appending the next record', async () => {
      const artifacts = await RunArtifacts.create(targetPath, {
        maxOutputTokens: 100,
        maxToolSteps: 10,
        mcpEnabled: false,
        model: 'test-model',
        provider: 'test-provider',
        targetPath,
        warnings: [],
      });
      const messagesPath = path.join(artifacts.getRunDirectory(), 'messages.jsonl');
      // A crash left the final append half-written with no terminator.
      await fs.appendFile(messagesPath, '{"role":"user","content":"partial', 'utf8');

      await persistMessages(artifacts, [{
        content: [{text: 'after', type: 'text'}],
        role: 'assistant',
      }]);

      const lines = (await fs.readFile(messagesPath, 'utf8')).trim().split('\n')
        .filter((line) => line.length > 0);
      expect(lines).to.have.length(1);
      const record = JSON.parse(lines[0]!) as {content: unknown};
      expect(record.content).to.deep.equal([{text: 'after', type: 'text'}]);
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

  it('lists runs most recent first and skips malformed metadata', async () => {
    const first = await RunArtifacts.create(targetPath, {
      maxOutputTokens: 100,
      maxToolSteps: 10,
      mcpEnabled: false,
      model: 'test-model',
      provider: 'test-provider',
      targetPath,
      warnings: [],
    });
    const firstRunId = path.basename(first.getRunDirectory());

    const second = await RunArtifacts.create(targetPath, {
      maxOutputTokens: 100,
      maxToolSteps: 10,
      mcpEnabled: false,
      model: 'test-model',
      provider: 'test-provider',
      targetPath,
      warnings: [],
    });
    const secondRunId = path.basename(second.getRunDirectory());
    const secondMetaPath = path.join(second.getRunDirectory(), 'session-meta.json');
    const secondMeta = JSON.parse(await fs.readFile(secondMetaPath, 'utf8')) as {startedAt: string};
    secondMeta.startedAt = '2099-01-01T00:00:00.000Z';
    await fs.writeFile(secondMetaPath, JSON.stringify(secondMeta) + '\n');

    await fs.mkdir(path.join(targetPath, '.shadow-auditor', 'runs', 'broken-run'));

    const runs = await RunArtifacts.listRuns(targetPath);
    expect(runs.map((run) => run.runId)).to.deep.equal([secondRunId, firstRunId]);
  });

  it('returns an empty list when no runs exist', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-empty-'));
    try {
      expect(await RunArtifacts.listRuns(empty)).to.deep.equal([]);
    } finally {
      await fs.rm(empty, { force: true, recursive: true });
    }
  });

  it('finds the most recent run ID synchronously', async () => {
    const first = await RunArtifacts.create(targetPath, {
      maxOutputTokens: 100,
      maxToolSteps: 10,
      mcpEnabled: false,
      model: 'test-model',
      provider: 'test-provider',
      targetPath,
      warnings: [],
    });
    const firstRunId = path.basename(first.getRunDirectory());

    const second = await RunArtifacts.create(targetPath, {
      maxOutputTokens: 100,
      maxToolSteps: 10,
      mcpEnabled: false,
      model: 'test-model',
      provider: 'test-provider',
      targetPath,
      warnings: [],
    });
    const secondRunId = path.basename(second.getRunDirectory());
    const secondMetaPath = path.join(second.getRunDirectory(), 'session-meta.json');
    const secondMeta = JSON.parse(await fs.readFile(secondMetaPath, 'utf8')) as {startedAt: string};
    secondMeta.startedAt = '2099-01-01T00:00:00.000Z';
    await fs.writeFile(secondMetaPath, JSON.stringify(secondMeta) + '\n');

    expect(RunArtifacts.findMostRecentRunIdSync(targetPath)).to.equal(secondRunId);
    expect(RunArtifacts.findMostRecentRunIdSync(targetPath)).not.to.equal(firstRunId);
  });

  it('returns null synchronously when no runs exist', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-empty-'));
    try {
      expect(RunArtifacts.findMostRecentRunIdSync(empty)).to.equal(null);
    } finally {
      await fs.rm(empty, { force: true, recursive: true });
    }
  });
});
