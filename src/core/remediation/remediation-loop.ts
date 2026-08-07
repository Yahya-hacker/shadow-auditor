/**
 * Remediation Loop - Automated patch → test → verify → revert cycle.
 *
 * Orchestrates the full remediation workflow:
 * 1. Create a git stash restore point
 * 2. Apply the patch via `git apply`
 * 3. Run tests inside a twin container
 * 4. If fingerprint degraded → auto-revert
 * 5. If no degradation → keep patch
 *
 * The patch-engineer agent NEVER touches the host filesystem directly
 * for test execution — everything runs inside disposable Docker containers.
 */

import { exec } from 'node:child_process';

import { type TestResult, type TestRunner } from './test-runner.js';

// =============================================================================
// Types
// =============================================================================

export interface RemediationResult {
  appliedPatch: string;
  baselineComparison?: {
    newFailures: string[];
    resolvedFailures: string[];
  };
  findingId: string;
  reverted: boolean;
  status: 'applied' | 'reverted' | 'skipped';
  testResult?: TestResult;
}

export interface RemediationLoopOptions {
  autoRevert?: boolean;
  projectRoot: string;
  testRunner: TestRunner;
}

// =============================================================================
// Git Helpers
// =============================================================================

function gitExec(
  command: string,
  cwd: string,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, maxBuffer: 5 * 1024 * 1024, timeout: 30_000 },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error?.code ?? (error ? 1 : 0),
          stderr: typeof stderr === 'string' ? stderr : '',
          stdout: typeof stdout === 'string' ? stdout : '',
        });
      },
    );
  });
}

// =============================================================================
// Remediation Loop
// =============================================================================

export class RemediationLoop {
  private readonly autoRevert: boolean;
  private readonly projectRoot: string;
  private readonly testRunner: TestRunner;

  constructor(options: RemediationLoopOptions) {
    this.projectRoot = options.projectRoot;
    this.testRunner = options.testRunner;
    this.autoRevert = options.autoRevert ?? true;
  }

  /**
   * Apply a patch using `git apply`.
   * Performs a dry-run first to validate the patch.
   */
  async applyPatch(diff: string): Promise<void> {
    // Dry run
    const dryRun = await gitExec(
      `echo ${this.shellEscape(diff)} | git apply --check -`,
      this.projectRoot,
    );

    if (dryRun.exitCode !== 0) {
      throw new Error(`Patch dry-run failed: ${dryRun.stderr}`);
    }

    // Apply for real
    const apply = await gitExec(
      `echo ${this.shellEscape(diff)} | git apply -`,
      this.projectRoot,
    );

    if (apply.exitCode !== 0) {
      throw new Error(`git apply failed: ${apply.stderr}`);
    }
  }

  /**
   * Create a git stash restore point.
   * Returns the stash reference (e.g., "stash@{0}").
   */
  async createRestorePoint(findingId: string): Promise<string> {
    const stashMessage = `shadow-auditor-pre-patch-${findingId}`;

    // Check for changes first
    const status = await gitExec('git status --porcelain', this.projectRoot);
    if (status.stdout.trim() === '') {
      // Nothing to stash — working tree is clean
      return '';
    }

    const result = await gitExec(
      `git stash push -m "${stashMessage}"`,
      this.projectRoot,
    );

    if (result.exitCode !== 0) {
      throw new Error(`git stash failed: ${result.stderr}`);
    }

    return 'stash@{0}';
  }

  /**
   * Execute the full remediation cycle for a finding.
   */
  async execute(findingId: string, patchDiff: string): Promise<RemediationResult> {
    // 1. Create restore point
    let stashRef: string;
    try {
      stashRef = await this.createRestorePoint(findingId);
    } catch {
      return {
        appliedPatch: patchDiff,
        findingId,
        reverted: false,
        status: 'skipped',
      };
    }

    // 2. Apply patch
    try {
      await this.applyPatch(patchDiff);
    } catch {
      // Revert if stash was created
      if (stashRef) {
        await this.revertToRestorePoint(stashRef).catch(() => {});
      }

      return {
        appliedPatch: patchDiff,
        findingId,
        reverted: Boolean(stashRef),
        status: 'skipped',
      };
    }

    // 3. Run tests
    const testResult = await this.runTests();

    // 4. Evaluate
    if (testResult.degraded && this.autoRevert) {
      // Revert: tests degraded
      if (stashRef) {
        await this.revertToRestorePoint(stashRef).catch(() => {});
      }

      return {
        appliedPatch: patchDiff,
        baselineComparison: {
          newFailures: testResult.newFailures,
          resolvedFailures: testResult.resolvedFailures,
        },
        findingId,
        reverted: true,
        status: 'reverted',
        testResult,
      };
    }

    // Success: patch kept
    return {
      appliedPatch: patchDiff,
      baselineComparison: {
        newFailures: testResult.newFailures,
        resolvedFailures: testResult.resolvedFailures,
      },
      findingId,
      reverted: false,
      status: 'applied',
      testResult,
    };
  }

  /**
   * Revert to a restore point by popping the stash.
   */
  async revertToRestorePoint(stashRef: string): Promise<void> {
    if (!stashRef) return;

    // Reset working tree first to avoid conflicts
    await gitExec('git checkout -- .', this.projectRoot);

    const result = await gitExec(`git stash pop ${stashRef}`, this.projectRoot);
    if (result.exitCode !== 0) {
      throw new Error(`git stash pop failed: ${result.stderr}`);
    }
  }

  /**
   * Run tests via the TestRunner (twin-container execution).
   */
  async runTests(): Promise<TestResult> {
    return this.testRunner.run();
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  private shellEscape(str: string): string {
    return `'${str.replaceAll("'", String.raw`'\''`)}'`;
  }
}
