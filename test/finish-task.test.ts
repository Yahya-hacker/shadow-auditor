import { expect } from 'chai';

import { buildStopConditions } from '../src/core/session.js';

describe('finish_task stop condition', () => {
  it('buildStopConditions returns an array of two predicates', () => {
    const conditions = buildStopConditions(10);
    expect(conditions).to.be.an('array').with.lengthOf(2);
    expect(conditions[0]).to.be.a('function');
    expect(conditions[1]).to.be.a('function');
  });

  it('step count predicate stops at the given max', () => {
    const conditions = buildStopConditions(3);
    const stepCountPredicate = conditions[0];

    // Should not stop before maxSteps
    const notDone = stepCountPredicate({ steps: [{}, {}] } as never);
    expect(notDone).to.equal(false);

    // Should stop at exactly maxSteps
    const done = stepCountPredicate({ steps: [{}, {}, {}] } as never);
    expect(done).to.equal(true);
  });

  it('finish_task predicate stops when finish_task tool is called', () => {
    const conditions = buildStopConditions(10);
    const finishPredicate = conditions[1];

    // Should not stop when no tool calls
    const noCall = finishPredicate({
      steps: [
        {
          toolCalls: [{ toolName: 'read_file_content' }],
        },
      ],
    } as never);
    expect(noCall).to.equal(false);

    // Should stop when finish_task is called
    const withFinish = finishPredicate({
      steps: [
        {
          toolCalls: [{ toolName: 'finish_task' }],
        },
      ],
    } as never);
    expect(withFinish).to.equal(true);
  });

  it('maxSteps is at least 10 from fallback capabilities', async () => {
    // Import inline to keep test self-contained
    const { resolveModelCapabilities } = await import('../src/core/model-capabilities.js');
    const caps = resolveModelCapabilities({ model: 'unknown-model', provider: 'unknown' });
    expect(caps.maxToolSteps).to.be.at.least(10);
  });
});
