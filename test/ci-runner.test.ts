import { expect } from 'chai';

import type { AgentSession } from '../src/core/agent.js';
import type { ShadowConfig } from '../src/utils/config.js';

import {
  type CiRunnerDependencies,
  runCiAudit,
} from '../src/core/ci-runner.js';

type GeneratedReport = NonNullable<Awaited<ReturnType<AgentSession['generateReport']>>>;

function dependencies(options?: {
  auditStatus?: { completed: boolean; evidenceActions: number; inspectedPaths: string[] };
  filesAnalyzed?: number;
  findings?: GeneratedReport['report']['findings'];
  onDispose?: () => void;
  onResume?: (answer?: boolean | string) => void;
  pendingInput?: Awaited<ReturnType<AgentSession['getPendingHumanInput']>>;
}): CiRunnerDependencies {
  const generated = {
    jsonPath: '/reports/report.json',
    markdownPath: '/reports/report.md',
    report: {
      findings: options?.findings ?? [],
      metadata: {
        coverage: { filesAnalyzed: options?.filesAnalyzed ?? 1 },
      },
    },
    sarifPath: '/reports/report.sarif',
  } as GeneratedReport;

  return {
    createSession: () => ({
      async dispose() { options?.onDispose?.(); },
      generateReport: async () => generated,
      getAuditStatus: () => options?.auditStatus ?? {
        completed: true,
        evidenceActions: 1,
        inspectedPaths: ['src/app.ts'],
      },
      getPendingHumanInput: async () => options?.pendingInput ?? null,
      async resumeFromCheckpoint() {
        options?.onResume?.();
        return 'resumed';
      },
      async resumeWithHumanInput(answer) {
        options?.onResume?.(answer);
        return 'resumed';
      },
      sendMessage: async () => 'done',
      async waitForReady() {},
    }),
    enforceLicenseGate: async () => ({ allowed: true }),
    generateRepoMap: async () => 'repository map',
    getChangedFiles: async () => ({
      baseRef: 'main',
      files: [],
      headRef: 'HEAD',
      resolvedRef: 'main',
      usedFallback: false,
    }),
  };
}

