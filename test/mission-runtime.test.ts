import {expect} from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type {MissionObjective} from '../src/core/orchestrator/mission-state.js';

import {MissionEngine} from '../src/core/orchestrator/mission-engine.js';
import {runObservedModelInvocation} from '../src/core/orchestrator/mission-runtime.js';

describe('MissionEngine runtime accounting', () => {
  let storagePath = '';

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-runtime-'));
  });

  afterEach(async () => {
    await fs.rm(storagePath, {force: true, recursive: true});
  });

  async function createEngine(
    overrides: Partial<ConstructorParameters<typeof MissionEngine>[0]> = {},
  ): Promise<MissionEngine> {
    const engine = new MissionEngine({
      maxTokens: 100,
      maxTokensPerInvocation: 100,
      maxToolCalls: 2,
      runId: 'runtime-test',
      storagePath,
      ...overrides,
    });
    const objective: MissionObjective = {
      constraints: [],
      description: 'Audit the repository',
      objectiveId: 'objective-runtime',
      priority: 'high',
      scope: {
        excludePaths: [],
        includePaths: ['src'],
        targetTypes: ['typescript'],
      },
      status: 'pending',
    };
    await engine.initialize([objective]);
    return engine;
  }

  it('atomically reserves a shared tool budget under concurrency', async () => {
    const engine = await createEngine();
    const reservations = await Promise.allSettled(
      ['one', 'two', 'three'].map((callId) =>
        engine.beforeToolExecution(
          {agentId: callId, stage: 'swarm_researcher'},
          [{callId, name: 'read_file'}],
        ),
      ),
    );

    expect(reservations.filter(({status}) => status === 'fulfilled')).to.have.length(2);
    expect(reservations.filter(({status}) => status === 'rejected')).to.have.length(1);
    expect(engine.getState().budget.toolCallsUsed).to.equal(2);
    expect((await engine.getEventStore().getByType('tool_call')).ok).to.equal(true);
    const events = await engine.getEventStore().getByType('tool_call');
    if (!events.ok) throw new Error(events.error);
    expect(events.value).to.have.length(2);
  });

  it('durably records model usage and fails closed at the mission token ceiling', async () => {
    const engine = await createEngine();
    const usage = {
      completion: 40,
      prompt: 60,
      total: 100,
      totalSource: 'provider' as const,
      unclassified: 0,
    };

    await engine.recordStageStarted('sast_audit');
    const reservationId = await engine.beforeModelInvocation({stage: 'sast_audit'});
    await engine.afterModelInvocation({stage: 'sast_audit'}, usage, reservationId);
    await engine.recordStageCompleted('sast_audit');

    expect(engine.getState().budget.tokensUsed).to.equal(100);
    let exhaustionError: unknown;
    try {
      await engine.beforeModelInvocation({stage: 'reporting'});
    } catch (error) {
      exhaustionError = error;
    }

    expect(exhaustionError).to.be.instanceOf(Error);
    expect((exhaustionError as Error).message).to.include('Mission token budget exhausted');
    const eventTypes = (await engine.getEventStore().read());
    if (!eventTypes.ok) throw new Error(eventTypes.error);
    expect(eventTypes.value.map(({eventType}) => eventType)).to.include.members([
      'model_usage',
      'stage_started',
      'stage_completed',
    ]);

    const resumed = await createEngine();
    await resumed.recordStageStarted('sast_audit');
    await resumed.recordStageCompleted('sast_audit');
    const resumedEvents = await resumed.getEventStore().read();
    if (!resumedEvents.ok) throw new Error(resumedEvents.error);
    expect(resumedEvents.value.filter(({eventType}) => eventType === 'stage_started')).to.have.length(1);
    expect(resumedEvents.value.filter(({eventType}) => eventType === 'stage_completed')).to.have.length(1);
  });

  it('restores reserved budgets from the durable checkpoint after interruption', async () => {
    const engine = await createEngine();
    await engine.beforeToolExecution(
      {agentId: 'worker-1', stage: 'swarm_researcher'},
      [{callId: 'reserved-before-crash', name: 'read_file'}],
    );
    const reservationId = await engine.beforeModelInvocation({
      agentId: 'worker-1',
      stage: 'swarm_researcher',
    });
    await engine.afterModelInvocation(
      {agentId: 'worker-1', stage: 'swarm_researcher'},
      {
        completion: 10,
        prompt: 15,
        total: 25,
        totalSource: 'provider',
        unclassified: 0,
      },
      reservationId,
    );

    const resumed = await createEngine();
    expect(resumed.getState().budget).to.deep.include({
      tokensUsed: 25,
      toolCallsUsed: 1,
    });
    await resumed.beforeToolExecution(
      {agentId: 'worker-2', stage: 'swarm_researcher'},
      [{callId: 'last-available-call', name: 'search_codebase'}],
    );

    let exhaustionError: unknown;
    try {
      await resumed.beforeToolExecution(
        {agentId: 'worker-3', stage: 'swarm_researcher'},
        [{callId: 'over-budget', name: 'read_file'}],
      );
    } catch (error) {
      exhaustionError = error;
    }

    expect(exhaustionError).to.be.instanceOf(Error);
    expect(resumed.getState().budget.toolCallsUsed).to.equal(2);
  });

  it('reconciles durable usage when a crash precedes the updated checkpoint', async () => {
    const engine = await createEngine();
    const reservationId = await engine.beforeModelInvocation({stage: 'sast_audit'});
    const appended = await engine.getEventStore().append('model_usage', {
      chargedTokens: 17,
      reservationId,
      stage: 'sast_audit',
    });
    if (!appended.ok) throw new Error(appended.error);

    const resumed = await createEngine();
    expect(resumed.getState().budget.tokensUsed).to.equal(17);
    expect(resumed.getState().budget.modelReservations).not.to.have.property(reservationId);
  });

  it('persists one exclusive terminal mission outcome with its final budget', async () => {
    const engine = await createEngine();
    await engine.beforeToolExecution(
      {stage: 'sast_audit'},
      [{callId: 'read-before-completion', name: 'read_file'}],
    );
    await engine.recordMissionCompleted();
    let duplicateTerminalError: unknown;
    try {
      await engine.recordMissionFailed('subsequent test failure');
    } catch (error) {
      duplicateTerminalError = error;
    }

    const events = await engine.getEventStore().read();
    if (!events.ok) throw new Error(events.error);
    const completion = events.value.find(({eventType}) => eventType === 'mission_completed');
    const failure = events.value.find(({eventType}) => eventType === 'mission_failed');
    expect(engine.getState().currentPhase).to.equal('COMPLETE');
    expect(duplicateTerminalError).to.be.instanceOf(Error);
    expect(completion?.payload).to.have.property('budget');
    expect(completion?.payload.budget).to.deep.include({
      maxTokens: 100,
      maxToolCalls: 2,
      tokensUsed: 0,
      toolCallsUsed: 1,
    });
    expect(failure).to.equal(undefined);
  });

  it('repairs a terminal event when its checkpoint succeeded before append failed', async () => {
    const engine = await createEngine();
    const eventStore = engine.getEventStore();
    const append = eventStore.append.bind(eventStore);
    let injectFailure = true;
    eventStore.append = async (eventType, payload) => {
      if (injectFailure && eventType === 'mission_completed') {
        injectFailure = false;
        return {error: 'injected append failure', ok: false};
      }

      return append(eventType, payload);
    };

    let appendError: unknown;
    try {
      await engine.recordMissionCompleted();
    } catch (error) {
      appendError = error;
    }

    expect(appendError).to.be.instanceOf(Error);
    expect(engine.getState().currentPhase).to.equal('COMPLETE');

    await engine.recordMissionCompleted();
    const completions = await eventStore.getByType('mission_completed');
    if (!completions.ok) throw new Error(completions.error);
    expect(completions.value).to.have.length(1);
  });

  it('repairs a missing terminal event during checkpoint restoration', async () => {
    const engine = await createEngine();
    const eventStore = engine.getEventStore();
    const append = eventStore.append.bind(eventStore);
    eventStore.append = async (eventType, payload) =>
      eventType === 'mission_completed'
        ? {error: 'injected append failure', ok: false}
        : append(eventType, payload);

    let appendError: unknown;
    try {
      await engine.recordMissionCompleted();
    } catch (error) {
      appendError = error;
    }

    expect(appendError).to.be.instanceOf(Error);

    const resumed = await createEngine();
    const completions = await resumed.getEventStore().getByType('mission_completed');
    if (!completions.ok) throw new Error(completions.error);
    expect(completions.value).to.have.length(1);
    expect(completions.value[0]?.payload.missionId).to.equal(resumed.getState().missionId);
    expect(completions.value[0]?.payload).to.have.property('budget');
    expect(completions.value[0]?.payload).not.to.have.property('finalBudget');
  });

  it('repairs a missing failure event without losing its original reason', async () => {
    const engine = await createEngine();
    const eventStore = engine.getEventStore();
    const append = eventStore.append.bind(eventStore);
    eventStore.append = async (eventType, payload) =>
      eventType === 'mission_failed'
        ? {error: 'injected append failure', ok: false}
        : append(eventType, payload);

    let appendError: unknown;
    try {
      await engine.recordMissionFailed('provider unavailable');
    } catch (error) {
      appendError = error;
    }

    expect(appendError).to.be.instanceOf(Error);

    const resumed = await createEngine();
    const failures = await resumed.getEventStore().getByType('mission_failed');
    if (!failures.ok) throw new Error(failures.error);
    expect(failures.value).to.have.length(1);
    expect(failures.value[0]?.payload).to.deep.include({
      missionId: resumed.getState().missionId,
      reason: 'provider unavailable',
    });
  });

  it('preserves the original failure reason during same-process event repair', async () => {
    const engine = await createEngine();
    const eventStore = engine.getEventStore();
    const append = eventStore.append.bind(eventStore);
    let injectFailure = true;
    eventStore.append = async (eventType, payload) => {
      if (injectFailure && eventType === 'mission_failed') {
        injectFailure = false;
        return {error: 'injected append failure', ok: false};
      }

      return append(eventType, payload);
    };

    let appendError: unknown;
    try {
      await engine.recordMissionFailed('provider unavailable');
    } catch (error) {
      appendError = error;
    }

    expect(appendError).to.be.instanceOf(Error);
    await engine.recordMissionFailed('later cleanup failure');
    const failures = await eventStore.getByType('mission_failed');
    if (!failures.ok) throw new Error(failures.error);
    expect(failures.value).to.have.length(1);
    expect(failures.value[0]?.payload).to.deep.include({reason: 'provider unavailable'});
  });

  it('persists a failed terminal mission state', async () => {
    const engine = await createEngine();
    await engine.recordMissionFailed('provider unavailable');

    const resumed = await createEngine();
    expect(resumed.getState().currentPhase).to.equal('FAILED');
    expect(resumed.getState().objectives[0]?.status).to.equal('blocked');
    const failures = await resumed.getEventStore().getByType('mission_failed');
    if (!failures.ok) throw new Error(failures.error);
    expect(failures.value).to.have.length(1);
    expect(failures.value[0]?.payload).to.deep.include({reason: 'provider unavailable'});
  });

  it('starts a fresh budget and lifecycle after a terminal execution', async () => {
    const engine = await createEngine();
    const originalMissionId = engine.getState().missionId;
    await engine.recordStageStarted('sast_audit');
    await engine.recordMissionCompleted();
    await engine.beginExecution();
    await engine.recordStageStarted('sast_audit');

    expect(engine.getState().currentPhase).to.equal('OBSERVE');
    expect(engine.getState().missionId).not.to.equal(originalMissionId);
    expect(engine.getState().budget.tokensUsed).to.equal(0);
    const starts = await engine.getEventStore().getByType('stage_started');
    if (!starts.ok) throw new Error(starts.error);
    expect(starts.value).to.have.length(2);
  });

  it('prevents concurrent model reservations from oversubscribing the shared ceiling', async () => {
    const engine = await createEngine({maxTokens: 100, maxTokensPerInvocation: 60});
    const reservations = await Promise.allSettled([
      engine.beforeModelInvocation({agentId: 'worker-1', stage: 'swarm_researcher'}),
      engine.beforeModelInvocation({agentId: 'worker-2', stage: 'swarm_researcher'}),
    ]);

    expect(reservations.filter(({status}) => status === 'fulfilled')).to.have.length(1);
    expect(reservations.filter(({status}) => status === 'rejected')).to.have.length(1);
    expect(engine.getRemainingBudget().tokens).to.equal(40);
  });

  it('charges the full reservation when a provider omits usage metadata', async () => {
    const engine = await createEngine({maxTokensPerInvocation: 40});
    const result = await runObservedModelInvocation(
      engine,
      {stage: 'reporting'},
      async () => 'complete',
    );

    expect(result).to.equal('complete');
    expect(engine.getState().budget.tokensUsed).to.equal(40);
    expect(engine.getState().budget.modelReservations).to.deep.equal({});
  });

  it('never charges less than the host-estimated token floor', async () => {
    const engine = await createEngine({maxTokens: 40, maxTokensPerInvocation: 40});
    const invocation = {estimatedTokens: 30, stage: 'reporting'};
    const reservationId = await engine.beforeModelInvocation(invocation);
    await engine.afterModelInvocation(
      invocation,
      {completion: 1, prompt: 0, total: 1, totalSource: 'provider', unclassified: 0},
      reservationId,
    );

    expect(engine.getState().budget.tokensUsed).to.equal(30);
  });

  it('does not reinterpret accounting failures as provider failures', async () => {
    let accountingCalls = 0;
    let providerCalls = 0;
    const runtime = {
      async afterModelInvocation() {
        accountingCalls += 1;
        throw new Error('checkpoint persistence failed');
      },
      async afterToolExecution() {},
      async beforeModelInvocation() {
        return 'reservation';
      },
      async beforeToolExecution() {},
      async recordMissionCompleted() {},
      async recordMissionFailed() {},
      async recordStageCompleted() {},
      async recordStageStarted() {},
    };

    let observedError: unknown;
    try {
      await runObservedModelInvocation(runtime, {stage: 'sast'}, async () => {
        providerCalls += 1;
        return {content: 'completed'};
      });
    } catch (error) {
      observedError = error;
    }

    expect((observedError as Error).message).to.include('Mission accounting failed');
    expect(providerCalls).to.equal(1);
    expect(accountingCalls).to.equal(1);
  });

  it('continues one host-authorized human-confirmed tool reservation', async () => {
    const engine = await createEngine();
    const invocation = {
      executionId: 'sast_audit:1',
      stage: 'sast_audit',
    };
    const calls = [{callId: 'sast_audit:1:0', name: 'execute_command'}];

    await engine.beforeToolExecution(invocation, calls);
    await engine.beforeToolExecution({...invocation, resumeReservedTools: true}, calls);

    expect(engine.getState().budget.toolCallsUsed).to.equal(1);
    expect(engine.getState().budget.reservedToolCallIds).to.have.length(1);
  });

  it('releases a checkpoint-only tool reservation that never reached execution', async () => {
    const engine = await createEngine();
    const eventStore = engine.getEventStore();
    const originalAppend = eventStore.append.bind(eventStore);
    eventStore.append = async (eventType, payload) =>
      eventType === 'tool_call'
        ? {error: 'simulated append failure', ok: false}
        : originalAppend(eventType, payload);

    let reservationError: unknown;
    try {
      await engine.beforeToolExecution(
        {executionId: 'sast:1', stage: 'sast'},
        [{callId: 'sast:1:0', name: 'inspect'}],
      );
    } catch (error) {
      reservationError = error;
    }

    expect(reservationError).to.be.instanceOf(Error);

    const resumed = await createEngine();
    expect(resumed.getState().budget.toolCallsUsed).to.equal(0);
    expect(resumed.getState().budget.reservedToolCallIds).to.deep.equal([]);
  });

  it('rejects an ambiguous tool-call replay after restart', async () => {
    const invocation = {
      agentId: 'worker-1',
      executionId: 'response-1',
      stage: 'swarm_researcher',
    };
    const calls = [{callId: 'call-1', name: 'read_file'}];
    const engine = await createEngine();
    await engine.beforeToolExecution(invocation, calls);

    const resumed = await createEngine();
    let replayError: unknown;
    try {
      await resumed.beforeToolExecution(invocation, calls);
    } catch (error) {
      replayError = error;
    }

    expect(replayError).to.be.instanceOf(Error);
    expect((replayError as Error).message).to.include('Refusing to replay');
    expect(resumed.getState().budget.toolCallsUsed).to.equal(1);
  });

  it('fails closed instead of resetting budgets when the latest checkpoint is corrupt', async () => {
    const engine = await createEngine();
    await engine.beforeModelInvocation({stage: 'sast_audit'});
    const checkpointDir = path.join(storagePath, 'checkpoints');
    const stateFile = (await fs.readdir(checkpointDir)).find((file) =>
      file.endsWith('.json') && !file.endsWith('.meta.json')
    );
    if (!stateFile) throw new Error('Expected a durable mission checkpoint.');
    await fs.writeFile(path.join(checkpointDir, stateFile), '{"corrupt":true}', 'utf8');

    let restoreError: unknown;
    try {
      await createEngine();
    } catch (error) {
      restoreError = error;
    }

    expect(restoreError).to.be.instanceOf(Error);
    expect((restoreError as Error).message).to.include('Failed to restore mission checkpoint');
  });

  it('does not publish tool-call events when the pre-execution checkpoint fails', async () => {
    const engine = await createEngine();
    engine.saveCheckpoint = async () => {
      throw new Error('checkpoint unavailable');
    };

    let checkpointError: unknown;
    try {
      await engine.beforeToolExecution(
        {executionId: 'response-1', stage: 'sast_audit'},
        [{callId: 'call-1', name: 'read_file'}],
      );
    } catch (error) {
      checkpointError = error;
    }

    expect(checkpointError).to.be.instanceOf(Error);
    expect(engine.getState().budget.toolCallsUsed).to.equal(0);
    expect(engine.getState().budget.reservedToolCallIds).to.deep.equal([]);
    const events = await engine.getEventStore().getByType('tool_call');
    if (!events.ok) throw new Error(events.error);
    expect(events.value).to.deep.equal([]);
  });
});
