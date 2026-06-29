import { tool } from 'ai';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

import { confirmCommandExecution } from '../../utils/human-in-loop.js';
import { type CommandPolicyConfig, evaluateCommandPolicy } from '../policy/command-policy.js';

const execAsync = promisify(exec);

export interface BashToolOptions {
  commandPolicy: CommandPolicyConfig;
  workingDirectory: string;
}

/**
 * Creates a bash tool that provides a safe, controlled interface for Unix shell commands.
 * Enables the agent to chain standard Unix tools (grep, sed, jq, awk, find, etc.)
 * without coding each operation from scratch. All commands are policy-gated,
 * sandboxed to the workspace, and audit-logged via the tool-events pipeline.
 */
export function createBashTool(options: BashToolOptions) {
  return tool({
    description:
      'Execute Unix shell commands for repository inspection and security analysis. ' +
      'Supports piping with read-only analysis tools: grep, sed, jq, awk, find, cat, head, tail, wc, sort, uniq, cut, tr, diff, file, stat. ' +
      'All commands run sandboxed in the target workspace directory. ' +
      'Prefer list_directory and search_codebase for simple tasks; use bash for complex piped analysis. ' +
      'Commands that could modify the filesystem require user confirmation.',
    async execute({ command, timeout = 30 }: { command: string; timeout?: number }) {
      const trimmed = command.trim();

      // Policy check — rejects destructive patterns and validates the command surface
      const policyDecision = evaluateCommandPolicy(trimmed, options.commandPolicy);
      if (!policyDecision.allowed) {
        return policyDecision.reason;
      }

      // Require human confirmation whenever the policy signals a warning (non-allowlisted or dangerous)
      if (policyDecision.warning) {
        const confirmed = await confirmCommandExecution(trimmed, policyDecision.warning);
        if (!confirmed) {
          return `[DENIED] User denied command execution: "${trimmed}".`;
        }
      }

      const startedAt = new Date().toISOString();
      const startMs = Date.now();

      try {
        const { stderr, stdout } = await execAsync(trimmed, {
          cwd: options.workingDirectory,
          maxBuffer: 10 * 1024 * 1024,
          timeout: timeout * 1000,
        });

        const elapsedMs = Date.now() - startMs;
        let output = `// ─── BASH: ${trimmed} [${startedAt}] (${elapsedMs}ms) ───\n`;

        if (stdout.trim()) {
          output += `\n[STDOUT]\n${stdout.trim()}`;
        }

        if (stderr.trim()) {
          output += `\n\n[STDERR]\n${stderr.trim()}`;
        }

        if (!stdout.trim() && !stderr.trim()) {
          output += '\n[INFO] Command completed with no output.';
        }

        return output;
      } catch (error: unknown) {
        const elapsedMs = Date.now() - startMs;
        const execError = error as { code?: number; message: string; stderr?: string; stdout?: string };
        let output = `// ─── BASH FAILED: ${trimmed} [${startedAt}] (${elapsedMs}ms) ───\n\n[ERROR] ${execError.message}`;

        if (execError.stdout?.trim()) {
          output += `\n\n[STDOUT]\n${execError.stdout.trim()}`;
        }

        if (execError.stderr?.trim()) {
          output += `\n\n[STDERR]\n${execError.stderr.trim()}`;
        }

        return output;
      }
    },
    inputSchema: z.object({
      command: z
        .string()
        .min(1, 'Command cannot be empty.')
        .max(2000, 'Command exceeds maximum length of 2000 characters.')
        .describe(
          'Unix shell command to execute. Supports piping: e.g., "grep -rn eval src/ | head -20" or "cat package.json | jq .dependencies".',
        ),
      timeout: z
        .number()
        .int()
        .positive()
        .max(120)
        .optional()
        .describe('Timeout in seconds (default: 30, max: 120).'),
    }),
  });
}