describe('CI runner', () => {
  const config = {} as ShadowConfig;

  it('runs headlessly, generates artifacts, and computes a passing exit', async () => {
    let disposed = false;
    const result = await runCiAudit({
      config,
      failOn: 'high',
      targetPath: '.',
    }, dependencies({ onDispose() { disposed = true; } }));

    expect(result.exit.code).to.equal(0);
    expect(result.summary).to.deep.equal({ filesAnalyzed: 1, findings: 0 });
    expect(result.sarifPath).to.equal('/reports/report.sarif');
    expect(disposed).to.equal(true);
  });

  it('returns a finding-threshold failure for high-severity findings', async () => {
    const result = await runCiAudit({
      config,
      failOn: 'high',
      targetPath: '.',
    }, dependencies({
      findings: [{
        locations: [{ filePath: 'src/app.ts' }],
        severityLabel: 'High',
        title: 'Path traversal',
        vulnId: 'SHADOW-1',
      }] as GeneratedReport['report']['findings'],
    }));

    expect(result.exit.code).to.equal(1);
    expect(result.summary.findings).to.equal(1);
  });

  it('always disposes the session when execution fails', async () => {
    let disposed = false;
    const deps = dependencies({ onDispose() { disposed = true; } });
    const createSession = deps.createSession;
    deps.createSession = (...args) => ({
      ...createSession(...args),
      async sendMessage() { throw new Error('provider unavailable'); },
    });

    try {
      await runCiAudit({ config, failOn: 'high', targetPath: '.' }, deps);
      expect.fail('Expected CI audit to reject.');
    } catch (error) {
      expect((error as Error).message).to.equal('provider unavailable');
    }

    expect(disposed).to.equal(true);
  });

  it('preserves the original error when session.dispose() also fails', async () => {
    // #23 regression: dispose() running in `finally` must not mask the primary
    // error. Before the fix, a throwing dispose replaced the real failure.
    const deps = dependencies();
    const createSession = deps.createSession;
    deps.createSession = (...args) => ({
      ...createSession(...args),
      async sendMessage() { throw new Error('provider unavailable'); },
      async dispose() { throw new Error('dispose exploded'); },
    });

    let error: unknown;
    try {
      await runCiAudit({ config, failOn: 'high', targetPath: '.' }, deps);
      expect.fail('Expected CI audit to reject.');
    } catch (error_) {
      error = error_;
    }

    // The original error wins; the dispose failure must not override it.
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.equal('provider unavailable');
  });

  it('still returns the run result even when session.dispose() fails on success', async () => {
    const deps = dependencies();
    const createSession = deps.createSession;
    deps.createSession = (...args) => ({
      ...createSession(...args),
      async dispose() { throw new Error('dispose exploded'); },
    });

    const result = await runCiAudit({ config, failOn: 'high', targetPath: '.' }, deps);
    expect(result.exit.code).to.equal(0);
  });

  it('rejects an incomplete audit that produces no structured report', async () => {
    const deps = dependencies();
    const createSession = deps.createSession;
    deps.createSession = (...args) => ({
      ...createSession(...args),
      generateReport: async () => null,
    });

    let error: unknown;
    try {
      await runCiAudit({ config, failOn: 'high', targetPath: '.' }, deps);
    } catch (error_) {
      error = error_;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.include('without an initialized report pipeline');
  });

  it('returns a tool-error exit when the model answers without inspection or terminal completion', async () => {
    const result = await runCiAudit({
      config,
      failOn: 'high',
      targetPath: '.',
    }, dependencies({
      auditStatus: { completed: false, evidenceActions: 0, inspectedPaths: [] },
    }));

    expect(result.exit.code).to.equal(2);
    expect(result.summary.filesAnalyzed).to.equal(0);
  });

  it('returns a tool-error exit for findings produced by an incomplete audit', async () => {
    const result = await runCiAudit({
      config,
      failOn: 'high',
      targetPath: '.',
    }, dependencies({
      auditStatus: { completed: false, evidenceActions: 1, inspectedPaths: ['src/app.ts'] },
      findings: [{
        locations: [{ filePath: 'src/app.ts' }],
        severityLabel: 'High',
        title: 'Unverified finding',
        vulnId: 'SHADOW-INCOMPLETE',
      }] as GeneratedReport['report']['findings'],
    }));

    expect(result.exit.code).to.equal(2);
  });

  it('continues an interrupted checkpoint instead of starting a new audit', async () => {
    let resumed = false;
    await runCiAudit({
      config,
      failOn: 'high',
      resumeRunId: 'run-123',
      targetPath: '.',
    }, dependencies({
      onResume() { resumed = true; },
    }));

    expect(resumed).to.equal(true);
  });

  it('restores and answers a paused confirmation checkpoint', async () => {
    let resumedAnswer: boolean | string | undefined;
    await runCiAudit({
      config,
      failOn: 'high',
      prompt: 'yes',
      resumeRunId: 'run-123',
      targetPath: '.',
    }, dependencies({
      onResume(answer) { resumedAnswer = answer; },
      pendingInput: {
        question: 'Allow this command?',
        requestId: 'request-123',
        type: 'confirmation',
      },
    }));

    expect(resumedAnswer).to.equal(true);
  });

  it('requires an explicit answer for a paused CI checkpoint', async () => {
    let error: unknown;
    try {
      await runCiAudit({
        config,
        failOn: 'high',
        resumeRunId: 'run-123',
        targetPath: '.',
      }, dependencies({
        pendingInput: {
          question: 'Allow this command?',
          requestId: 'request-123',
          type: 'confirmation',
        },
      }));
    } catch (error_) {
      error = error_;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.include('Provide the response with --prompt');
  });
});
