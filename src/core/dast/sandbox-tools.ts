/**
 * Sandbox Tools - Agent-facing tools for DAST sandbox operations.
 *
 * Provides the verifier and exploit-analyst agents with tools to:
 * - Execute commands inside the sandboxed target container
 * - Deploy the target application
 * - Check sandbox and Mirage OAST status
 * - Query OAST callback logs for exploit validation
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import { type SandboxManager } from './sandbox-manager.js';

// =============================================================================
// Tool Factory
// =============================================================================

export interface SandboxToolsOptions {
  sandboxManager: SandboxManager;
}

/**
 * Create agent-facing sandbox tools for verifier and exploit-analyst roles.
 */
export function createSandboxTools(options: SandboxToolsOptions): ToolSet {
  const { sandboxManager } = options;
  const mirage = sandboxManager.getMirage();

  return {
    check_oast_logs: tool<{ domain?: string; token?: string }, string>({
      description: [
        'Query the Mirage OAST callback log to check if the target application',
        'made an outbound request to a specific domain or OAST token.',
        'A confirmed OAST callback constitutes cryptographic proof of exploitability',
        'for SSRF, Blind RCE, DNS exfiltration, and similar vulnerabilities.',
        'Provide either a domain filter (e.g., "oast-abc123.shadow.local") or a token.',
      ].join(' '),

      async execute({ domain, token }) {
        // Sync latest logs from the Mirage container
        await mirage.syncLog();

        const filter = domain ?? token ?? '';
        const callbacks = filter
          ? mirage.getCallbacksForDomain(filter)
          : mirage.getCallbackLog();

        return JSON.stringify({
          callbackCount: callbacks.length,
          callbacks: callbacks.slice(0, 20).map((cb) => ({
            method: cb.method,
            timestamp: cb.timestamp,
            url: cb.url,
          })),
          filter: filter || '<all>',
          hasCallback: callbacks.length > 0,
        }, null, 2);
      },

      inputSchema: z.object({
        domain: z.string().optional().describe('Domain to filter callbacks by'),
        token: z.string().optional().describe('OAST token to check'),
      }),
    }),

    sandbox_deploy: tool<{ startCommand?: string }, string>({
      description: [
        'Start the target application inside the DAST sandbox container.',
        'Optionally provide a start command override (e.g., "npm start").',
        'The application will be deployed on the internal shadow-net Docker',
        'network with all outbound traffic routed through the Mirage OAST proxy.',
      ].join(' '),

      async execute({ startCommand }) {
        try {
          if (!sandboxManager.isRunning()) {
            await sandboxManager.create();
          }

          const result = await sandboxManager.deploy();
          return result;
        } catch (error) {
          return `[ERROR] Sandbox deploy failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      },

      inputSchema: z.object({
        startCommand: z.string().optional().describe('Override start command for the target app'),
      }),
    }),

    sandbox_exec: tool<{ command: string }, string>({
      description: [
        'Execute a command inside the DAST sandbox target container.',
        'Use this to run exploit payloads (e.g., curl commands, Python scripts)',
        'against the target application in a safe, isolated environment.',
        'All outbound DNS/HTTP is intercepted by the Mirage OAST proxy.',
        'Returns stdout, stderr, exit code, and execution duration.',
      ].join(' '),

      async execute({ command }) {
        try {
          if (!sandboxManager.isRunning()) {
            return '[ERROR] Sandbox is not running. Call sandbox_deploy first.';
          }

          const result = await sandboxManager.exec(command);

          return JSON.stringify({
            command: result.command,
            durationMs: result.durationMs,
            exitCode: result.exitCode,
            stderr: result.stderr.slice(0, 3000),
            stdout: result.stdout.slice(0, 5000),
          }, null, 2);
        } catch (error) {
          return `[ERROR] Sandbox exec failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      },

      inputSchema: z.object({
        command: z.string().min(1).describe('Shell command to execute inside the sandbox'),
      }),
    }),

    sandbox_status: tool<Record<string, never>, string>({
      description: [
        'Check the status of the DAST sandbox environment.',
        'Returns whether the target container and Mirage OAST proxy are running,',
        'the network name, and the count of OAST callbacks captured so far.',
      ].join(' '),

      async execute() {
        try {
          const status = await sandboxManager.status();

          return JSON.stringify({
            containerRunning: status.containerRunning,
            mirageRunning: status.mirageRunning,
            networkName: status.networkName,
            oastCallbackCount: status.oastCallbackCount,
          }, null, 2);
        } catch (error) {
          return `[ERROR] Status check failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      },

      inputSchema: z.object({}),
    }),
  };
}
