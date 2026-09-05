/**
 * Test Runner - Twin-Container CI with Baseline Determinism.
 *
 * Executes the project's test suite inside ephemeral Docker containers,
 * never on the host machine. Supports baseline fingerprinting to tolerate
 * pre-existing flaky tests: a patch is valid if it introduces ZERO new
 * failures compared to the baseline.
 */

import { execFile, spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { removePathResilient } from '../../utils/fs-atomic.js';

// =============================================================================
// Types
// =============================================================================

export interface TestFingerprint {
  entries: Array<{ status: 'fail' | 'pass' | 'skip'; testName: string }>;
  exitCode: number;
  framework: string;
  hash: string;
  outputLineCount: number;
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

async function validatePythonRequirements(projectRoot: string): Promise<void> {
  const requirementsPath = path.join(projectRoot, 'requirements.txt');
  if (!(await fileExists(requirementsPath))) return;

  const unsafeRequirement = /(?:^|[\s;])(?:-e|--editable|git\+|hg\+|svn\+|bzr\+|file:|https?:|ssh:)|\s@\s|^[./~]|^[A-Za-z]:[\\/]|(?:\.whl|\.zip|\.tar(?:\.gz|\.bz2|\.xz)?)\s*(?:#.*)?$/i;
  const lines = (await fs.readFile(requirementsPath, 'utf8')).split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('--hash=')) continue;
    if (line.startsWith('-') || unsafeRequirement.test(line)) {
      throw new Error(
        `Unsafe Python requirement at requirements.txt:${index + 1}. ` +
          'Remediation validation accepts registry package requirements and binary wheels only.',
      );
    }
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
    return { command: 'pytest -vv', image: 'python:3.12-alpine', name: 'pytest' };
  }

  // 3. Go
  if (await fileExists(path.join(projectRoot, 'go.mod'))) {
    return { command: 'go test -json ./...', image: 'golang:1.22-alpine', name: 'go' };
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

interface BuiltCommand {
  args: string[];
  cmd: string;
}

function execAsync(
  built: BuiltCommand,
  options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: { exitCode: number; stderr: string; stdout: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const proc = execFile(
      built.cmd,
      built.args,
      {
        cwd: options.cwd,
        env: { ...process.env, CI: 'true' },
        maxBuffer: 10 * 1024 * 1024,
        signal: options.signal,
        timeout: options.timeoutMs ?? 120_000,
      },
      (error, stdout, stderr) => {
        if (options.signal?.aborted) {
          fail(options.signal.reason ?? error ?? new Error('Test execution aborted.'));
          return;
        }

        finish({
          exitCode: typeof error?.code === 'number' ? error.code : (error ? 1 : 0),
          stderr: typeof stderr === 'string' ? stderr : '',
          stdout: typeof stdout === 'string' ? stdout : '',
        });
      },
    );

    // Handle process-level errors (e.g., ENOENT)
    proc.on('error', () => {
      if (options.signal?.aborted) {
        fail(options.signal.reason ?? new Error('Test execution aborted.'));
      } else {
        finish({ exitCode: 127, stderr: `Command not found: ${built.cmd}`, stdout: '' });
      }
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
function parseGoTestOutput(output: string): TestFingerprint['entries'] {
  const entries: TestFingerprint['entries'] = [];

  for (const line of output.split('\n')) {
    try {
      const event = JSON.parse(line) as {
        Action?: unknown;
        Package?: unknown;
        Test?: unknown;
      };
      if (
        typeof event.Package === 'string' &&
        (event.Action === 'pass' || event.Action === 'fail' || event.Action === 'skip')
      ) {
        entries.push({
          status: event.Action,
          testName: `${event.Package}/${typeof event.Test === 'string' ? event.Test : '<package>'}`,
        });
      }
    } catch {
      // Non-JSON diagnostics do not establish a stable Go test identity.
    }
  }

  return entries;
}

function parseTestOutput(output: string, framework: string): TestFingerprint['entries'] {
  if (framework === 'go') return parseGoTestOutput(output);

  const entries: TestFingerprint['entries'] = [];

  const lines = output.split('\n');
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

    // pytest verbose style: test_name PASSED [ 25%]
    if (/\sPASSED(?:\s+\[[^\]]+\])?\s*$/.test(trimmed)) {
      entries.push({
        status: 'pass',
        testName: trimmed.replace(/\s+PASSED(?:\s+\[[^\]]+\])?\s*$/, '').trim(),
      });
      continue;
    }

    // pytest style: test_name FAILED
    if (/\sFAILED(?:\s+\[[^\]]+\])?\s*$/.test(trimmed)) {
      entries.push({
        status: 'fail',
        testName: trimmed.replace(/\s+FAILED(?:\s+\[[^\]]+\])?\s*$/, '').trim(),
      });
      continue;
    }

    const cargoMatch = trimmed.match(/^test\s+(.+?)\s+\.\.\.\s+(ok|FAILED|ignored)$/);
    if (cargoMatch) {
      entries.push({
        status: cargoMatch[2] === 'ok' ? 'pass' : cargoMatch[2] === 'FAILED' ? 'fail' : 'skip',
        testName: cargoMatch[1],
      });
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

function countOutputLines(stdout: string, stderr: string): number {
  return `${stdout}\n${stderr}`.split(/\r?\n/).filter((line) => line.trim()).length;
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

    const entries = parseTestOutput(`${result.stdout}\n${result.stderr}`, this.framework.name);
    if (entries.length === 0) {
      throw new Error(
        'Remediation requires a test command with machine-readable test results; the baseline reported no tests.',
      );
    }

    this.baseline = {
      entries,
      exitCode: result.exitCode,
      framework: this.framework.name,
      hash: computeFingerprintHash(entries),
      outputLineCount: countOutputLines(result.stdout, result.stderr),
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
  async run(signal?: AbortSignal): Promise<TestResult> {
    return this.runInternal(undefined, signal);
  }

  /**
   * Apply a proposed patch only inside the disposable validation workspace,
   * then run the same baseline comparison used by normal remediation tests.
   */
  async runWithPatch(patchDiff: string, signal?: AbortSignal): Promise<TestResult> {
    return this.runInternal(patchDiff, signal);
  }

  /**
   * Set a previously captured baseline (for deserialization).
   */
  setBaseline(baseline: TestFingerprint): void {
    if (baseline.entries.length === 0) {
      throw new Error('Cannot use a remediation baseline that contains no parsed tests.');
    }

    this.baseline = baseline;
  }

  private buildCommand(executionRoot = this.projectRoot): BuiltCommand {
    if (this.useDocker) {
      // Twin-Container CI: run inside ephemeral Docker container
      const absRoot = path.resolve(executionRoot);
      const projectHash = this.projectCacheKey();

      const dockerArgs = [
        'run', '--rm',
        '--network', 'none',
        '-v', `${absRoot}:/app:rw`,
      ];

      let runCmd = this.testCommand;
      const fw = this.framework.name;

      switch (fw) {
      case 'cargo': {
        dockerArgs.push(
          '-v', `shadow-cargo-target-${projectHash}:/app/target`,
          '-v', `shadow-cargo-registry-${projectHash}:/cargo-home/registry:ro`,
          '-v', `shadow-cargo-git-${projectHash}:/cargo-home/git:ro`,
          '--env', 'CARGO_HOME=/cargo-home',
          '--env', 'CARGO_NET_OFFLINE=true',
        );

      break;
      }

      case 'go': {
        dockerArgs.push('-v', `shadow-go-cache-${projectHash}:/go/pkg/mod:ro`);

      break;
      }

      case 'npm': {
        dockerArgs.push('-v', `shadow-node-modules-${projectHash}:/app/node_modules:ro`);

      break;
      }

      case 'pytest': {
        dockerArgs.push('-v', `shadow-python-venv-${projectHash}:/venv:ro`);
        runCmd = `export PATH=/venv/bin:$PATH; ${this.testCommand}`;

      break;
      }
      // No default
      }

      dockerArgs.push(
        '-w', '/app',
        '--env', 'CI=true',
        '--memory', '512m',
        '--cpus', '1',
        this.containerImage,
        'sh', '-c', runCmd,
      );

      return { args: dockerArgs, cmd: 'docker' };
    }

    // Non-Docker: delegate to shell for test command execution (may contain
    // shell features like pipes, conditionals). execFile('sh', ['-c', ...])
    // avoids spawning an intermediate shell layer.
    return { args: ['-c', this.testCommand], cmd: 'sh' };
  }

  private buildDependencyCommands(executionRoot: string): BuiltCommand[] {
    if (!this.useDocker) return [];

    const absRoot = path.resolve(executionRoot);
    const projectHash = this.projectCacheKey();
    const args = ['run', '--rm', '-v', `${absRoot}:/app:ro`];
    let command: string;

    switch (this.framework.name) {
    case 'cargo': {
      args.push(
        '-v', `shadow-cargo-target-${projectHash}:/app/target`,
        '-v', `shadow-cargo-registry-${projectHash}:/cargo-home/registry`,
        '-v', `shadow-cargo-git-${projectHash}:/cargo-home/git`,
        '--env', 'CARGO_HOME=/cargo-home',
      );
      command = 'cargo fetch --locked';
      break;
    }

    case 'go': {
      args.push('-v', `shadow-go-cache-${projectHash}:/go/pkg/mod`);
      command = 'go mod download';
      break;
    }

    case 'npm': {
      args.push('-v', `shadow-node-modules-${projectHash}:/app/node_modules`);
      command = [
        'if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ];',
        'then npm ci --ignore-scripts;',
        'else npm install --ignore-scripts --package-lock=false;',
        'fi',
      ].join(' ');
      args.push('--env', 'npm_config_ignore_scripts=true');
      break;
    }

    case 'pytest': {
      const wheelVolume = `shadow-python-wheels-${projectHash}`;
      const venvVolume = `shadow-python-venv-${projectHash}`;
      const downloadArgs = [
        ...args,
        '-v', `${wheelVolume}:/wheels`,
        '-w', '/app',
        '--env', 'CI=true',
        '--memory', '512m',
        '--cpus', '1',
        this.containerImage,
        'sh', '-c',
        'rm -rf /wheels/*; if [ -f requirements.txt ]; ' +
          'then python -m pip download --disable-pip-version-check ' +
          '--only-binary=:all: --dest /wheels -r requirements.txt; fi',
      ];
      const installArgs = [
        'run', '--rm', '--network', 'none',
        '-v', `${absRoot}:/app:ro`,
        '-v', `${wheelVolume}:/wheels:ro`,
        '-v', `${venvVolume}:/venv`,
        '-w', '/app',
        '--env', 'CI=true',
        '--memory', '512m',
        '--cpus', '1',
        this.containerImage,
        'sh', '-c',
        'rm -rf /venv/*; python -m venv /venv; ' +
          'if [ -f requirements.txt ]; then /venv/bin/pip install ' +
          '--disable-pip-version-check --no-index --only-binary=:all: ' +
          '--find-links=/wheels -r requirements.txt; fi',
      ];
      return [
        {args: downloadArgs, cmd: 'docker'},
        {args: installArgs, cmd: 'docker'},
      ];
    }

    default: {
      return [];
    }
    }

    args.push(
      '-w', '/app',
      '--env', 'CI=true',
      '--memory', '512m',
      '--cpus', '1',
      this.containerImage,
      'sh', '-c', command,
    );
    return [{args, cmd: 'docker'}];
  }

  private async executeTests(
    signal?: AbortSignal,
    patchDiff?: string,
  ): Promise<{ exitCode: number; stderr: string; stdout: string }> {
    const workspaceParent = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-remediation-test-'));
    const executionRoot = path.join(workspaceParent, 'project');
    try {
      await fs.cp(this.projectRoot, executionRoot, {
        filter: (source) => {
          const relative = path.relative(this.projectRoot, source);
          if (!relative) return true;
          const firstSegment = relative.split(path.sep, 1)[0];
          if (firstSegment === '.git' || firstSegment === '.shadow-auditor') return false;
          return !this.useDocker || firstSegment !== 'node_modules';
        },
        recursive: true,
      });
      if (patchDiff) {
        await applyPatchToWorkspace(executionRoot, patchDiff, signal);
      }

      if (this.framework.name === 'pytest') {
        await validatePythonRequirements(executionRoot);
      }

      for (const dependencyCommand of this.buildDependencyCommands(executionRoot)) {
        const preparation = await execAsync(dependencyCommand, {
          cwd: executionRoot,
          signal,
          timeoutMs: this.timeoutMs,
        });
        if (preparation.exitCode !== 0) return preparation;
      }

      const built = this.buildCommand(executionRoot);
      return await execAsync(built, {
        cwd: executionRoot,
        signal,
        timeoutMs: this.timeoutMs,
      });
    } finally {
      await removePathResilient(workspaceParent);
    }
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  private projectCacheKey(): string {
    return crypto.createHash('sha256')
      .update(path.resolve(this.projectRoot))
      .digest('hex')
      .slice(0, 12);
  }

  private async runInternal(patchDiff?: string, signal?: AbortSignal): Promise<TestResult> {
    const startTime = Date.now();
    const built = this.buildCommand();
    const result = await this.executeTests(signal, patchDiff);
    const durationMs = Date.now() - startTime;

    const entries = parseTestOutput(`${result.stdout}\n${result.stderr}`, this.framework.name);
    const fingerprint: TestFingerprint = {
      entries,
      exitCode: result.exitCode,
      framework: this.framework.name,
      hash: computeFingerprintHash(entries),
      outputLineCount: countOutputLines(result.stdout, result.stderr),
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
      const currentTestNames = new Set(entries.map((entry) => entry.testName));
      const baselineTestMissing = this.baseline.entries.some(
        (entry) => !currentTestNames.has(entry.testName),
      );

      const runnerRegressed = result.exitCode !== 0 && this.baseline.exitCode === 0;
      const outputDisappeared = this.baseline.outputLineCount > 0 &&
        fingerprint.outputLineCount === 0;
      const coverageRegressed =
        baselineTestMissing ||
        entries.length < this.baseline.entries.length ||
        outputDisappeared;
      degraded = newFailures.length > 0 || runnerRegressed || coverageRegressed;
    } else {
      // No baseline: traditional pass/fail based on exit code
      degraded = result.exitCode !== 0;
    }

    return {
      baseline: this.baseline,
      command: `${built.cmd} ${built.args.join(' ')}`,
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
}

function applyPatchToWorkspace(
    workspace: string,
    patchDiff: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'apply', '--whitespace=nowarn', '-'], {
        cwd: workspace,
        signal,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Patch validation workspace rejected the diff: ${stderr.trim()}`));
      });
      child.stdin.end(patchDiff);
    });
}

// Re-export for convenience
export { type DetectedFramework };
