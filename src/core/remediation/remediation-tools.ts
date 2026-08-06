/**
 * Remediation Tools - Agent-facing tools for the patch-engineer worker.
 *
 * These tools wrap the TestRunner and RemediationLoop for swarm agent use.
 * The patch-engineer uses these to apply patches, run tests inside
 * twin containers, and auto-revert on degradation.
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import type { PatchReviewDecision, PatchReviewRequest } from './types.js';

import { RemediationLoop } from './remediation-loop.js';
import { type TestRunner } from './test-runner.js';

// =============================================================================
// Tool Factory
// =============================================================================

export interface RemediationToolsOptions {
  confirmPatch?: (request: PatchReviewRequest) => Promise<PatchReviewDecision>;
  projectRoot: string;
  remediationLoop: RemediationLoop;
  testRunner: TestRunner;
}

/**
 * Create agent-facing remediation tools for the patch-engineer role.
 */
export function createRemediationTools(options: RemediationToolsOptions): ToolSet {
  const { confirmPatch, remediationLoop, testRunner } = options;

  return {
    apply_and_test_patch: tool({
      description: [
        'Apply a unified diff patch to fix a security finding, then run the test suite',
        'inside an isolated twin container. If the patch introduces new test failures',
        '(compared to the pre-mission baseline), the patch is automatically reverted.',
        'Returns a JSON result with status, test output, and baseline comparison.',
      ].join(' '),

      async execute({ diff, findingId }, executionOptions) {
        try {
          const validation = await remediationLoop.validatePatch(
            findingId,
            diff,
            executionOptions.abortSignal,
          );
          if (validation.testResult.degraded || !validation.testResult.passed) {
            await remediationLoop.recordDecision({
              action: 'rejected_by_validation',
              findingId,
              patchHash: validation.patchHash,
              testResult: summarizeTestResult(validation.testResult),
              timestamp: new Date().toISOString(),
            });
            return JSON.stringify({
              findingId,
              status: 'rejected_by_validation',
              testNewFailures: validation.testResult.newFailures,
              testPassed: validation.testResult.passed,
              testStderr: validation.testResult.stderr.slice(0, 2000),
              testStdout: validation.testResult.stdout.slice(0, 4000),
            }, null, 2);
          }

          const decision = confirmPatch
            ? await confirmPatch({ diff, findingId, testResult: validation.testResult })
            : { action: 'reject' as const };

          if (decision.action === 'revise') {
            remediationLoop.discardValidation(validation.token);
            await remediationLoop.recordDecision({
              action: decision.action,
              findingId,
              instructions: decision.instructions,
              patchHash: validation.patchHash,
              testResult: summarizeTestResult(validation.testResult),
              timestamp: new Date().toISOString(),
            });

            return JSON.stringify({
              findingId,
              revisionInstructions: decision.instructions,
              status: 'revision_requested',
            }, null, 2);
          }

          if (decision.action === 'reject') {
            remediationLoop.discardValidation(validation.token);
            await remediationLoop.recordDecision({
              action: decision.action,
              findingId,
              patchHash: validation.patchHash,
              testResult: summarizeTestResult(validation.testResult),
              timestamp: new Date().toISOString(),
            });

            return JSON.stringify({ findingId, status: 'rejected_by_user' }, null, 2);
          }

          await remediationLoop.applyValidatedPatch(
            validation.token,
            diff,
            executionOptions.abortSignal,
          );
          await remediationLoop.recordDecision({
            action: 'apply',
            findingId,
            patchHash: validation.patchHash,
            testResult: summarizeTestResult(validation.testResult),
            timestamp: new Date().toISOString(),
          });

          return JSON.stringify({
            findingId,
            status: 'applied',
            testExitCode: validation.testResult.exitCode,
            testNewFailures: validation.testResult.newFailures,
            testPassed: validation.testResult.passed,
          }, null, 2);
        } catch (error) {
          executionOptions.abortSignal?.throwIfAborted();
          return `[ERROR] Remediation failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      },

      inputSchema: z.object({
        diff: z.string().min(1).describe('Unified diff patch content to apply'),
        findingId: z.string().min(1).describe('The finding ID this patch addresses'),
      }),
    }),

    detect_test_framework: tool({
      description: [
        'Detect the project\'s test framework and return the detected framework name,',
        'test command, and container image. Use this before applying patches to',
        'understand the test environment.',
      ].join(' '),

      async execute() {
        const framework = testRunner.getFramework();
        const baseline = testRunner.getBaseline();

        return JSON.stringify({
          baselineCaptured: Boolean(baseline),
          baselineFailCount: baseline?.entries.filter((e) => e.status === 'fail').length ?? null,
          baselineHash: baseline?.hash ?? null,
          baselinePassCount: baseline?.entries.filter((e) => e.status === 'pass').length ?? null,
          command: framework.command,
          containerImage: framework.image ?? 'unknown',
          framework: framework.name,
        }, null, 2);
      },

      inputSchema: z.object({}),
    }),

    get_baseline_status: tool({
      description: [
        'Get the pre-mission test baseline status. Shows which tests were already passing',
        'and which were already failing BEFORE any patches were applied. A patch is valid',
        'if it introduces zero new failures compared to this baseline.',
      ].join(' '),

      async execute() {
        const baseline = testRunner.getBaseline();

        if (!baseline) {
          return JSON.stringify({
            message: 'No baseline captured. Tests will be evaluated by exit code only.',
            status: 'no_baseline',
          }, null, 2);
        }

        const passing = baseline.entries.filter((e) => e.status === 'pass');
        const failing = baseline.entries.filter((e) => e.status === 'fail');
        const skipped = baseline.entries.filter((e) => e.status === 'skip');

        return JSON.stringify({
          capturedAt: baseline.timestamp,
          failCount: failing.length,
          failingTests: failing.map((e) => e.testName),
          framework: baseline.framework,
          hash: baseline.hash,
          passCount: passing.length,
          skipCount: skipped.length,
          status: 'baseline_available',
          totalTests: baseline.entries.length,
        }, null, 2);
      },

      inputSchema: z.object({}),
    }),
  };
}

function summarizeTestResult(result: Awaited<ReturnType<TestRunner['run']>>) {
  return {
    command: result.command,
    degraded: result.degraded,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    newFailures: result.newFailures,
    passed: result.passed,
    resolvedFailures: result.resolvedFailures,
  };
}
