/**
 * Test Runner - Twin-Container CI with Baseline Determinism.
 *
 * Executes the project's test suite inside ephemeral Docker containers,
 * never on the host machine. Supports baseline fingerprinting to tolerate
 * pre-existing flaky tests: a patch is valid if it introduces ZERO new
 * failures compared to the baseline.
 */

import { exec } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// =============================================================================
// Types
// =============================================================================

export interface TestFingerprint {
  entries: Array<{ status: 'fail' | 'pass' | 'skip'; testName: string }>;
  framework: string;
  hash: string;
  timestamp: string;
}

export interface TestResult {
  baseline?: TestFingerprint;
  command: string;
  degraded: boolean;
  durationMs: number;
  exitCode: number;
  fingerprint: TestFingerprint;
  framework: string;
  newFailures: string[];
  passed: boolean;
  resolvedFailures: string[];
  stderr: string;
  stdout: string;
}

export interface TestRunnerOptions {
  containerImage?: string;
  projectRoot: string;
  testCommand?: string;
  timeoutMs?: number;
  useDocker?: boolean;
}

interface DetectedFramework {
  command: string;
  image: string;
  name: string;
}

// =============================================================================
// Framework Detection
// =============================================================================

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the project's test framework from manifest files.
 */
async function detectFramework(projectRoot: string): Promise<DetectedFramework> {
  // 1. Node.js / npm
  if (await fileExists(path.join(projectRoot, 'package.json'))) {
    return { command: 'npm test', image: 'node:20-alpine', name: 'npm' };
  }

  // 2. Python (pytest)
  if (
    await fileExists(path.join(projectRoot, 'pyproject.toml')) ||
    await fileExists(path.join(projectRoot, 'setup.py')) ||
    await fileExists(path.join(projectRoot, 'pytest.ini'))
  ) {
    return { command: 'pytest', image: 'python:3.12-alpine', name: 'pytest' };
  }

  // 3. Go
  if (await fileExists(path.join(projectRoot, 'go.mod'))) {
    return { command: 'go test ./...', image: 'golang:1.22-alpine', name: 'go' };
  }

  // 4. Rust / Cargo
  if (await fileExists(path.join(projectRoot, 'Cargo.toml'))) {
    return { command: 'cargo test', image: 'rust:1.77-alpine', name: 'cargo' };
  }

  // Fallback
  return { command: 'echo "No test framework detected"', image: 'alpine:latest', name: 'unknown' };
}

// =============================================================================
// Command Execution
// =============================================================================

function execAsync(
  command: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const proc = exec(
      command,
      {
        cwd: options.cwd,
        env: { ...process.env, CI: 'true' },
        maxBuffer: 10 * 1024 * 1024,
        timeout: options.timeoutMs ?? 120_000,
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error?.code ?? (error ? 1 : 0),
          stderr: typeof stderr === 'string' ? stderr : '',
          stdout: typeof stdout === 'string' ? stdout : '',
        });
      },
    );

    // Handle process-level errors (e.g., ENOENT)
    proc.on('error', () => {
      resolve({ exitCode: 127, stderr: `Command not found: ${command}`, stdout: '' });
    });
  });
}

// =============================================================================
// Fingerprint Parsing
// =============================================================================

/**
 * Parse test results from stdout into a fingerprint.
 *
 * Uses heuristics to detect common test output formats:
 * - Mocha/Jest: ✓ or ✔ for pass, number) for fail
 * - pytest: PASSED/FAILED markers
 * - Go: --- PASS / --- FAIL
 */
function parseTestOutput(stdout: string, framework: string): TestFingerprint['entries'] {
  const entries: TestFingerprint['entries'] = [];

  const lines = stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();

    // Mocha / Jest style: ✓ test name or ✔ test name
    if (/^[✓✔]\s+/.test(trimmed)) {
      entries.push({
        status: 'pass',
        testName: trimmed.replace(/^[✓✔]\s+/, '').trim(),
      });
      continue;
    }

    // Mocha / Jest style: N) test name (failure)
    if (/^\d+\)\s+/.test(trimmed)) {
      entries.push({
        status: 'fail',
        testName: trimmed.replace(/^\d+\)\s+/, '').trim(),
      });
      continue;
    }

    // pytest style: test_name PASSED
    if (/PASSED\s*$/.test(trimmed)) {
      entries.push({
        status: 'pass',
        testName: trimmed.replace(/\s*PASSED\s*$/, '').trim(),
      });
      continue;
    }

    // pytest style: test_name FAILED
    if (/FAILED\s*$/.test(trimmed)) {
      entries.push({
        status: 'fail',
        testName: trimmed.replace(/\s*FAILED\s*$/, '').trim(),
      });
      continue;
    }

    // Go style: --- PASS: TestName
    const goPassMatch = trimmed.match(/^--- PASS:\s+(\S+)/);
    if (goPassMatch) {
      entries.push({ status: 'pass', testName: goPassMatch[1] });
      continue;
    }

    // Go style: --- FAIL: TestName
    const goFailMatch = trimmed.match(/^--- FAIL:\s+(\S+)/);
    if (goFailMatch) {
      entries.push({ status: 'fail', testName: goFailMatch[1] });
      continue;
    }

    // Skip markers
    if (/\bskipped?\b/i.test(trimmed) || /\bpending\b/i.test(trimmed)) {
      const name = trimmed.replace(/.*(?:skip(?:ped)?|pending)[:\s]*/i, '').trim();
      if (name) {
        entries.push({ status: 'skip', testName: name });
      }
    }
  }

  return entries;
}

