import type { BaseMessage } from '@langchain/core/messages';

import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';

const PRIVATE_ASSISTANT_BLOCK_TYPES = new Set([
  'reasoning',
  'reasoning-delta',
  'reasoning_delta',
  'redacted_thinking',
  'thinking',
]);

const PROVIDER_REPLAY_METADATA = new Set([
  'output',
  'output_version',
  'reasoning',
  'reasoning_content',
  'thought_signature',
  'thought_signatures',
]);

function normalizeAssistantContent(
  content: BaseMessage['content'],
): AIMessage['content'] {
  if (!Array.isArray(content)) return content;

  return content.flatMap((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return [];

    const record = part as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : undefined;
    if (type && PRIVATE_ASSISTANT_BLOCK_TYPES.has(type)) return [];
    if (
      (type === 'text' || type === 'input_text' || type === undefined) &&
      typeof record.text === 'string'
    ) {
      return [{text: record.text, type: 'text' as const}];
    }

    // Canonical tool calls are retained on AIMessage.tool_calls. Replaying
    // provider-native blocks here duplicates calls or sends unsupported unions
    // to OpenAI-compatible Chat Completions endpoints.
    return [];
  });
}

function normalizeOpenAICompatibleText(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.flatMap((part) => {
    if (typeof part === 'string') return [part];
    if (!part || typeof part !== 'object') return [];
    const record = part as Record<string, unknown>;
    return typeof record.text === 'string' ? [record.text] : [];
  }).join('');
}

function stripProviderMetadata(
  metadata: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const normalized = {...metadata};
  for (const key of PROVIDER_REPLAY_METADATA) delete normalized[key];
  return normalized;
}

function normalizeQwenToolCalls(message: AIMessage): AIMessage['tool_calls'] {
  return message.tool_calls?.map((call) => {
    let args: unknown = call.args;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args) as unknown;
      } catch (error) {
        throw new TypeError(
          `Qwen tool "${call.name}" emitted invalid JSON arguments.`,
          {cause: error},
        );
      }
    }

    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new TypeError(
        `Qwen tool "${call.name}" arguments must be a JSON object.`,
      );
    }

    return {...call, args: {...args as Record<string, unknown>}};
  });
}

function qwenMetadata(
  metadata: Readonly<Record<string, unknown>>,
  removeToolCalls = false,
): Record<string, unknown> {
  const normalized = stripProviderMetadata(metadata);
  if (removeToolCalls) delete normalized.tool_calls;
  return normalized;
}

function normalizeQwenHistoryMessage(message: BaseMessage): BaseMessage {
  const content = normalizeOpenAICompatibleText(message.content);
  const common = {
    additional_kwargs: qwenMetadata(message.additional_kwargs),
    content,
    id: message.id,
    name: message.name,
    response_metadata: qwenMetadata(message.response_metadata),
  };

  if (AIMessage.isInstance(message)) {
    const toolCalls = normalizeQwenToolCalls(message);
    return new AIMessage({
      ...common,
      additional_kwargs: qwenMetadata(message.additional_kwargs, Boolean(toolCalls?.length)),
      invalid_tool_calls: message.invalid_tool_calls,
      tool_calls: toolCalls,
      usage_metadata: message.usage_metadata,
    });
  }

  if (ToolMessage.isInstance(message)) {
    return new ToolMessage({
      ...common,
      artifact: message.artifact,
      metadata: message.metadata,
      status: message.status,
      tool_call_id: message.tool_call_id,
    });
  }

  if (message._getType() === 'human') return new HumanMessage(common);
  if (message._getType() === 'system') return new SystemMessage(common);
  return message;
}

function carriesOpenAIResponsesReplayState(
  message: BaseMessage,
  providerHint?: string,
): boolean {
  const provider = providerHint?.trim().toLowerCase();
  if (provider !== 'openai' && provider !== 'azure' && provider !== 'microsoft-foundry') {
    return false;
  }

  const responseMetadata = message.response_metadata as Record<string, unknown>;
  const output = responseMetadata.output;
  return responseMetadata.output_version === 'v1' && (
    (Array.isArray(output) && output.some((item) => typeof item === 'object' && item !== null
        && (item as {type?: unknown}).type === 'reasoning'))
    || (
      typeof message.additional_kwargs.reasoning === 'object'
      && message.additional_kwargs.reasoning !== null
    )
  );
}

/**
 * Rebuild an assistant message into the portable LangChain history contract.
 *
 * Checkpoints can contain Responses API reasoning items, Anthropic thinking
 * blocks, or Gemini thought signatures. Those blocks are output artifacts, not
 * portable chat input, and several OpenAI-compatible providers reject them.
 * Public text and canonical tool calls remain intact; private reasoning is
 * deliberately not converted into user-visible text.
 */
export function normalizeAssistantHistoryMessage(
  message: BaseMessage,
  providerHint?: string,
): BaseMessage {
  const provider = providerHint?.trim().toLowerCase();
  if (provider === 'qwen') return normalizeQwenHistoryMessage(message);
  if (message._getType() !== 'ai') return message;
  // These providers require opaque signed/thinking state to be replayed
  // unchanged for valid multi-turn tool continuations. DeepSeek explicitly
  // requires reasoning_content after a thinking-mode tool call.
  if (
    provider === 'anthropic' ||
    provider === 'google' ||
    provider === 'moonshot' ||
    carriesOpenAIResponsesReplayState(message, provider)
  ) {
    return message;
  }

  const aiMessage = message as AIMessage;
  if (provider === 'deepseek') {
    const additionalKwargs = stripProviderMetadata(message.additional_kwargs);
    const reasoningContent = message.additional_kwargs.reasoning_content;
    if (typeof reasoningContent === 'string') {
      additionalKwargs.reasoning_content = reasoningContent;
    }

    return new AIMessage({
      additional_kwargs: additionalKwargs,
      content: normalizeAssistantContent(message.content),
      id: message.id,
      name: message.name,
      response_metadata: stripProviderMetadata(message.response_metadata),
      tool_calls: aiMessage.tool_calls,
      usage_metadata: aiMessage.usage_metadata,
    });
  }

  return new AIMessage({
    additional_kwargs: stripProviderMetadata(message.additional_kwargs),
    content: normalizeAssistantContent(message.content),
    id: message.id,
    name: message.name,
    response_metadata: stripProviderMetadata(message.response_metadata),
    tool_calls: aiMessage.tool_calls,
    usage_metadata: aiMessage.usage_metadata,
  });
}

export function normalizeModelHistory(
  messages: readonly BaseMessage[],
  providerHint?: string,
): BaseMessage[] {
  return messages.map((message) => normalizeAssistantHistoryMessage(message, providerHint));
}
