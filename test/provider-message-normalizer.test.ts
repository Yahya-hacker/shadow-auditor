import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import {expect} from 'chai';

import {
  normalizeAssistantHistoryMessage,
  normalizeModelHistory,
} from '../src/core/providers/message-normalizer.js';

describe('provider message normalizer', () => {
  it('preserves DeepSeek reasoning state required after thinking-mode tool calls', () => {
    const message = new AIMessage({
      additional_kwargs: {reasoning_content: 'opaque provider state'},
      content: '',
      tool_calls: [{
        args: {filePath: 'src/index.ts'},
        id: 'call_deepseek',
        name: 'read_file_content',
        type: 'tool_call',
      }],
    });

    const normalized = normalizeAssistantHistoryMessage(message, 'deepseek');
    if (!AIMessage.isInstance(normalized)) throw new Error('Expected an AI message.');

    expect(normalized.additional_kwargs.reasoning_content).to.equal('opaque provider state');
    expect(normalized.tool_calls).to.deep.equal(message.tool_calls);
  });

  it('continues stripping non-portable reasoning from generic providers', () => {
    const message = new AIMessage({
      additional_kwargs: {reasoning_content: 'private state'},
      content: [{text: 'public answer', type: 'text'}],
    });

    const normalized = normalizeAssistantHistoryMessage(message, 'custom');
    if (!AIMessage.isInstance(normalized)) throw new Error('Expected an AI message.');

    expect(normalized.additional_kwargs).not.to.have.property('reasoning_content');
    expect(normalized.content).to.deep.equal([{text: 'public answer', type: 'text'}]);
  });

  it('replays Qwen assistant blocks as text with canonical tool-call mappings', () => {
    const message = new AIMessage({
      additional_kwargs: {reasoning_content: 'private'},
      content: [
        {text: 'Reading ', type: 'text'},
        {text: 'the file.', type: 'text'},
        {reasoning: 'hidden', type: 'reasoning'},
      ],
      tool_calls: [{
        args: {filePath: 'main.php'},
        id: 'call_qwen',
        name: 'read_file_content',
        type: 'tool_call',
      }],
    });
    const normalized = normalizeAssistantHistoryMessage(message, 'qwen');
    if (!AIMessage.isInstance(normalized)) throw new Error('Expected an AI message.');

    expect(normalized.content).to.equal('Reading the file.');
    expect(normalized.tool_calls).to.deep.equal(message.tool_calls);
    expect(normalized.additional_kwargs).not.to.have.property('reasoning_content');
  });

  it('normalizes every Qwen history role to the OpenAI-compatible wire shape', () => {
    const assistant = new AIMessage({
      additional_kwargs: {
        tool_calls: [{
          function: {arguments: '{}', name: 'legacy'},
          id: 'legacy',
          type: 'function',
        }],
      },
      content: [{text: 'Reading.', type: 'text'}],
      tool_calls: [{
        args: {filePath: 'main.php'},
        id: 'call_qwen',
        name: 'read_file_content',
        type: 'tool_call',
      }],
    });
    assistant.response_metadata = {output_version: 'v1'};
    const messages = normalizeModelHistory([
      new SystemMessage({content: [{text: 'System.', type: 'text'}]}),
      new HumanMessage({content: [{text: 'Audit.', type: 'text'}]}),
      assistant,
      new ToolMessage({
        content: [{text: 'source', type: 'text'}],
        name: 'read_file_content',
        status: 'success',
        tool_call_id: 'call_qwen',
      }),
    ], 'qwen');

    expect(messages.map((message) => message.content)).to.deep.equal([
      'System.',
      'Audit.',
      'Reading.',
      'source',
    ]);
    expect(messages[2]?.additional_kwargs).not.to.have.property('tool_calls');
    expect(messages[2]?.response_metadata).not.to.have.property('output_version');
    expect((messages[3] as ToolMessage).tool_call_id).to.equal('call_qwen');
  });

  it('drops an unusable Qwen tool call instead of aborting the replay', () => {
    const message = new AIMessage({
      content: '',
      tool_calls: [{
        args: [] as unknown as Record<string, unknown>,
        id: 'bad-qwen',
        name: 'read_file_content',
        type: 'tool_call',
      }],
    });

      const normalized = normalizeAssistantHistoryMessage(message, 'qwen');
      if (!AIMessage.isInstance(normalized)) throw new Error('Expected an AI message.');
      expect(normalized.tool_calls).to.have.length(0);
    });

    it('recovers Qwen double-encoded tool arguments', () => {
      const message = new AIMessage({
        content: '',
        tool_calls: [{
          args: '{"filePath": "src/index.ts"}' as unknown as Record<string, unknown>,
          id: 'call_qwen',
          name: 'read_file_content',
          type: 'tool_call',
        }],
      });

      const normalized = normalizeAssistantHistoryMessage(message, 'qwen');
      if (!AIMessage.isInstance(normalized)) throw new Error('Expected an AI message.');
      expect(normalized.tool_calls?.[0]?.args).to.deep.equal({filePath: 'src/index.ts'});
    });

    it('recovers Qwen arguments wrapped in an envelope', () => {
      const message = new AIMessage({
        content: '',
        tool_calls: [{
          args: '{"arguments": "{\\"name\\": \\"get\\"}"}' as unknown as Record<string, unknown>,
          id: 'call_qwen_env',
          name: 'search',
          type: 'tool_call',
        }],
      });

      const normalized = normalizeAssistantHistoryMessage(message, 'qwen');
      if (!AIMessage.isInstance(normalized)) throw new Error('Expected an AI message.');
      expect(normalized.tool_calls?.[0]?.args).to.deep.equal({name: 'get'});
    });

  it('does not alter non-assistant history', () => {
    const message = new HumanMessage('mission');
    expect(normalizeModelHistory([message], 'deepseek')).to.deep.equal([message]);
  });
});
