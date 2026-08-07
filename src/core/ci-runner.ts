import * as path from 'node:path';

import type { ShadowConfig } from '../utils/config.js';
import type { HumanInputRequest } from './graph/state.js';

import { generateRepoMap } from '../utils/repo-map.js';
import { AgentSession } from './agent.js';
import { type CiExitResult, computeCiExitCode, type FailOnSeverity } from './output/ci-exit.js';
import { enforceLicenseGate } from './policy/license-guard.js';
import { buildDiffScopeHint, getChangedFiles } from './tools/git-diff.js';

export interface CiRunOptions {
  config: ShadowConfig;
  diffBase?: string;
  diffEnabled?: boolean;
  expertUnsafe?: boolean;
  failOn: FailOnSeverity;
  prompt?: string;
  resumeRunId?: string;
  targetPath: string;
}

export interface CiRunResult {
  exit: CiExitResult;
  jsonPath?: string;
  markdownPath?: string;
  sarifPath?: string;
  summary: {
    filesAnalyzed: number;
    findings: number;
  };
}

export interface CiRunnerDependencies {
  createSession: (
    config: ShadowConfig,
    repoMap: string,
    targetPath: string,
    options: ConstructorParameters<typeof AgentSession>[3],
  ) => Pick<
    AgentSession,
    'dispose' | 'generateReport' | 'getAuditStatus' | 'getPendingHumanInput' |
    'resumeFromCheckpoint' | 'resumeWithHumanInput' | 'sendMessage' | 'waitForReady'
  >;
  enforceLicenseGate: typeof enforceLicenseGate;
  generateRepoMap: typeof generateRepoMap;
  getChangedFiles: typeof getChangedFiles;
}

const defaultDependencies: CiRunnerDependencies = {
  createSession: (config, repoMap, targetPath, options) =>
    new AgentSession(config, repoMap, targetPath, options),
  enforceLicenseGate,
  generateRepoMap,
  getChangedFiles,
};

function parseResumeAnswer(request: HumanInputRequest, answer: string | undefined): boolean | string {
  if (!answer?.trim()) {
    throw new Error(
      `Run is paused awaiting human input: ${request.question} ` +
      'Provide the response with --prompt when using --resume-run.',
    );
  }

  if (request.type !== 'confirmation') return answer.trim();

  const normalized = answer.trim().toLowerCase();
  if (['approve', 'approved', 'true', 'y', 'yes'].includes(normalized)) return true;
  if (['denied', 'deny', 'false', 'n', 'no'].includes(normalized)) return false;
  throw new Error('A paused confirmation requires --prompt yes or --prompt no.');
}

export async function runCiAudit(
  options: CiRunOptions,
  dependencies: CiRunnerDependencies = defaultDependencies,
): Promise<CiRunResult> {
  const targetPath = path.resolve(options.targetPath);
  const gate = await dependencies.enforceLicenseGate(options.config);
  if (!gate.allowed) {
    throw new Error(`${gate.feature ?? 'Requested CI feature'} requires a ${gate.requiredTier ?? 'pro'} license.`);
  }

  const [repoMap, changedFiles] = await Promise.all([
    dependencies.generateRepoMap(targetPath),
    options.diffEnabled
      ? dependencies.getChangedFiles({ baseRef: options.diffBase ?? 'HEAD~1', cwd: targetPath })
      : Promise.resolve(null),
  ]);
  const session = dependencies.createSession(options.config, repoMap, targetPath, {
    diffScopeHint: changedFiles ? buildDiffScopeHint(changedFiles) : undefined,
    expertUnsafe: options.expertUnsafe,
    resumeRunId: options.resumeRunId,
  });

  try {
    await session.waitForReady();
    if (options.resumeRunId) {
      const pendingInput = await session.getPendingHumanInput();
      if (pendingInput) {
        await session.resumeWithHumanInput(
          parseResumeAnswer(pendingInput, options.prompt),
          () => {},
        );
      } else {
        await session.resumeFromCheckpoint(() => {});
      }
    } else {
      await session.sendMessage(
        options.prompt ?? 'Perform an autonomous security audit of this target. Verify every finding and report it with report_finding before completing.',
        () => {},
      );
    }

    const auditStatus = session.getAuditStatus();
    const generated = await session.generateReport();
    if (!generated) {
      throw new Error('Audit completed without an initialized report pipeline.');
    }

    const filesAnalyzed = auditStatus.inspectedPaths.length;
    const findings = generated.report.findings.map((finding) => ({
      cvss_v31_score: finding.cvssV31Score,
      cvss_v31_vector: finding.cvssV31Vector,
      cvss_v40_score: finding.cvssV40Score,
      cwe: finding.cwe,
      file_paths: finding.locations.map((location) => location.filePath),
      severity_label: finding.severityLabel,
      title: finding.title,
      vuln_id: finding.vulnId,
    }));
    const exit = computeCiExitCode({
      auditCompleted: auditStatus.completed,
      evidenceActions: auditStatus.evidenceActions,
      failOn: options.failOn,
      filesAnalyzed,
      findings,
    });

    return {
      exit,
      jsonPath: generated.jsonPath,
      markdownPath: generated.markdownPath,
      sarifPath: generated.sarifPath,
      summary: {
        filesAnalyzed,
        findings: findings.length,
      },
    };
  } finally {
    await session.dispose();
  }
}
