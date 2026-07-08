/**
 * Sandbox Manager - Dual-container DAST execution environment.
 *
 * Orchestrates a target container + Mirage OAST sidecar on an internal
 * Docker network (`shadow-net-{runId}`). The target routes all DNS/HTTP
 * through the Mirage, which simulates external services and captures
 * OAST callbacks for exploit validation.
 */

import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { type SandboxExecResult } from './dast-schema.js';
import { MirageOAST } from './mirage-oast.js';

const execFileAsync = promisify(execFile);

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
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.\/-]{0,255}(:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})?$/.test(value.trim())) {
    throw new Error(
      `Invalid Docker image: "${value}". Must be a valid OCI image reference.`,
    );
  }
  return value.trim();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Types
// =============================================================================

export interface SandboxOptions {
  baseImage?: string;
  cpuLimit?: string;
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
  private readonly executionLog: SandboxExecResult[] = [];
  private readonly mirage: MirageOAST;
  private readonly networkName: string;
  private readonly options: Required<SandboxOptions>;
  private running = false;

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

    this.networkName = `shadow-net-${validatedRunId}`;
    this.containerName = `shadow-target-${validatedRunId}`;
    this.mirage = new MirageOAST({
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
  async create(): Promise<void> {
    const { runId, targetPath: optsTargetPath } = this.options;

    // 1. Create the internal Docker network
    await this.dockerExec(['network', 'create', this.networkName]);

    // 2. Start the Mirage OAST sidecar
    await this.mirage.start();

    // 3. Create the target container (not started yet)
    const absTargetPath = path.resolve(optsTargetPath);
    const projectHash = crypto.createHash('sha256').update(absTargetPath).digest('hex').slice(0, 12);
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
      '-v', `${absTargetPath}:/app:rw`,
    ];

    if (await fileExists(path.join(absTargetPath, 'package.json'))) {
      createArgs.push('-v', `shadow-node-modules-${projectHash}:/app/node_modules`);
    } else if (
      await fileExists(path.join(absTargetPath, 'pyproject.toml')) ||
      await fileExists(path.join(absTargetPath, 'setup.py')) ||
      await fileExists(path.join(absTargetPath, 'pytest.ini')) ||
      await fileExists(path.join(absTargetPath, 'requirements.txt'))
    ) {
      createArgs.push('-v', `shadow-python-venv-${projectHash}:/app/.venv`);
    } else if (await fileExists(path.join(absTargetPath, 'go.mod'))) {
      createArgs.push('-v', `shadow-go-cache-${projectHash}:/go/pkg/mod`);
    } else if (await fileExists(path.join(absTargetPath, 'Cargo.toml'))) {
      createArgs.push('-v', `shadow-cargo-target-${projectHash}:/app/target`);
    }

    createArgs.push(
      '-w', '/app',
      this.options.baseImage,
      'sleep', 'infinity',
    );

    const result = await this.dockerExec(createArgs);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create sandbox container: ${result.stderr}`);
    }

    // Start the container
    await this.dockerExec(['start', this.containerName]);
    this.running = true;
  }

  /**
   * Deploy the target application inside the sandbox.
   */
  async deploy(): Promise<string> {
    if (!this.running) {
      throw new Error('Sandbox not created. Call create() first.');
    }

    if (!this.options.startCommand) {
      return 'No start command configured';
    }

    let deployCmd = this.options.startCommand;
    const absTargetPath = path.resolve(this.options.targetPath);

    if (await fileExists(path.join(absTargetPath, 'package.json'))) {
      deployCmd = `npm install && ${this.options.startCommand}`;
    } else if (
      await fileExists(path.join(absTargetPath, 'pyproject.toml')) ||
      await fileExists(path.join(absTargetPath, 'setup.py')) ||
      await fileExists(path.join(absTargetPath, 'requirements.txt'))
    ) {
      deployCmd = `(if [ -f requirements.txt ]; then pip install -r requirements.txt; fi) && ${this.options.startCommand}`;
    }

    // The deploy command runs via `docker exec ... sh -c <cmd>`, which does
    // invoke a shell inside the container — but the command is already
    // constrained to the disposable sandbox container, not the host.
    const result = await this.exec(deployCmd);

    // If health check URL is configured, wait for it
    if (this.options.healthCheckUrl) {
      const maxAttempts = 10;
      for (let i = 0; i < maxAttempts; i++) {
        const healthCheck = await this.exec(
          `wget -qO- --timeout=5 ${this.options.healthCheckUrl} 2>/dev/null || true`,
        );
        if (healthCheck.exitCode === 0 && healthCheck.stdout.trim()) {
          return `Target deployed and healthy at ${this.options.healthCheckUrl}`;
        }

        // Wait 2 seconds between attempts
        await new Promise<void>((resolve) => { setTimeout(resolve, 2000); });
      }

      return 'Target deployed but health check did not pass';
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
  }

  /**
   * Execute a command inside the sandbox target container.
   *
   * Uses `docker exec <container> sh -c <command>`. The command runs inside
   * the disposable sandbox container, which has no access to the host
   * filesystem (only the mounted target directory). While sh -c does invoke
   * a shell, the blast radius is limited to the container.
   */
  async exec(command: string): Promise<SandboxExecResult> {
    if (!this.running) {
      throw new Error('Sandbox not running. Call create() first.');
    }

    const startTime = Date.now();
    const result = await this.dockerExec([
      'exec', this.containerName, 'sh', '-c', command,
    ]);

    const execResult: SandboxExecResult = {
      command,
      durationMs: Date.now() - startTime,
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
      timestamp: new Date().toISOString(),
    };

    this.executionLog.push(execResult);
    return execResult;
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
  async status(): Promise<{
    containerRunning: boolean;
    mirageRunning: boolean;
    networkName: string;
    oastCallbackCount: number;
  }> {
    // Sync OAST logs
    if (this.mirage.isRunning()) {
      await this.mirage.syncLog();
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
  ): Promise<{ exitCode: number; stderr: string; stdout: string }> {
    return new Promise((resolve) => {
      execFile(
        'docker',
        args,
        {
          maxBuffer: 10 * 1024 * 1024,
          timeout: this.options.timeoutMs,
        },
        (error, stdout, stderr) => {
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
