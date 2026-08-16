/**
 * Sandbox Manager - Dual-container DAST execution environment.
 *
 * Orchestrates a target container + Mirage OAST sidecar on an internal
 * Docker network (`shadow-net-{runId}`). The target routes all DNS/HTTP
 * through the Mirage, which simulates external services and captures
 * OAST callbacks for exploit validation.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { type SandboxExecResult } from './dast-schema.js';
import { MirageOAST } from './mirage-oast.js';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Validate that a string only contains characters safe for use in shell
 * identifiers (Docker container names, network names, volume names).
 * Rejects any character that could enable command injection when used
 * with execFile (which does NOT invoke a shell, but the docker daemon
 * itself interprets certain characters in container/network names).
 */
function validateSafeIdentifier(value: string, context: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) {
    throw new Error(
      `Invalid ${context}: "${value}" contains unsafe characters. ` +
      'Only alphanumeric characters, dots, hyphens, and underscores are permitted.',
    );
  }

  return value;
}

/**
 * Validate resource limit strings to prevent injection via Docker flags.
 * Accepts Docker's standard resource format: digits followed by optional
 * unit (m, g, b, k for memory; pure float for CPU).
 */
function validateResourceLimit(value: string, context: string): string {
  if (!/^[0-9]+(\.[0-9]+)?[mgbkMG]?$/.test(value.trim())) {
    throw new Error(
      `Invalid ${context}: "${value}". Expected a numeric value with optional unit (e.g., "512m", "1.5").`,
    );
  }

  return value.trim();
}

/**
 * Validate a Docker image reference to prevent image tag injection.
 * Matches the OCI distribution spec: [registry/]name[:tag|@digest]
 */
function validateImageRef(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,255}(?::[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}|@sha256:[a-fA-F0-9]{64})?$/.test(value.trim())) {
    throw new Error(
      `Invalid Docker image: "${value}". Must be a valid OCI image reference.`,
    );
  }

  return value.trim();
}

// =============================================================================
// Types
// =============================================================================

export interface SandboxOptions {
  baseImage?: string;
  cpuLimit?: string;
  dockerExecutor?: typeof execFile;
  healthCheckUrl?: string;
  memoryLimit?: string;
  runId: string;
  startCommand?: string;
  targetPath: string;
  timeoutMs?: number;
}

// =============================================================================
// Sandbox Manager
// =============================================================================

export class SandboxManager {
  private readonly containerName: string;
  private readonly dockerExecutor: typeof execFile;
  private readonly executionLog: SandboxExecResult[] = [];
  private readonly mirage: MirageOAST;
  private readonly networkName: string;
  private readonly options: Required<Omit<SandboxOptions, 'dockerExecutor'>>;
  private running = false;
  private workspaceRoot: null | string = null;

  constructor(options: SandboxOptions) {
    // Validate all user-configurable values before storing them
    const validatedRunId = validateSafeIdentifier(options.runId, 'runId');
    const validatedMemory = validateResourceLimit(options.memoryLimit ?? '512m', 'memoryLimit');
    const validatedCpu = validateResourceLimit(options.cpuLimit ?? '1', 'cpuLimit');
    const validatedImage = validateImageRef(options.baseImage ?? 'node:20-slim');

    this.options = {
      baseImage: validatedImage,
      cpuLimit: validatedCpu,
      healthCheckUrl: options.healthCheckUrl ?? '',
      memoryLimit: validatedMemory,
      runId: validatedRunId,
      startCommand: options.startCommand ?? '',
      targetPath: options.targetPath,
      timeoutMs: options.timeoutMs ?? 120_000,
    };
    this.dockerExecutor = options.dockerExecutor ?? execFile;

    this.networkName = `shadow-net-${validatedRunId}`;
    this.containerName = `shadow-target-${validatedRunId}`;
    this.mirage = new MirageOAST({
      dockerExecutor: this.dockerExecutor,
      networkName: this.networkName,
      runId: validatedRunId,
    });
  }

