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

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { writeFileAtomic } from '../../utils/fs-atomic.js';
import { type TestResult, type TestRunner } from './test-runner.js';

const GIT_OPERATION_TIMEOUT_MS = 30_000;

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
  artifactDirectory?: string;
  autoRevert?: boolean;
  projectRoot: string;
  testRunner: TestRunner;
}

export interface PatchValidation {
  findingId: string;
  patchHash: string;
  sourceFingerprint: string;
  testResult: TestResult;
  token: string;
}

// =============================================================================
// Git Helpers
// =============================================================================

function gitExec(
  args: string[],
  cwd: string,
  stdinData?: string,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // Apply patches byte-for-byte so Windows `core.autocrlf=true` (the default)
    // cannot rewrite LF working-tree bytes into CRLF and corrupt remediated files.
    const child = spawn('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], {
      cwd,
      signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const finish = (result: { exitCode: number; stderr: string; stdout: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish({
        exitCode: 1,
        stderr: `${stderr}\nGit operation timed out after ${GIT_OPERATION_TIMEOUT_MS}ms.`.trim(),
        stdout,
      });
    }, GIT_OPERATION_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    if (stdinData !== undefined) {
      child.stdin.write(stdinData);
      child.stdin.end();
    }

    child.on('error', () => {
      if (signal?.aborted) {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(signal.reason ?? new Error('Git operation aborted.'));
        }
      } else {
        finish({ exitCode: 1, stderr, stdout });
      }
    });

    child.on('close', (code) => {
      finish({ exitCode: code ?? 1, stderr, stdout });
    });
  });
}

// =============================================================================
// Remediation Loop
// =============================================================================

export class RemediationLoop {
  private readonly artifactDirectory?: string;
  private readonly autoRevert: boolean;
  private readonly projectRoot: string;
  private readonly testRunner: TestRunner;
  private readonly validations = new Map<string, PatchValidation>();

  constructor(options: RemediationLoopOptions) {
    this.projectRoot = options.projectRoot;
    this.testRunner = options.testRunner;
    this.autoRevert = options.autoRevert ?? true;
    this.artifactDirectory = options.artifactDirectory;
  }

  /**
   * Apply a patch using `git apply`.
   * Performs a dry-run first to validate the patch.
   */
  async applyPatch(diff: string, signal?: AbortSignal): Promise<void> {
    await this.fingerprintPaths(this.parseTouchedPaths(diff));
    // Dry run
    const dryRun = await gitExec(
      ['apply', '--check', '-'],
      this.projectRoot,
      diff,
      signal,
    );

    if (dryRun.exitCode !== 0) {
      throw new Error(`Patch dry-run failed: ${dryRun.stderr}`);
    }

    // Apply for real
    const apply = await gitExec(
      ['apply', '--whitespace=nowarn', '-'],
      this.projectRoot,
      diff,
      signal,
    );

    if (apply.exitCode !== 0) {
      throw new Error(`git apply failed: ${apply.stderr}`);
    }
  }

  /**
   * Apply a previously validated patch exactly once. Any affected-file change
   * after validation invalidates the token, even when git could still merge it.
   */
  async applyValidatedPatch(
    validationToken: string,
    patchDiff: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const validation = this.validations.get(validationToken);
    this.validations.delete(validationToken);
    if (!validation) throw new Error('Patch validation token is missing, expired, or already used.');
    if (validation.testResult.degraded || !validation.testResult.passed) {
      throw new Error('A patch that degraded project validation cannot be applied.');
    }

    if (hashText(patchDiff) !== validation.patchHash) {
      throw new Error('Patch content changed after validation.');
    }

    const currentFingerprint = await this.fingerprintPaths(this.parseTouchedPaths(patchDiff));
    if (currentFingerprint !== validation.sourceFingerprint) {
      throw new Error('An affected source file changed after validation; generate and validate a new patch.');
    }

    await this.applyPatch(patchDiff, signal);
  }

  discardValidation(validationToken: string): void {
    this.validations.delete(validationToken);
  }

  /**
   * Execute the full remediation cycle for a finding.
   */
  async execute(findingId: string, patchDiff: string, signal?: AbortSignal): Promise<RemediationResult> {
    // Apply directly to the current tree. Stashing would temporarily remove
    // user-owned changes and can lose them on a successful remediation.
    try {
      await this.applyPatch(patchDiff, signal);
    } catch {
      signal?.throwIfAborted();

      return {
        appliedPatch: patchDiff,
        findingId,
        reverted: false,
        status: 'skipped',
      };
    }

    let testResult: TestResult;
    try {
      testResult = await this.runTests(signal);
    } catch (error) {
      try {
        await this.revertPatch(patchDiff);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Test execution failed and the remediation patch could not be reverted.',
        );
      }

      signal?.throwIfAborted();
      throw error;
    }

