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

import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';

import { type OastCallback } from './dast-schema.js';
import { buildDnsAResponse } from './dns-response.js';

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate that a string only contains characters safe for use in Docker
 * identifiers (container names, network names). The regex rejects values
 * that could enable injection when passed as execFile arguments.
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

// =============================================================================
// Mirage OAST Manager
// =============================================================================

export interface MirageOASTOptions {
  dockerExecutor?: typeof execFile;
  networkName: string;
  runId: string;
}

/**
 * Manages the Mirage OAST sidecar container and its callback log.
 */
export class MirageOAST {
  private readonly callbackLog: OastCallback[] = [];
  private callbackOverflow = false;
  private containerName: string;
  private readonly managementToken: string;
  private readonly dockerExecutor: typeof execFile;
  private readonly networkName: string;
  private readonly runId: string;
  private running = false;
  private containerIP: string | null = null;

  constructor(options: MirageOASTOptions) {
    this.runId = validateSafeIdentifier(options.runId, 'runId');
    this.networkName = validateSafeIdentifier(options.networkName, 'networkName');
    this.containerName = `mirage-oast-${this.runId}`;
    this.dockerExecutor = options.dockerExecutor ?? execFile;
    // Unguessable secret that gates the in-container management endpoint. The
    // sandbox target is untrusted code on the same Docker network; without this
    // it could read the callback log (steal OAST tokens / fabricate proof) or
    // wipe evidence. The token is embedded in the container's node -e script,
    // which the target container cannot inspect.
    this.managementToken = crypto.randomBytes(16).toString('hex');
  }

  /**
   * Clear all OAST callback logs.
   */
  clearLog(): void {
    this.callbackLog.length = 0;
    this.callbackOverflow = false;
  }

  /**
   * Destroy the Mirage container.
   */
  async destroy(): Promise<void> {
    // Removal is unconditional because cancellation can occur after Docker
    // creates the container but before the start call marks it as running.
    await this.dockerExec(['rm', '-f', this.containerName]);
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
       * Whether any callback was evicted from the ring buffer (a signal that the
       * session is producing more OAST traffic than the in-memory cap retains).
       */
      hasCallbackOverflow(): boolean {
        return this.callbackOverflow;
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
   * Get the container's IP address (discovered at start time). Used so the
   * sandbox can pass it as `--dns` to the target container, letting the
   * target resolve *.shadow.local back to Mirage for OAST callbacks.
   */
  getContainerIP(): string | null {
    return this.containerIP;
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
     * Capped as a ring buffer (oldest evicted) so an aggressively polling or
     * long-lived session cannot grow this in memory without bound.
     */
    recordCallback(callback: OastCallback): void {
      const MAX_CALLBACK_ENTRIES = 5000;
      if (this.callbackLog.length >= MAX_CALLBACK_ENTRIES) {
        this.callbackLog.shift();
        this.callbackOverflow = true;
      }
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
  async start(signal?: AbortSignal): Promise<void> {
    if (this.running) return;

    const dnsResponseFn = `\n` + buildDnsAResponse.toString() + `\n`;

    // Mirage server script. Passed directly as a single argument to node -e;
    // no shell quoting needed since execFile does NOT invoke a shell.
    const mirageScript = `
const http = require('http');
const dgram = require('dgram');
const os = require('os');
const log = [];

const TOKEN = '${this.managementToken}';

// buildDnsAResponse source is inlined here at runtime via ${dnsResponseFn}.
${dnsResponseFn}
const server = http.createServer((req, res) => {
  const entry = {
    headers: req.headers,
    method: req.method,
    timestamp: new Date().toISOString(),
    url: req.url,
  };

  // Management endpoint: return the log. Requires the unguessable token so
  // untrusted sandbox code cannot read OAST callbacks (steal tokens or
  // fabricate proof). The log is append-only: there is no clear endpoint.
  if (req.url === '/__mirage/log') {
    if (req.headers['x-mirage-token'] !== TOKEN) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(log));
    return;
  }

  // Record callback and return generic response
  log.push(entry);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
});

server.listen(8080, () => console.log('Mirage OAST listening on :8080'));

// --- DNS server ---
function getContainerIP() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const iface of ifs[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

const dns = dgram.createSocket('udp4');
dns.on('message', (msg, rinfo) => {
  try {
    const resp = buildDnsAResponse(msg, getContainerIP());
    if (resp) dns.send(resp, rinfo.port, rinfo.address);
  } catch (e) {
    // Malformed query — drop it.
  }
});
dns.bind(53, '0.0.0.0', () => console.log('Mirage DNS listening on :53'));
`.trim();

    const result = await this.dockerExec([
      'run', '-d',
      '--name', this.containerName,
      '--network', this.networkName,
      '--memory', '64m',
      '--cpus', '0.25',
      'node:20-alpine',
      'node', '-e', mirageScript,
    ], signal);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to start Mirage OAST: ${result.stderr}`);
    }

    this.running = true;

    // Discover the container's IP on the internal network so the sandbox can
    // point the target's DNS at Mirage (--dns), enabling *.shadow.local OAST
    // callbacks. Failure is non-fatal: without a discoverable IP, DNS-based
    // payloads won't resolve, but HTTP-only OAST interactions still work.
    try {
      const ipResult = await this.dockerExec([
        'inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
        this.containerName,
      ], signal);
      if (ipResult.exitCode === 0) {
        const ip = ipResult.stdout.trim();
        if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) this.containerIP = ip;
      }
    } catch {
      // ignore; containerIP stays null
    }
  }

  /**
   * Sync the callback log from the Mirage container's management endpoint.
   */
  async syncLog(signal?: AbortSignal): Promise<OastCallback[]> {
    signal?.throwIfAborted();
    if (!this.running) return [];

    const result = await this.dockerExec([
      'exec', this.containerName, 'wget', '-qO-',
      '--header', `x-mirage-token: ${this.managementToken}`,
      'http://localhost:8080/__mirage/log',
    ], signal);

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
                this.recordCallback(cb);
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

  /**
   * Execute a Docker command via execFile (NO shell).
   * Accepts an argument array starting with the Docker subcommand (e.g., ['run', '-d', ...]).
   * The 'docker' binary is prepended automatically.
   */
  private async dockerExec(
    args: string[],
    signal?: AbortSignal,
  ): Promise<{ exitCode: number; stderr: string; stdout: string }> {
    return new Promise((resolve, reject) => {
      this.dockerExecutor(
        'docker',
        args,
        { maxBuffer: 5 * 1024 * 1024, signal, timeout: 30_000 },
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
