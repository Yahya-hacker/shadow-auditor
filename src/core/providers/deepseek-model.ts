import type {CallbackManagerForLLMRun} from '@langchain/core/callbacks/manager';
import type {BaseMessage} from '@langchain/core/messages';
import type {ChatGenerationChunk, ChatResult} from '@langchain/core/outputs';

import {AIMessage} from '@langchain/core/messages';
import {ChatOpenAI} from '@langchain/openai';
import {AsyncLocalStorage} from 'node:async_hooks';

type ChatOpenAIFields = NonNullable<ConstructorParameters<typeof ChatOpenAI>[0]>;
type FetchImplementation = NonNullable<
  NonNullable<ChatOpenAIFields['configuration']>['fetch']
>;

const reasoningReplay = new AsyncLocalStorage<ReadonlyMap<number, string>>();

function replayState(messages: readonly BaseMessage[]): ReadonlyMap<number, string> {
  const state = new Map<number, string>();
  for (const [index, message] of messages.entries()) {
    if (!AIMessage.isInstance(message) || !message.tool_calls?.length) continue;
    const content = message.additional_kwargs.reasoning_content;
    if (typeof content === 'string' && content) state.set(index, content);
  }

  return state;
}

function replayingFetch(upstream: FetchImplementation): FetchImplementation {
  return async (
    input: Parameters<FetchImplementation>[0],
    init?: Parameters<FetchImplementation>[1],
  ) => {
    const state = reasoningReplay.getStore();
    if (!state?.size) return upstream(input, init);
    if (typeof init?.body !== 'string') {
      throw new TypeError('DeepSeek reasoning replay requires a serializable JSON request body.');
    }

    let body: unknown;
    try {
      body = JSON.parse(init.body) as unknown;
    } catch {
      throw new Error('DeepSeek reasoning replay received an invalid JSON request body.');
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      !Array.isArray((body as {messages?: unknown}).messages)
    ) {
      throw new Error('DeepSeek reasoning replay requires a Chat Completions messages array.');
    }

    const request = body as {messages: Array<Record<string, unknown>>};
    for (const [index, reasoningContent] of state) {
      const message = request.messages[index];
      if (!message || message.role !== 'assistant') {
        throw new Error('DeepSeek reasoning replay could not match an assistant tool-call message.');
      }

      message.reasoning_content = reasoningContent;
    }

    return upstream(input, {...init, body: JSON.stringify(request)});
  };
}

/**
 * ChatOpenAI understands DeepSeek response reasoning_content but does not
 * serialize that provider extension on later requests. DeepSeek requires the
 * exact opaque value after thinking-mode tool calls, so inject it at the HTTP
 * boundary without exposing it as ordinary assistant content.
 */
export class DeepSeekChatOpenAI extends ChatOpenAI {
  constructor(fields: ChatOpenAIFields) {
    const upstreamFetch = fields.configuration?.fetch ?? globalThis.fetch;
    super({
      ...fields,
      configuration: {
        ...fields.configuration,
        fetch: replayingFetch(upstreamFetch),
      },
    });
  }

  override _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    return reasoningReplay.run(
      replayState(messages),
      () => super._generate(messages, options, runManager),
    );
  }

  override async *_streamChatModelEvents(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ) {
    const state = replayState(messages);
    const iterator = super._streamChatModelEvents(messages, options, runManager);
    while (true) {
      const next = await reasoningReplay.run(state, () => iterator.next());
      if (next.done) return;
      yield next.value;
    }
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const state = replayState(messages);
    const iterator = super._streamResponseChunks(messages, options, runManager);
    while (true) {
      const next = await reasoningReplay.run(state, () => iterator.next());
      if (next.done) return;
      yield next.value;
    }
  }
}