    if (testResult.degraded && this.autoRevert) {
      await this.revertPatch(patchDiff);

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

  async recordDecision(record: Record<string, unknown>): Promise<void> {
    if (!this.artifactDirectory) return;
    await fs.mkdir(this.artifactDirectory, { recursive: true });
    const findingId = String(record.findingId ?? 'unknown').replaceAll(/[^a-zA-Z0-9_.-]/g, '_');
    const filePath = path.join(
      this.artifactDirectory,
      `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${findingId}.json`,
    );
    await writeFileAtomic(filePath, `${JSON.stringify(record, null, 2)}\n`);
  }

  async revertPatch(diff: string): Promise<void> {
    const check = await gitExec(['apply', '--reverse', '--check', '-'], this.projectRoot, diff);
    if (check.exitCode !== 0) {
      throw new Error(`Patch rollback check failed: ${check.stderr}`);
    }

    const result = await gitExec(['apply', '--reverse', '-'], this.projectRoot, diff);
    if (result.exitCode !== 0) {
      throw new Error(`Patch rollback failed: ${result.stderr}`);
    }
  }

  /**
   * Run tests via the TestRunner (twin-container execution).
   */
  async runTests(signal?: AbortSignal): Promise<TestResult> {
    return this.testRunner.run(signal);
  }

  /**
   * Validate without mutating the host tree. The patch exists only inside the
   * disposable test workspace and the returned token is bound to this exact
   * diff and the current preimages of every affected file.
   */
  async validatePatch(
    findingId: string,
    patchDiff: string,
    signal?: AbortSignal,
  ): Promise<PatchValidation> {
    const touchedPaths = this.parseTouchedPaths(patchDiff);
    const validation: PatchValidation = {
      findingId,
      patchHash: hashText(patchDiff),
      sourceFingerprint: await this.fingerprintPaths(touchedPaths),
      testResult: await this.testRunner.runWithPatch(patchDiff, signal),
      token: crypto.randomUUID(),
    };
    if (validation.testResult.passed && !validation.testResult.degraded) {
      this.validations.set(validation.token, validation);
    }

    return validation;
  }

  private async fingerprintPaths(relativePaths: string[]): Promise<string> {
    const hash = crypto.createHash('sha256');
    const rootRealPath = await fs.realpath(this.projectRoot);

    for (const relativePath of [...relativePaths].sort()) {
      hash.update(relativePath);
      const absolutePath = path.join(this.projectRoot, relativePath);
      const existingParent = await findExistingAncestor(path.dirname(absolutePath));
      const parentRealPath = await fs.realpath(existingParent);
      const parentRelative = path.relative(rootRealPath, parentRealPath);
      if (parentRelative.startsWith('..') || path.isAbsolute(parentRelative)) {
        throw new Error(`Patch path resolves outside the project root: ${relativePath}`);
      }

      try {
        const stat = await fs.lstat(absolutePath);
        if (stat.isSymbolicLink()) {
          throw new Error(`Patch cannot modify a symbolic link: ${relativePath}`);
        }

        hash.update(await fs.readFile(absolutePath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        hash.update('<missing>');
      }
    }

    return hash.digest('hex');
  }

  private parseTouchedPaths(diff: string): string[] {
    const paths = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)]
      .flatMap((match) => [match[1], match[2]])
      .filter((value): value is string => Boolean(value) && value !== '/dev/null');
    if (paths.length === 0) throw new Error('Patch must contain at least one git unified-diff file header.');

    const normalized = new Set<string>();
    for (const candidate of paths) {
      if (
        path.isAbsolute(candidate) ||
        candidate.includes('\\') ||
        candidate.split('/').includes('..') ||
        candidate.includes('\0') ||
        ['.git', '.shadow-auditor', 'node_modules'].includes(candidate.split('/')[0] ?? '')
      ) {
        throw new Error(`Patch contains an unsafe path: ${candidate}`);
      }

      const resolved = path.resolve(this.projectRoot, candidate);
      const relative = path.relative(this.projectRoot, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Patch path escapes the project root: ${candidate}`);
      }

      normalized.add(relative);
    }

    return [...normalized];
  }
}

function hashText(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function findExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;

  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}