  /**
   * Create the Docker network and start the Mirage sidecar.
   *
   * Uses execFile with argument arrays — no shell interpolation — to
   * prevent command injection even if config values were compromised.
   */
  async create(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const { targetPath: optsTargetPath } = this.options;
    const absTargetPath = path.resolve(optsTargetPath);
    this.workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-dast-'));
    const workspacePath = path.join(this.workspaceRoot, 'project');

    try {
      await fs.cp(absTargetPath, workspacePath, {
        filter(source) {
          const relative = path.relative(absTargetPath, source);
          const topLevel = relative.split(path.sep)[0];
          return !['.git', '.shadow-auditor', 'node_modules'].includes(topLevel);
        },
        recursive: true,
      });
      signal?.throwIfAborted();

      // Pre-populate the workspace with the host's dependency directories
      // (node_modules, .venv, venv, vendor/bundle) by copying them in, rather
      // than bind-mounting them read-only. Read-only host bind mounts (a) let
      // the target see but never modify its deps (breaks installs/writes) and
      // (b) leak a host filesystem reference that outlives the disposable
      // workspace. Copying into the workspace keeps the container fully
      // self-contained and writable, while preserving the symlink-escape
      // protection in discoverDependencyMounts (realpath + relative checks).
      for (const dependencyMount of await discoverDependencyMounts(absTargetPath)) {
        const workspaceRelative = dependencyMount.containerPath.replace(/^\/app\/?/, '');
        if (workspaceRelative) {
          await fs.cp(dependencyMount.hostPath, path.join(workspacePath, workspaceRelative), {
            dereference: true,
            recursive: true,
          });
        }
      }
      signal?.throwIfAborted();

      // 1. Create the internal Docker network
      const networkResult = await this.dockerExec(
        ['network', 'create', '--internal', this.networkName],
        signal,
      );
      if (networkResult.exitCode !== 0) {
        throw new Error(`Failed to create sandbox network: ${networkResult.stderr}`);
      }

      // 2. Start the Mirage OAST sidecar
      await this.mirage.start(signal);
      signal?.throwIfAborted();

      // 3. Create the target container (not started yet)
      const mirageContainer = this.mirage.getContainerName();

      // Build args array — all values are individually passed, no shell parsing.
      const createArgs: string[] = [
        'create',
        '--name', this.containerName,
        '--network', this.networkName,
        '--env', `HTTP_PROXY=http://${mirageContainer}:8080`,
        '--env', `HTTPS_PROXY=http://${mirageContainer}:8080`,
        '--env', `http_proxy=http://${mirageContainer}:8080`,
        '--env', `https_proxy=http://${mirageContainer}:8080`,
        '--env', 'CI=true',
        '--memory', this.options.memoryLimit,
        '--cpus', this.options.cpuLimit,
        '-v', `${workspacePath}:/app:rw`,
      ];
      // Point the target's DNS at Mirage so OAST payloads to *.shadow.local
      // resolve on the --internal network (Docker's embedded DNS only resolves
      // container names; unqualified names are forwarded to this server).
      // If IP discovery failed, fall back to Docker defaults.
      const mirageIP = this.mirage.getContainerIP();
      if (mirageIP) {
        createArgs.push('--dns', mirageIP);
      }

      createArgs.push(
        '-w', '/app',
        this.options.baseImage,
        'sleep', 'infinity',
      );

      const result = await this.dockerExec(createArgs, signal);
      if (result.exitCode !== 0) {
        throw new Error(`Failed to create sandbox container: ${result.stderr}`);
      }

      // Start the container
      const startResult = await this.dockerExec(['start', this.containerName], signal);
      if (startResult.exitCode !== 0) {
        throw new Error(`Failed to start sandbox container: ${startResult.stderr}`);
      }

      const inspectResult = await this.dockerExec(
        ['inspect', '--format', '{{.State.Running}}', this.containerName],
        signal,
      );
      if (inspectResult.exitCode !== 0 || inspectResult.stdout.trim() !== 'true') {
        throw new Error(`Sandbox container exited during startup: ${inspectResult.stderr || inspectResult.stdout}`);
      }

      this.running = true;
    } catch (error) {
      await this.destroy();
      throw error;
    }
  }