function computeFingerprintHash(entries: TestFingerprint['entries']): string {
  const sorted = [...entries]
    .sort((a, b) => a.testName.localeCompare(b.testName))
    .map((e) => `${e.testName}:${e.status}`)
    .join('\n');

  return crypto.createHash('sha256').update(sorted).digest('hex').slice(0, 16);
}

// =============================================================================
// Test Runner
// =============================================================================

export class TestRunner {
  private baseline: TestFingerprint | undefined;
  private readonly containerImage: string;
  private readonly framework: DetectedFramework;
  private readonly projectRoot: string;
  private readonly testCommand: string;
  private readonly timeoutMs: number;
  private readonly useDocker: boolean;

  private constructor(options: TestRunnerOptions, framework: DetectedFramework) {
    this.projectRoot = options.projectRoot;
    this.framework = framework;
    this.testCommand = options.testCommand ?? framework.command;
    this.containerImage = options.containerImage ?? framework.image;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.useDocker = options.useDocker ?? true;
  }

  /**
   * Auto-detect test framework and create a TestRunner.
   */
  static async detect(options: TestRunnerOptions): Promise<TestRunner> {
    const framework = await detectFramework(options.projectRoot);
    return new TestRunner(options, framework);
  }

  /**
   * Create a TestRunner with explicit framework details. Used in tests.
   */
  static fromFramework(
    options: TestRunnerOptions,
    framework: DetectedFramework,
  ): TestRunner {
    return new TestRunner(options, framework);
  }

  /**
   * Capture a baseline fingerprint before the swarm begins.
   * This records which tests pass/fail so we can detect degradation later.
   */
  async captureBaseline(): Promise<TestFingerprint> {
    const result = await this.executeTests();

    const entries = parseTestOutput(result.stdout, this.framework.name);
    this.baseline = {
      entries,
      framework: this.framework.name,
      hash: computeFingerprintHash(entries),
      timestamp: new Date().toISOString(),
    };

    return this.baseline;
  }

  /**
   * Get the current baseline fingerprint.
   */
  getBaseline(): TestFingerprint | undefined {
    return this.baseline;
  }

  /**
   * Get detected framework info.
   */
  getFramework(): DetectedFramework {
    return { ...this.framework };
  }

  /**
   * Run the test suite and compare against baseline.
   */
  async run(): Promise<TestResult> {
    const startTime = Date.now();
    const result = await this.executeTests();
    const durationMs = Date.now() - startTime;

    const entries = parseTestOutput(result.stdout, this.framework.name);
    const fingerprint: TestFingerprint = {
      entries,
      framework: this.framework.name,
      hash: computeFingerprintHash(entries),
      timestamp: new Date().toISOString(),
    };

    // Compute degradation against baseline
    let degraded = false;
    let newFailures: string[] = [];
    let resolvedFailures: string[] = [];

    if (this.baseline) {
      const baselineFailures = new Set(
        this.baseline.entries
          .filter((e) => e.status === 'fail')
          .map((e) => e.testName),
      );

      const currentFailures = new Set(
        entries
          .filter((e) => e.status === 'fail')
          .map((e) => e.testName),
      );

      // New failures = in current but NOT in baseline
      newFailures = [...currentFailures].filter((t) => !baselineFailures.has(t));

      // Resolved failures = in baseline but NOT in current
      resolvedFailures = [...baselineFailures].filter((t) => !currentFailures.has(t));

      // Degraded if there are new failures
      degraded = newFailures.length > 0;
    } else {
      // No baseline: traditional pass/fail based on exit code
      degraded = result.exitCode !== 0;
    }

    return {
      baseline: this.baseline,
      command: this.buildCommand(),
      degraded,
      durationMs,
      exitCode: result.exitCode,
      fingerprint,
      framework: this.framework.name,
      newFailures,
      passed: !degraded,
      resolvedFailures,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  }

  /**
   * Set a previously captured baseline (for deserialization).
   */
  setBaseline(baseline: TestFingerprint): void {
    this.baseline = baseline;
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  private buildCommand(): string {
    if (this.useDocker) {
      // Twin-Container CI: run inside ephemeral Docker container
      const absRoot = path.resolve(this.projectRoot);
      return [
        'docker', 'run', '--rm',
        '-v', `${absRoot}:/app:rw`,
        '-w', '/app',
        '--env', 'CI=true',
        '--memory', '512m',
        '--cpus', '1',
        this.containerImage,
        'sh', '-c', this.testCommand,
      ].join(' ');
    }

    return this.testCommand;
  }

  private async executeTests(): Promise<{ exitCode: number; stderr: string; stdout: string }> {
    const command = this.buildCommand();
    return execAsync(command, {
      cwd: this.projectRoot,
      timeoutMs: this.timeoutMs,
    });
  }
}

// Re-export for convenience
export { type DetectedFramework };
