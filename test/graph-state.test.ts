import {AIMessage, HumanMessage, ToolMessage} from '@langchain/core/messages';
import {expect} from 'chai';

import {trimContextMessages} from '../src/core/graph/state.js';

describe('graph message state', () => {
  it('preserves an entire multi-tool transaction when the trim boundary splits it', () => {
    const calls = ['call-a', 'call-b', 'call-c'];
    const messages = [
      new HumanMessage('mission'),
      ...Array.from({length: 6}, (_, index) => new HumanMessage(`older-${index}`)),
      new AIMessage({
        content: '',
        tool_calls: calls.map((id) => ({
          args: {id},
          id,
          name: 'read_file_content',
          type: 'tool_call' as const,
        })),
      }),
      ...calls.map((id) => new ToolMessage({content: id, tool_call_id: id})),
      ...Array.from({length: 37}, (_, index) => new AIMessage(`newer-${index}`)),
    ];

    const trimmed = trimContextMessages(messages, 40);

    const retainedCalls = trimmed.flatMap((message) =>
      AIMessage.isInstance(message) ? (message.tool_calls ?? []).map((call) => call.id) : [],
    );
    const retainedResults = trimmed.flatMap((message) =>
      ToolMessage.isInstance(message) ? [message.tool_call_id] : [],
    );
    expect(retainedCalls).to.deep.equal(calls);
    expect(retainedResults).to.deep.equal(calls);
    expect(trimmed).to.have.length(42);
  });

  it('drops an orphaned tool result instead of replaying invalid provider history', () => {
    const messages = [
      new HumanMessage('mission'),
      ...Array.from({length: 40}, (_, index) => new HumanMessage(`message-${index}`)),
      new ToolMessage({content: 'orphan', tool_call_id: 'missing-call'}),
    ];

    const trimmed = trimContextMessages(messages, 10);

    expect(trimmed.some((message) => ToolMessage.isInstance(message))).to.equal(false);
  });
});
