import {AIMessage, HumanMessage, ToolMessage} from '@langchain/core/messages';
import {expect} from 'chai';

import {DeepSeekChatOpenAI} from '../src/core/providers/deepseek-model.js';

describe('DeepSeek chat model', () => {
  it('replays opaque reasoning_content after a thinking-mode tool call', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const model = new DeepSeekChatOpenAI({
      apiKey: 'test-key',
      configuration: {
        baseURL: 'https://deepseek.invalid/v1',
        async fetch(_input, init) {
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({
            choices: [{
              finish_reason: 'stop',
              index: 0,
              message: {content: 'done', role: 'assistant'},
            }],
            created: 1,
            id: 'response-1',
            model: 'deepseek-v4-pro',
            object: 'chat.completion',
            usage: {completion_tokens: 1, prompt_tokens: 1, total_tokens: 2},
          }), {
            headers: {'content-type': 'application/json'},
            status: 200,
          });
        },
      },
      model: 'deepseek-v4-pro',
    });
    const assistant = new AIMessage({
      additional_kwargs: {reasoning_content: 'opaque-state'},
      content: '',
      tool_calls: [{
        args: {filePath: 'src/index.ts'},
        id: 'call-1',
        name: 'read_file_content',
        type: 'tool_call',
      }],
    });

    await model.invoke([
      new HumanMessage('Inspect the file.'),
      assistant,
      new ToolMessage({
        content: 'source',
        tool_call_id: 'call-1',
      }),
    ]);

    const messages = requestBody?.messages as Array<Record<string, unknown>>;
    expect(messages[1]).to.include({
      reasoning_content: 'opaque-state',
      role: 'assistant',
    });
  });

  it('replays opaque reasoning_content through v3 stream events', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const model = new DeepSeekChatOpenAI({
      apiKey: 'test-key',
      configuration: {
        baseURL: 'https://deepseek.invalid/v1',
        async fetch(_input, init) {
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          const chunk = {
            choices: [{
              delta: {content: 'done'},
              finish_reason: 'stop',
              index: 0,
            }],
            created: 1,
            id: 'response-stream-1',
            model: 'deepseek-v4-pro',
            object: 'chat.completion.chunk',
          };
          return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
            headers: {'content-type': 'text/event-stream'},
            status: 200,
          });
        },
      },
      model: 'deepseek-v4-pro',
    });
    const assistant = new AIMessage({
      additional_kwargs: {reasoning_content: 'opaque-stream-state'},
      content: '',
      tool_calls: [{
        args: {filePath: 'src/index.ts'},
        id: 'call-stream-1',
        name: 'read_file_content',
        type: 'tool_call',
      }],
    });

    for await (const _event of model.streamEvents([
      new HumanMessage('Inspect the file.'),
      assistant,
      new ToolMessage({content: 'source', tool_call_id: 'call-stream-1'}),
    ])) {
      // Consume the stream so the HTTP request and replay adapter run.
    }

    const messages = requestBody?.messages as Array<Record<string, unknown>>;
    expect(messages[1]).to.include({
      reasoning_content: 'opaque-stream-state',
      role: 'assistant',
    });
  });
});
