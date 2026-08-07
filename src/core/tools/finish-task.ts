import { z } from 'zod';

/**
 * Creates a finish_task tool that the agent calls to signal task completion.
 *
 * The shared LangChain tool executor treats a successful call as terminal,
 * allowing the agent to end its loop before consuming the remaining budget.
 */
export function createFinishTaskTool() {
  return {
    description:
      'Signal that the current analysis task is fully complete. ' +
      'Call this ONLY after all findings have been recorded, verified, and there is nothing more to investigate. ' +
      'This terminates the tool-use loop immediately — do not call it prematurely. ' +
      'Include a concise summary of what was accomplished, key findings, and any recommendations.\n\n' +
      'USAGE: { summary: "Found 3 vulnerabilities: SQL injection in login.ts (CWE-89), XSS in profile.tsx (CWE-79), hardcoded API key in config.ts (CWE-798). All verified with code evidence." }\n' +
      'CHECKLIST before calling: Have you verified each finding? Have you recorded all evidence? Is there any unexplored attack surface?',
    execute: ({ summary }: { summary: string }) => [
      `── finish_task ── Analysis complete ──`,
      summary,
      '',
      `✅ Task finished. The agent loop will now terminate.`,
    ].join('\n'),
    inputSchema: z.object({
      summary: z
        .string()
        .min(1, 'Summary cannot be empty.')
        .describe('Concise summary of what was accomplished, key findings with CWE IDs and file paths, and any recommendations.'),
    }),
  };
}
