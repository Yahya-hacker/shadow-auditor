import { tool } from 'ai';
import { z } from 'zod';

/**
 * Creates a finish_task tool that the agent calls to signal task completion.
 *
 * When combined with `hasToolCall('finish_task')` as a stopWhen predicate in
 * `streamWithContinuation`, this enables the agent to self-terminate its
 * multi-step tool loop once all analysis goals have been met — without waiting
 * for the step budget to be fully consumed.
 *
 * Usage pattern:
 *   stopWhen: [stepCountIs(maxToolSteps), hasToolCall('finish_task')]
 */
export function createFinishTaskTool() {
  return tool({
    description:
      'Signal that the current analysis task is fully complete. ' +
      'Call this ONLY after all findings have been recorded, the report is generated, and there is nothing more to investigate. ' +
      'This terminates the tool-use loop immediately — do not call it prematurely. ' +
      'Include a concise summary of what was accomplished.',
    execute: ({ summary }: { summary: string }) => `[TASK_COMPLETE] ${summary}`,
    inputSchema: z.object({
      summary: z
        .string()
        .min(1, 'Summary cannot be empty.')
        .max(1000, 'Summary exceeds maximum length of 1000 characters.')
        .describe('Concise summary of what was accomplished (max 1000 characters).'),
    }),
  });
}