  /**
   * Deploy the target application inside the sandbox.
   */
  async deploy(signal?: AbortSignal, startCommand?: string): Promise<string> {
    signal?.throwIfAborted();
    if (!this.running) {
      throw new Error('Sandbox not created. Call create() first.');
    }

    const command = startCommand?.trim() || this.options.startCommand;
    if (!command) {
      return 'No start command configured';
    }

    // The deploy command runs via `docker exec ... sh -c <cmd>`, which does
    // invoke a shell inside the container — but the command is already
    // constrained to the disposable sandbox container, not the host.
    const result = await this.exec(command, signal);
    if (result.exitCode !== 0) {
      throw new Error(`Target deploy command failed with exit code ${result.exitCode}: ${result.stderr}`);
    }

    // If health check URL is configured, wait for it
    if (this.options.healthCheckUrl) {
      const maxAttempts = 10;
      for (let i = 0; i < maxAttempts; i++) {
        const healthCheck = await this.exec(
          `wget -qO- --timeout=5 ${this.options.healthCheckUrl} 2>/dev/null || true`,
          signal,
        );
        if (healthCheck.exitCode === 0 && healthCheck.stdout.trim()) {
          return `Target deployed and healthy at ${this.options.healthCheckUrl}`;
        }

        // Wait 2 seconds between attempts
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(resolve, 2000);
          signal?.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(signal.reason ?? new Error('Sandbox deployment aborted.'));
          }, { once: true });
        });
      }

      throw new Error(`Target deploy command completed but health check did not pass: ${this.options.healthCheckUrl}`);
    }

    return `Target deploy command executed: ${result.stdout.slice(0, 500)}`;
  }

  /**
   * Force-destroy everything: containers, network, volumes.
   * Idempotent and crash-safe. Uses execFile with argument arrays
   * to prevent any shell injection through identifiers.
   */
  async destroy(): Promise<void> {
    // Stop and remove target container
    await this.dockerExec(['rm', '-f', this.containerName]).catch(() => {});

    // Destroy Mirage sidecar
    await this.mirage.destroy().catch(() => {});

    // Remove Docker network
    await this.dockerExec(['network', 'rm', this.networkName]).catch(() => {});

    this.running = false;
    if (this.workspaceRoot) {
      await fs.rm(this.workspaceRoot, { force: true, recursive: true });
      this.workspaceRoot = null;
    }
  }

  /**
   * Execute a command inside the sandbox target container.
   *
   * Uses `docker exec <container> sh -c <command>`. The command runs inside
   * the disposable sandbox container, which has no access to the host
   * filesystem (only the mounted target directory). While sh -c does invoke
   * a shell, the blast radius is limited to the container.
   */
  async exec(command: string, signal?: AbortSignal): Promise<SandboxExecResult> {
    signal?.throwIfAborted();
    if (!this.running) {
      throw new Error('Sandbox not running. Call create() first.');
    }

    const startTime = Date.now();
    const result = await this.dockerExec([
      'exec', this.containerName, 'sh', '-c', command,
    ], signal);

    const execResult: SandboxExecResult = {
      command,
      durationMs: Date.now() - startTime,
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
      timestamp: new Date().toISOString(),
    };

    this.pushExecutionLog(execResult);
    return execResult;
  }

      // Ring-buffer cap: a long-lived DAST session can run many commands; keeping
      // every result in memory is unnecessary since the report only needs the tail.
      // The oldest entries are dropped once the cap is reached.
      private pushExecutionLog(entry: SandboxExecResult): void {
        const MAX_LOG_ENTRIES = 500;
        if (this.executionLog.length >= MAX_LOG_ENTRIES) {
          this.executionLog.shift();
        }
        this.executionLog.push(entry);
      }

  /**
   * Get the full execution log (used by the report generator for verbatim PoC).
   */
  getExecutionLog(): SandboxExecResult[] {
    return [...this.executionLog];
  }

  /**
   * Get the Mirage OAST instance for direct callback queries.
   */
  getMirage(): MirageOAST {
    return this.mirage;
  }

  /**
   * Whether the sandbox is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get sandbox status.
   */
  async status(signal?: AbortSignal): Promise<{
    containerRunning: boolean;
    mirageRunning: boolean;
    networkName: string;
    oastCallbackCount: number;
  }> {
    signal?.throwIfAborted();
    // Sync OAST logs
    if (this.mirage.isRunning()) {
      await this.mirage.syncLog(signal);
    }

    return {
      containerRunning: this.running,
      mirageRunning: this.mirage.isRunning(),
      networkName: this.networkName,
      oastCallbackCount: this.mirage.getCallbackLog().length,
    };
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  /**
   * Execute a Docker command using execFile (NO shell). All arguments are
   * passed as separate array elements, preventing command injection even
   * if individual values contain shell metacharacters.
   *
   * NOTE: This still invokes the Docker CLI binary. If an attacker can
   * control a --flag VALUE pair where VALUE is interpreted by Docker
   * itself (e.g., --label), they could inject Docker daemon options.
   * All values that reach this method MUST be validated by the caller
   * (validateSafeIdentifier, validateResourceLimit, etc.) before being
   * added to the args array.
   */
  private dockerExec(
    args: string[],
    signal?: AbortSignal,
  ): Promise<{ exitCode: number; stderr: string; stdout: string }> {
    return new Promise((resolve, reject) => {
      this.dockerExecutor(
        'docker',
        args,
        {
          maxBuffer: 10 * 1024 * 1024,
          signal,
          timeout: this.options.timeoutMs,
        },
        (error, stdout, stderr) => {
          if (signal?.aborted) {
            reject(signal.reason ?? error ?? new Error('Docker operation aborted.'));
            return;
          }

          resolve({
            exitCode: typeof error?.code === 'number' ? error.code : (error ? 1 : 0),
            stderr: typeof stderr === 'string' ? stderr : '',
            stdout: typeof stdout === 'string' ? stdout : '',
          });
        },
      );
    });
  }
}

async function discoverDependencyMounts(
  targetPath: string,
): Promise<Array<{ containerPath: string; hostPath: string }>> {
  const candidates = [
    { containerPath: '/app/node_modules', relativePath: 'node_modules' },
    { containerPath: '/app/.venv', relativePath: '.venv' },
    { containerPath: '/app/venv', relativePath: 'venv' },
    { containerPath: '/app/vendor/bundle', relativePath: path.join('vendor', 'bundle') },
  ];
  const mounts: Array<{ containerPath: string; hostPath: string }> = [];
  const root = await fs.realpath(targetPath);

  for (const candidate of candidates) {
    const hostPath = path.join(root, candidate.relativePath);
    try {
      const stats = await fs.lstat(hostPath);
      if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
      const realPath = await fs.realpath(hostPath);
      const relative = path.relative(root, realPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      mounts.push({ containerPath: candidate.containerPath, hostPath: realPath });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  return mounts;
}
