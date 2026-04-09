import {
  type FinishReason,
  hasToolCall,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  type StepResult,
  streamText,
  type ToolSet,
} from 'ai';

export const CONTINUATION_PROMPT = 'Continue exactly where you left off. Do not repeat content.';

/**
 * Returns a stopWhen predicate array for use in streamText.
 * Stops the tool loop when either:
 *   1. The step budget is exhausted (stepCountIs), OR
 *   2. The agent explicitly calls the `finish_task` tool (hasToolCall)
 *
 * This implements the "stopWhen: finish_task" agentic capability from the
 * problem statement, enabling the agent to self-terminate when goals are met.
 */
export function buildStopConditions(maxToolSteps: number) {
  return [stepCountIs(maxToolSteps), hasToolCall('finish_task')];
}

export interface StreamWithContinuationOptions<TOOLS extends ToolSet> {
  maxContinuations?: number;
  maxOutputTokens: number;
  maxToolSteps: number;
  messages: ModelMessage[];
  model: LanguageModel;
  onChunk: (chunk: string) => void;
  systemPrompt: string;
  tools: TOOLS;
}

export interface StreamWithContinuationResult<TOOLS extends ToolSet> {
  continuationCount: number;
  finishReason: FinishReason;
  messagesDelta: ModelMessage[];
  rawFinishReason: string | undefined;
  steps: Array<StepResult<TOOLS>>;
  text: string;
}

function overlapLength(base: string, addition: string): number {
  const maxWindow = Math.min(base.length, addition.length, 2000);
  for (let length = maxWindow; length >= 16; length--) {
    if (base.endsWith(addition.slice(0, length))) {
      return length;
    }
  }

  return 0;
}

export function stitchResponseChunks(base: string, addition: string): string {
  if (!base) {
    return addition;
  }

  if (!addition || base.endsWith(addition)) {
    return base;
  }

  const overlap = overlapLength(base, addition);
  if (overlap > 0) {
    return `${base}${addition.slice(overlap)}`;
  }

  return `${base}${addition}`;
}

export function isTruncatedResponse(finishReason: FinishReason, rawFinishReason?: string): boolean {
  if (finishReason === 'length') {
    return true;
  }

  if (!rawFinishReason) {
    return false;
  }

  return /(length|max[_\s-]?tokens?|token[_\s-]?limit)/i.test(rawFinishReason);
}

function convertStepToMessages<TOOLS extends ToolSet>(step: StepResult<TOOLS>): ModelMessage[] {
  const messages: ModelMessage[] = [];

  if (step.text || step.toolCalls.length > 0) {
    if (step.toolCalls.length === 0 && step.text) {
      messages.push({
        content: step.text,
        role: 'assistant',
      });
    } else {
      const assistantContent: Array<Record<string, unknown>> = [];

      if (step.text) {
        assistantContent.push({
          text: step.text,
          type: 'text',
        });
      }

      for (const toolCall of step.toolCalls) {
        assistantContent.push({
          input: toolCall.input,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          type: 'tool-call',
        });
      }

      messages.push({
        content: assistantContent,
        role: 'assistant',
      } as ModelMessage);
    }
  }

  for (const toolResult of step.toolResults) {
    messages.push({
      content: [
        {
          output: toolResult.output,
          toolCallId: toolResult.toolCallId,
          toolName: toolResult.toolName,
          type: 'tool-result',
        },
      ],
      role: 'tool',
    } as unknown as ModelMessage);
  }

  return messages;
}

export async function streamWithContinuation<TOOLS extends ToolSet>({
  maxContinuations = 2,
  maxOutputTokens,
  maxToolSteps,
  messages,
  model,
  onChunk,
  systemPrompt,
  tools,
}: StreamWithContinuationOptions<TOOLS>): Promise<StreamWithContinuationResult<TOOLS>> {
  const workingMessages = [...messages];
  const allSteps: Array<StepResult<TOOLS>> = [];
  let continuationCount = 0;
  let finalFinishReason: FinishReason = 'stop';
  let finalRawFinishReason: string | undefined;
  let stitchedText = '';

  while (true) {
    const result = streamText({
      maxOutputTokens,
      messages: workingMessages,
      model,
      stopWhen: buildStopConditions(maxToolSteps),
      system: systemPrompt,
      tools,
    });

    let currentChunkText = '';
    for await (const chunk of result.textStream) {
      currentChunkText += chunk;
      if (continuationCount === 0) {
        stitchedText += chunk;
        onChunk(chunk);
      }
    }

    const [steps, finishReason, rawFinishReason] = await Promise.all([
      result.steps,
      result.finishReason,
      result.rawFinishReason,
    ]);

    allSteps.push(...steps);
    if (steps.length === 0 && currentChunkText) {
      workingMessages.push({
        content: currentChunkText,
        role: 'assistant',
      });
    } else {
      for (const step of steps) {
        workingMessages.push(...convertStepToMessages(step));
      }
    }

    if (continuationCount > 0) {
      const merged = stitchResponseChunks(stitchedText, currentChunkText);
      const delta = merged.slice(stitchedText.length);
      if (delta) {
        onChunk(delta);
      }

      stitchedText = merged;
    }

    finalFinishReason = finishReason;
    finalRawFinishReason = rawFinishReason;

    if (!isTruncatedResponse(finishReason, rawFinishReason) || continuationCount >= maxContinuations) {
      break;
    }

    continuationCount += 1;
    workingMessages.push({
      content: CONTINUATION_PROMPT,
      role: 'user',
    });
  }

  if (allSteps.length === 0) {
    workingMessages.push({
      content: stitchedText,
      role: 'assistant',
    });
  }

  return {
    continuationCount,
    finishReason: finalFinishReason,
    messagesDelta: workingMessages.slice(messages.length),
    rawFinishReason: finalRawFinishReason,
    steps: allSteps,
    text: stitchedText,
  };
}
