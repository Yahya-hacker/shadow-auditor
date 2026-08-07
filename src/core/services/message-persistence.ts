/**
 * Message Persistence — conversation history recording to RunArtifacts.
 *
 * Centralises the logic for persisting agent/user messages and tool
 * call/result events so AgentSession stays focused on orchestration.
 */

import type { ModelMessage, StepResult, ToolSet } from 'ai';

import { RunArtifacts } from '../run-artifacts.js';

function normalizeRole(role: string): 'assistant' | 'system' | 'tool' | 'user' {
  if (role === 'assistant' || role === 'tool' || role === 'user') {
    return role;
  }

  return 'system';
}

/**
 * Persist a batch of Vercel-AI-SDK messages to the run-artifacts JSONL
 * log. Each message is stored as a `{ role, content, timestamp }` record.
 */
export async function persistMessages(
  artifacts: null | RunArtifacts,
  messages: ModelMessage[],
): Promise<void> {
  if (!artifacts) {
    return;
  }

  for (const message of messages) {
    await artifacts.recordMessage({
      content: structuredClone(message.content),
      role: normalizeRole(message.role),
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Persist tool call/result events from all steps of a stream response.
 */
export async function persistToolEvents(
  artifacts: null | RunArtifacts,
  steps: Array<StepResult<ToolSet>>,
): Promise<void> {
  if (!artifacts) {
    return;
  }

  for (const step of steps) {
    for (const toolCall of step.toolCalls) {
      await artifacts.recordToolEvent({
        data: toolCall.input,
        event: 'call',
        timestamp: new Date().toISOString(),
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
      });
    }

    for (const toolResult of step.toolResults) {
      await artifacts.recordToolEvent({
        data: toolResult.output,
        event: 'result',
        timestamp: new Date().toISOString(),
        toolCallId: toolResult.toolCallId,
        toolName: toolResult.toolName,
      });
    }
  }
}
