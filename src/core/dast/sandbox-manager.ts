/**
 * Sandbox Manager - Dual-container DAST execution environment.
 *
 * Orchestrates a target container + Mirage OAST sidecar on an internal
 * Docker network (`shadow-net-{runId}`). The target routes all DNS/HTTP
 * through the Mirage, which simulates external services and captures
 * OAST callbacks for exploit validation.
 */

import { exec } from 'node:child_process';
import * as path from 'node:path';

import { type SandboxExecResult } from './dast-schema.js';
import { MirageOAST } from './mirage-oast.js';

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
    this.options = {
      baseImage: options.baseImage ?? 'node:20-slim',
      cpuLimit: options.cpuLimit ?? '1',
      healthCheckUrl: options.healthCheckUrl ?? '',
      memoryLimit: options.memoryLimit ?? '512m',
      runId: options.runId,
      startCommand: options.startCommand ?? '',
      targetPath: options.targetPath,
      timeoutMs: options.timeoutMs ?? 120_000,
    };

    this.networkName = `shadow-net-${this.options.runId}`;
    this.containerName = `shadow-target-${this.options.runId}`;
    this.mirage = new MirageOAST({
      networkName: this.networkName,
      runId: this.options.runId,
    });
  }

  /**
   * Create the Docker network and start the Mirage sidecar.
   */
  async create(): Promise<void> {
    // 1. Create the internal Docker network
    await this.dockerExec(`docker network create ${this.networkName}`);

    // 2. Start the Mirage OAST sidecar
    await this.mirage.start();

    // 3. Create the target container (not started yet)
    const absTargetPath = path.resolve(this.options.targetPath);
    const mirageContainer = this.mirage.getContainerName();

    const createCmd = [
      'docker', 'create',
      '--name', this.containerName,
      '--network', this.networkName,
      // Route HTTP through Mirage proxy
      '--env', `HTTP_PROXY=http://${mirageContainer}:8080`,
      '--env', `HTTPS_PROXY=http://${mirageContainer}:8080`,
      '--env', `http_proxy=http://${mirageContainer}:8080`,
      '--env', `https_proxy=http://${mirageContainer}:8080`,
      '--env', 'CI=true',
      // Resource limits
      '--memory', this.options.memoryLimit,
      '--cpus', this.options.cpuLimit,
      // Mount target as read-write (for test execution)
      '-v', `${absTargetPath}:/app:rw`,
      '-w', '/app',
      this.options.baseImage,
      'sleep', 'infinity',
    ].join(' ');

    const result = await this.dockerExec(createCmd);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create sandbox container: ${result.stderr}`);
    }

    // Start the container
    await this.dockerExec(`docker start ${this.containerName}`);
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

    const result = await this.exec(this.options.startCommand);

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
   * Idempotent and crash-safe.
   */
  async destroy(): Promise<void> {
    // Stop and remove target container
    await this.dockerExec(`docker rm -f ${this.containerName}`).catch(() => {});

    // Destroy Mirage sidecar
    await this.mirage.destroy().catch(() => {});

    // Remove Docker network
    await this.dockerExec(`docker network rm ${this.networkName}`).catch(() => {});

    this.running = false;
  }

  /**
   * Execute a command inside the sandbox target container.
   */
  async exec(command: string): Promise<SandboxExecResult> {
    if (!this.running) {
      throw new Error('Sandbox not running. Call create() first.');
    }

    const startTime = Date.now();
    const result = await this.dockerExec(
      `docker exec ${this.containerName} sh -c ${this.shellEscape(command)}`,
    );

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

  private dockerExec(
    command: string,
  ): Promise<{ exitCode: number; stderr: string; stdout: string }> {
    return new Promise((resolve) => {
      exec(
        command,
        { maxBuffer: 10 * 1024 * 1024, timeout: this.options.timeoutMs },
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

  private shellEscape(str: string): string {
    return `'${str.replaceAll("'", String.raw`'\''`)}'`;
  }
}
