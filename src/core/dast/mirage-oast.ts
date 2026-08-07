/**
 * Mirage OAST - Out-of-Band Application Security Testing Proxy.
 *
 * A local, autonomous Burp Collaborator equivalent. Runs as a sidecar
 * container on the `shadow-net` Docker network, acting as:
 *
 * - DNS Server (port 53): Resolves ALL domains to the Mirage itself,
 *   preventing startup crashes from missing external services.
 * - HTTP Proxy (port 8080): Intercepts all outbound HTTP requests,
 *   returning generic stub responses for dependency services.
 * - OAST Endpoint: Logs every intercepted request. The verifier agent
 *   injects payloads pointing to `oast-{token}.shadow.local`, and the
 *   Mirage captures those callbacks as proof of SSRF/Blind RCE.
 */

import { exec } from 'node:child_process';
import * as crypto from 'node:crypto';

import { type OastCallback } from './dast-schema.js';

// =============================================================================
// Mirage OAST Manager
// =============================================================================

export interface MirageOASTOptions {
  networkName: string;
  runId: string;
}

/**
 * Manages the Mirage OAST sidecar container and its callback log.
 */
export class MirageOAST {
  private readonly callbackLog: OastCallback[] = [];
  private containerName: string;
  private readonly networkName: string;
  private readonly runId: string;
  private running = false;

  constructor(options: MirageOASTOptions) {
    this.runId = options.runId;
    this.networkName = options.networkName;
    this.containerName = `mirage-oast-${this.runId}`;
  }

  /**
   * Clear all OAST callback logs.
   */
  clearLog(): void {
    this.callbackLog.length = 0;
  }

  /**
   * Destroy the Mirage container.
   */
  async destroy(): Promise<void> {
    if (!this.running) return;

    await this.dockerExec(`docker rm -f ${this.containerName}`);
    this.running = false;
  }

  /**
   * Generate a unique OAST callback token for a finding.
   */
  generateToken(findingId: string): string {
    const hash = crypto.createHash('sha256')
      .update(`${this.runId}:${findingId}:${Date.now()}`)
      .digest('hex')
      .slice(0, 12);
    return `oast-${hash}`;
  }

  /**
   * Get all OAST callbacks.
   */
  getCallbackLog(): OastCallback[] {
    return [...this.callbackLog];
  }

  /**
   * Get callbacks for a specific domain.
   */
  getCallbacksForDomain(domain: string): OastCallback[] {
    return this.callbackLog.filter((cb) => {
      try {
        const url = new URL(cb.url);
        return url.hostname.includes(domain);
      } catch {
        return cb.url.includes(domain);
      }
    });
  }

  /**
   * Get the container name for DNS/proxy configuration.
   */
  getContainerName(): string {
    return this.containerName;
  }

  /**
   * Check if a specific OAST token was called back.
   */
  hasCallback(tokenOrDomain: string): boolean {
    return this.callbackLog.some((cb) => cb.url.includes(tokenOrDomain));
  }

  /**
   * Whether the Mirage is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Record an OAST callback (called by the sandbox when polling Mirage logs).
   */
  recordCallback(callback: OastCallback): void {
    this.callbackLog.push(callback);
  }

  /**
   * Start the Mirage OAST sidecar container.
   *
   * The sidecar runs a minimal Node.js HTTP server that:
   * 1. Responds to all HTTP requests with `{"status":"ok"}`
   * 2. Logs every request URL, method, and headers
   * 3. The log can be queried via a management endpoint
   */
  async start(): Promise<void> {
    if (this.running) return;

    // Inline the Mirage server script as a single-command Docker run
    const mirageScript = `
const http = require('http');
const log = [];

const server = http.createServer((req, res) => {
  const entry = {
    headers: req.headers,
    method: req.method,
    timestamp: new Date().toISOString(),
    url: req.url,
  };

  // Management endpoint: return the log
  if (req.url === '/__mirage/log') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(log));
    return;
  }

  // Management endpoint: clear the log
  if (req.url === '/__mirage/clear') {
    log.length = 0;
    res.writeHead(200);
    res.end('cleared');
    return;
  }

  // Record callback and return generic stub
  log.push(entry);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
});

server.listen(8080, () => console.log('Mirage OAST listening on :8080'));
`.trim().replaceAll("'", String.raw`'\''`);

    const dockerCmd = [
      'docker', 'run', '-d',
      '--name', this.containerName,
      '--network', this.networkName,
      '--memory', '64m',
      '--cpus', '0.25',
      'node:20-alpine',
      'node', '-e', `'${mirageScript}'`,
    ].join(' ');

    const result = await this.dockerExec(dockerCmd);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to start Mirage OAST: ${result.stderr}`);
    }

    this.running = true;
  }

  /**
   * Sync the callback log from the Mirage container's management endpoint.
   */
  async syncLog(): Promise<OastCallback[]> {
    if (!this.running) return [];

    const result = await this.dockerExec(
      `docker exec ${this.containerName} wget -qO- http://localhost:8080/__mirage/log`,
    );

    if (result.exitCode !== 0) return [];

    try {
      const entries = JSON.parse(result.stdout);
      if (!Array.isArray(entries)) return [];

      const newCallbacks: OastCallback[] = entries
        .filter((e: Record<string, unknown>) => typeof e.url === 'string')
        .map((e: Record<string, unknown>) => ({
          headers: (e.headers as Record<string, string>) ?? {},
          method: (e.method as string) ?? 'GET',
          timestamp: (e.timestamp as string) ?? new Date().toISOString(),
          url: (e.url as string),
        }));

      // Merge without duplicates (by timestamp + url)
      const existingKeys = new Set(
        this.callbackLog.map((cb) => `${cb.timestamp}:${cb.url}`),
      );

      for (const cb of newCallbacks) {
        const key = `${cb.timestamp}:${cb.url}`;
        if (!existingKeys.has(key)) {
          this.callbackLog.push(cb);
          existingKeys.add(key);
        }
      }

      return newCallbacks;
    } catch {
      return [];
    }
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  private dockerExec(
    command: string,
  ): Promise<{ exitCode: number; stderr: string; stdout: string }> {
    return new Promise((resolve) => {
      exec(command, { maxBuffer: 5 * 1024 * 1024, timeout: 30_000 }, (error, stdout, stderr) => {
        resolve({
          exitCode: error?.code ?? (error ? 1 : 0),
          stderr: typeof stderr === 'string' ? stderr : '',
          stdout: typeof stdout === 'string' ? stdout : '',
        });
      });
    });
  }
}
