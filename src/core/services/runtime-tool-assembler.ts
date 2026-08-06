import type { ToolSet } from 'ai';

import * as path from 'node:path';

import type { ShadowConfig } from '../../utils/config.js';
import type { PatchReviewDecision, PatchReviewRequest } from '../remediation/types.js';

import { SignedExecutionEvidenceStore } from '../dast/evidence-store.js';
import { SandboxManager } from '../dast/sandbox-manager.js';
import { createSandboxTools } from '../dast/sandbox-tools.js';
import { RemediationLoop } from '../remediation/remediation-loop.js';
import { createRemediationTools } from '../remediation/remediation-tools.js';
import { TestRunner } from '../remediation/test-runner.js';

export interface RuntimeToolAssembly {
  cleanup(): Promise<void>;
  evidenceStore?: SignedExecutionEvidenceStore;
  tools: ToolSet;
}

export interface RuntimeToolAssemblerDependencies {
  createRemediationToolSet: typeof createRemediationTools;
  createSandboxManager: (options: ConstructorParameters<typeof SandboxManager>[0]) => SandboxManager;
  createSandboxToolSet: typeof createSandboxTools;
  detectTestRunner: typeof TestRunner.detect;
}

const defaultDependencies: RuntimeToolAssemblerDependencies = {
  createRemediationToolSet: createRemediationTools,
  createSandboxManager: (options) => new SandboxManager(options),
  createSandboxToolSet: createSandboxTools,
  detectTestRunner: TestRunner.detect,
};

export interface RuntimeToolAssemblerOptions {
  config: ShadowConfig;
  confirmPatch?: (request: PatchReviewRequest) => Promise<PatchReviewDecision>;
  dependencies?: RuntimeToolAssemblerDependencies;
  runId: string;
  targetPath: string;
}

export async function assembleRuntimeTools(options: RuntimeToolAssemblerOptions): Promise<RuntimeToolAssembly> {
  const {
    config,
    confirmPatch,
    dependencies = defaultDependencies,
    runId,
    targetPath,
  } = options;
  const tools: ToolSet = {};
  let evidenceStore: SignedExecutionEvidenceStore | undefined;
  let sandboxManager: null | SandboxManager = null;

  if (config.dast?.enabled) {
    evidenceStore = await SignedExecutionEvidenceStore.create(
      path.join(targetPath, '.shadow-auditor', 'runs', runId),
      runId,
    );
    sandboxManager = dependencies.createSandboxManager({
      baseImage: config.dast.baseImage,
      cpuLimit: config.dast.cpuLimit,
      healthCheckUrl: config.dast.healthCheckUrl,
      memoryLimit: config.dast.memoryLimit,
      runId,
      startCommand: config.dast.startCommand,
      targetPath,
    });
    Object.assign(tools, dependencies.createSandboxToolSet({
      evidenceStore,
      sandboxManager,
    }));
  }

  if (config.remediation?.enabled) {
    const testRunner = await dependencies.detectTestRunner({
      containerImage: config.remediation.containerImage,
      projectRoot: targetPath,
      testCommand: config.remediation.testCommand,
      timeoutMs: config.remediation.testTimeoutMs,
    });
    await testRunner.captureBaseline();

    const remediationLoop = new RemediationLoop({
      artifactDirectory: path.join(targetPath, '.shadow-auditor', 'runs', runId, 'remediation'),
      autoRevert: config.remediation.autoRevert,
      projectRoot: targetPath,
      testRunner,
    });
    Object.assign(tools, dependencies.createRemediationToolSet({
      confirmPatch,
      projectRoot: targetPath,
      remediationLoop,
      testRunner,
    }));
  }

  return {
    async cleanup() {
      await sandboxManager?.destroy();
    },
    evidenceStore,
    tools,
  };
}
