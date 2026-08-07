import { expect } from 'chai';
import { describe, it } from 'mocha';
import * as os from 'node:os';
import * as path from 'node:path';

import { Blackboard } from '../../src/core/hivemind/blackboard.js';
import { EventStore } from '../../src/core/memory/event-store.js';

describe('Blackboard evidence linking', () => {
  it('computes an evidence hash and emits an event on submitClaim', async () => {
    const tmp = path.join(os.tmpdir(), `shadow-auditor-test-${Date.now()}`);
    const storagePath = path.join(tmp, 'blackboard');
    const eventStoragePath = path.join(tmp, 'events');

    const eventStore = await EventStore.create({
      runId: 'test-run',
      storagePath: eventStoragePath,
    });

    const blackboard = await Blackboard.create({
      eventStore,
      runId: 'test-run',
      storagePath,
    });

    const agent = blackboard.registerAgent('recon', ['typescript']);
    expect(agent.ok).to.be.true;
    if (!agent.ok) throw new Error('Agent registration failed');
    const agentId = agent.value.agentId;

    const claimResult = await blackboard.submitClaim(
      agentId,
      'vulnerability_candidate',
      { cwe: 'CWE-79', file: 'src/app.js' },
      { confidence: 0.9, entityId: 'ent_aabbccdd', linkedEntityIds: ['ent_aabbccdd'] },
    );

    expect(claimResult.ok).to.be.true;
    if (!claimResult.ok) throw new Error('Claim submission failed');
    const claim = claimResult.value;
    expect(claim.evidenceHash).to.be.a('string');
    expect(claim.evidenceHash.length).to.be.greaterThan(0);
    expect(claim.linkedEntityIds).to.include('ent_aabbccdd');
    expect(claim.linkedEventIds.length).to.be.greaterThan(0);

    const events = await eventStore.getByType('finding_created');
    expect(events.ok).to.be.true;
    if (!events.ok) throw new Error('Event retrieval failed');
    expect(events.value.length).to.be.greaterThan(0);
    expect(events.value[0].payload.claimId).to.equal(claim.claimId);
  });
});
