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
  return {
    description:
      'Execute Unix shell commands for repository inspection and security analysis. ' +
      'Supports piping with read-only analysis tools: grep, sed, jq, awk, find, cat, head, tail, wc, sort, uniq, cut, tr, diff, file, stat. ' +
      'All commands run sandboxed in the target workspace directory. ' +
      'Prefer list_directory and search_codebase for simple tasks; use bash for complex piped analysis. ' +
      'Commands that could modify the filesystem require user confirmation.\n\n' +
      'USAGE EXAMPLES:\n' +
      '- "grep -rn "eval\\\\s*(" src/ | head -20" — find eval() calls with context\n' +
      '- "find . -name "*.sql" -exec grep -l "SELECT.*+" {} \\;" — find SQL files with concatenation\n' +
      '- "cat package.json | jq .dependencies" — inspect project dependencies\n' +
      '- "npm audit --json 2>/dev/null | jq .vulnerabilities" — check known CVEs\n' +
      'CHAIN: After finding matches with bash, use read_file_content with startLine/endLine to inspect specific files.\n' +
      'AVOID: Don\'t use bash for simple searches that search_codebase can handle faster.',
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
        const stdoutTrimmed = stdout.trim();
        const stderrTrimmed = stderr.trim();

        const lines: string[] = [
          `── bash ── ${trimmed.slice(0, 60)}${trimmed.length > 60 ? '...' : ''} ── ${elapsedMs}ms ──`,
        ];

        if (stdoutTrimmed) {
          // Truncate very long output
          const maxLines = 100;
          const outLines = stdoutTrimmed.split('\n');
          if (outLines.length > maxLines) {
            lines.push(outLines.slice(0, maxLines).join('\n'));
            lines.push(`... ${outLines.length - maxLines} more lines omitted`);
            lines.push(`💡 Pipe through head/tail or use more specific grep patterns to narrow results.`);
          } else {
            lines.push(stdoutTrimmed);
          }
        }

        if (stderrTrimmed) {
          lines.push(`[STDERR]`);
          lines.push(stderrTrimmed.split('\n').slice(0, 20).join('\n'));
        }

        if (!stdoutTrimmed && !stderrTrimmed) {
          lines.push('[INFO] Command completed with no output.');
        }

        return lines.join('\n');
      } catch (error: unknown) {
        const elapsedMs = Date.now() - startMs;
        const execError = error as { code?: number; message: string; stderr?: string; stdout?: string };

        const lines: string[] = [
          `── bash ── FAILED: ${trimmed.slice(0, 60)}${trimmed.length > 60 ? '...' : ''} ── ${elapsedMs}ms ──`,
          `[ERROR] ${execError.message}`,
        ];

        if (execError.stdout?.trim()) {
          lines.push(`[STDOUT]\n${execError.stdout.trim().split('\n').slice(0, 30).join('\n')}`);
        }

        if (execError.stderr?.trim()) {
          lines.push(`[STDERR]\n${execError.stderr.trim().split('\n').slice(0, 20).join('\n')}`);
        }

        return lines.join('\n');
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
  };
}
