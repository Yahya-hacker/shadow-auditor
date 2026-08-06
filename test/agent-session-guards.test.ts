import {expect} from 'chai';

import type {ShadowConfig} from '../src/utils/config.js';

import {AgentSession} from '../src/core/agent.js';

function sessionWithoutInitialization(fields: Record<string, unknown>): AgentSession {
  const session = Object.create(AgentSession.prototype) as AgentSession;
  for (const [key, value] of Object.entries(fields)) Reflect.set(session, key, value);
  return session;
}

describe('AgentSession guards', () => {
  it('cancels the active operation without disposing the session', async () => {
    let finishOperation!: () => void;
    let observedSignal: AbortSignal | undefined;
    const operationGate = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    const session = sessionWithoutInitialization({
      disposed: false,
      initialized: Promise.resolve(),
      operationTimeoutMs: 60_000,
    });
    const runOperation = Reflect.get(
      AgentSession.prototype,
      'runOperation',
    ) as (this: AgentSession, name: string, operation: () => Promise<void>) => Promise<void>;
    const operation = runOperation.call(session, 'test operation', async () => {
      observedSignal = Reflect.get(session, 'activeOperationController').signal;
      await operationGate;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(session.cancelActiveOperation()).to.equal(true);
    expect(observedSignal?.aborted).to.equal(true);
    expect(session.cancelActiveOperation()).to.equal(false);

    finishOperation();
    await operation;
    expect(Reflect.get(session, 'disposed')).to.equal(false);
  });

  it('serializes manual compaction with other active operations', async () => {
    let finishOperation!: () => void;
    const operationGate = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    const session = sessionWithoutInitialization({
      disposed: false,
      initialized: Promise.resolve(),
      operationTimeoutMs: 60_000,
    });
    const runOperation = Reflect.get(
      AgentSession.prototype,
      'runOperation',
    ) as (this: AgentSession, name: string, operation: () => Promise<void>) => Promise<void>;
    const operation = runOperation.call(session, 'scan', () => operationGate);
    await Promise.resolve();

    let failure: unknown;
    try {
      await session.compactContext();
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(Error);
    expect((failure as Error).message).to.equal(
      'Cannot compact context while "scan" is in progress.',
    );
    finishOperation();
    await operation;
  });

  it('refuses to compact a workflow paused for human input', async () => {
    const session = sessionWithoutInitialization({
      compiledWorkflow: {
        async getState() {
          return {
            values: {
              messages: [{content: 'pending tool call'}, {content: 'tool approval required'}],
              pendingHumanInput: {question: 'Approve command?', requestId: 'request-1'},
            },
          };
        },
      },
      initialized: Promise.resolve(),
      langchainModel: {},
    });

    let failure: unknown;
    try {
      await session.compactContext();
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(Error);
    expect((failure as Error).message).to.equal(
      'Context cannot be compacted while human input is pending. Respond to the request first.',
    );
  });

  it('passes the active cancellation signal to context compaction', async () => {
    let observedSignal: AbortSignal | undefined;
    const session = sessionWithoutInitialization({
      activeOperationController: new AbortController(),
      compiledWorkflow: {
        async getState() {
          return {
            values: {
              messages: [{content: 'one'}, {content: 'two'}, {content: 'three'}],
            },
          };
        },
        async updateState() {},
      },
      langchainModel: {
        async invoke(_messages: unknown[], options?: {signal?: AbortSignal}) {
          observedSignal = options?.signal;
          return {content: 'summary'};
        },
      },
    });
    const compactContextInternal = Reflect.get(
      AgentSession.prototype,
      'compactContextInternal',
    ) as (this: AgentSession) => Promise<unknown>;

    await compactContextInternal.call(session);

    expect(observedSignal).to.equal(
      (Reflect.get(session, 'activeOperationController') as AbortController).signal,
    );
  });

  it('uses the runtime-clamped output limit for provider construction', () => {
    const config: ShadowConfig = {
      apiKey: 'test-key',
      maxOutputTokens: 100_000,
      model: 'claude-sonnet-4.5',
      provider: 'anthropic',
    };
    const session = sessionWithoutInitialization({
      config,
      runtime: {maxOutputTokens: 32_000},
    });

    const resolvedModelConfig = Reflect.get(
      AgentSession.prototype,
      'resolvedModelConfig',
    ) as (this: AgentSession) => ShadowConfig;

    expect(resolvedModelConfig.call(session)).to.deep.include({
      maxOutputTokens: 32_000,
      model: config.model,
      provider: config.provider,
    });
  });

  it('rejects reasoning changes that would leave swarm workers stale', async () => {
    const session = sessionWithoutInitialization({
      config: {
        apiKey: 'test-key',
        model: 'gpt-5.6-sol',
        provider: 'openai',
        swarm: {enabled: true},
      },
      initialized: Promise.resolve(),
    });

    let failure: unknown;
    try {
      await session.setReasoningEffort('high');
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(Error);
    expect((failure as Error).message).to.include('swarm session');
  });

  it('rejects tool policy changes while an agent operation is active', async () => {
    const session = sessionWithoutInitialization({
      activeOperation: Promise.resolve(),
      initialized: Promise.resolve(),
    });

    let failure: unknown;
    try {
      await session.setToolPolicy({disabledTools: ['read_file']});
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(Error);
    expect((failure as Error).message).to.equal(
      'Tool configuration cannot change while an agent operation is running.',
    );
  });

  it('waits for an active operation before completing disposal', async () => {
    let finishOperation!: () => void;
    let cleanedUp = false;
    const operationGate = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    const session = sessionWithoutInitialization({
      disposed: false,
      humanInteraction: {reset() {}},
      initializationController: new AbortController(),
      initialized: Promise.resolve(),
      mcpManager: {
        async shutdown() {
          cleanedUp = true;
        },
      },
      operationTimeoutMs: 60_000,
      runtimeToolAssembly: null,
    });
    const runOperation = Reflect.get(
      AgentSession.prototype,
      'runOperation',
    ) as (this: AgentSession, name: string, operation: () => Promise<void>) => Promise<void>;
    const operation = runOperation.call(session, 'test operation', () => operationGate);
    await Promise.resolve();

    let disposalCompleted = false;
    const disposal = session.dispose().then(() => {
      disposalCompleted = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(disposalCompleted).to.equal(false);
    expect(cleanedUp).to.equal(false);

    finishOperation();
    await operation;
    await disposal;

    expect(disposalCompleted).to.equal(true);
    expect(cleanedUp).to.equal(true);
  });
});
