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

import { type SignedExecutionEvidenceStore } from './evidence-store.js';
import { type SandboxManager } from './sandbox-manager.js';

// =============================================================================
// Tool Factory
// =============================================================================

export interface SandboxToolsOptions {
  evidenceStore?: SignedExecutionEvidenceStore;
  sandboxManager: SandboxManager;
}

/**
 * Create agent-facing sandbox tools for verifier and exploit-analyst roles.
 */
export function createSandboxTools(options: SandboxToolsOptions): ToolSet {
  const {evidenceStore, sandboxManager} = options;
  const mirage = sandboxManager.getMirage();
  const sandboxExecInputSchema = z.object({
    command: z.string().min(1).describe('Shell command to execute inside the sandbox'),
    findingId: z.string().min(1).max(200).optional().describe(
      'Exact SAST candidate finding ID this execution validates.',
    ),
  }).superRefine((value, context) => {
    if (evidenceStore && !value.findingId) {
      context.addIssue({
        code: 'custom',
        message: 'findingId is required when signed execution evidence is enabled.',
        path: ['findingId'],
      });
    }
  });

  return {
    check_oast_logs: tool({
      description: [
        'Query the Mirage OAST callback log to check if the target application',
        'made an outbound request to a specific domain or OAST token.',
        'A confirmed OAST callback constitutes cryptographic proof of exploitability',
        'for SSRF, Blind RCE, DNS exfiltration, and similar vulnerabilities.',
        'Provide either a domain filter (e.g., "oast-abc123.shadow.local") or a token.',
      ].join(' '),

      async execute({ domain, token }, executionOptions) {
        executionOptions.abortSignal?.throwIfAborted();
        // Sync latest logs from the Mirage container
        await mirage.syncLog(executionOptions.abortSignal);

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

    sandbox_deploy: tool({
      description: [
        'Start the target application inside the DAST sandbox container.',
        'Optionally provide a start command override (e.g., "npm start").',
        'The application will be deployed on the internal shadow-net Docker',
        'network with all outbound traffic routed through the Mirage OAST proxy.',
      ].join(' '),

      async execute({ startCommand }, executionOptions) {
        try {
          if (!sandboxManager.isRunning()) {
            await sandboxManager.create(executionOptions.abortSignal);
          }

          const result = await sandboxManager.deploy(executionOptions.abortSignal, startCommand);
          return result;
        } catch (error) {
          executionOptions.abortSignal?.throwIfAborted();
          return `[ERROR] Sandbox deploy failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      },

      inputSchema: z.object({
        startCommand: z.string().optional().describe('Override start command for the target app'),
      }),
    }),

    sandbox_exec: tool({
      description: [
        'Execute a command inside the DAST sandbox target container.',
        'Use this to run exploit payloads (e.g., curl commands, Python scripts)',
        'against the target application in a safe, isolated environment.',
        'All outbound DNS/HTTP is intercepted by the Mirage OAST proxy.',
        'Returns stdout, stderr, exit code, and execution duration.',
      ].join(' '),

      async execute({command, findingId}, executionOptions) {
        try {
          if (!sandboxManager.isRunning()) {
            return '[ERROR] Sandbox is not running. Call sandbox_deploy first.';
          }

          const result = await sandboxManager.exec(command, executionOptions.abortSignal);
          const evidenceArtifact = evidenceStore
            ? await evidenceStore.recordSandboxExecution(findingId!, result)
            : undefined;

          return JSON.stringify({
            command: result.command,
            durationMs: result.durationMs,
            evidenceArtifact: evidenceArtifact && {
              artifactId: evidenceArtifact.artifactId,
              digest: evidenceArtifact.digest,
              findingId: evidenceArtifact.findingId,
              publicKeyFingerprint: evidenceArtifact.publicKeyFingerprint,
              signatureAlgorithm: evidenceArtifact.signatureAlgorithm,
            },
            exitCode: result.exitCode,
            stderr: result.stderr.slice(0, 3000),
            stdout: result.stdout.slice(0, 5000),
          }, null, 2);
        } catch (error) {
          executionOptions.abortSignal?.throwIfAborted();
          return `[ERROR] Sandbox exec failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      },

      inputSchema: sandboxExecInputSchema,
    }),

    sandbox_status: tool({
      description: [
        'Check the status of the DAST sandbox environment.',
        'Returns whether the target container and Mirage OAST proxy are running,',
        'the network name, and the count of OAST callbacks captured so far.',
      ].join(' '),

      async execute(_input, executionOptions) {
        try {
          executionOptions.abortSignal?.throwIfAborted();
          const status = await sandboxManager.status(executionOptions.abortSignal);

          return JSON.stringify({
            containerRunning: status.containerRunning,
            mirageRunning: status.mirageRunning,
            networkName: status.networkName,
            oastCallbackCount: status.oastCallbackCount,
          }, null, 2);
        } catch (error) {
          executionOptions.abortSignal?.throwIfAborted();
          return `[ERROR] Status check failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      },

      inputSchema: z.object({}),
    }),
  };
}
