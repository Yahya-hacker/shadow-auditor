import { expect } from 'chai';
import { describe, it } from 'mocha';
import * as os from 'node:os';
import * as path from 'node:path';

import { Blackboard } from '../../src/core/hivemind/blackboard.js';

describe('Blackboard persistence', () => {
  it('persists trust scores across snapshot round-trips', async () => {
    const tmp = path.join(os.tmpdir(), `shadow-auditor-persist-${Date.now()}-${Math.random()}`);
    const storagePath = path.join(tmp, 'blackboard');

    const first = await Blackboard.create({
      runId: 'persist_run_1',
      storagePath,
    });

    const registration = first.registerAgent('verifier', ['typescript']);
    expect(registration.ok).to.be.true;
    if (!registration.ok) throw new Error(registration.error);
    const agentId = registration.value.agentId;

    expect(first.setAgentTrustScore(agentId, 0.93).ok).to.be.true;
        await first.saveSnapshot();

        // Fresh instance on the same storage: trust must survive resume.
        const second = await Blackboard.create({
          runId: 'persist_run_2',
          storagePath,
        });

        expect(second.getAgentTrustScore(agentId)).to.equal(0.93);
      });

  it('prunes stale agents from a previous run to offline on load', async () => {
    const tmp = path.join(os.tmpdir(), `shadow-auditor-prune-${Date.now()}-${Math.random()}`);
    const storagePath = path.join(tmp, 'blackboard');

    const first = await Blackboard.create({
      heartbeatTimeout: 60_000,
      runId: 'prune_run_1',
      storagePath,
    });

    const registration = first.registerAgent('recon', ['typescript']);
    expect(registration.ok).to.be.true;
    if (!registration.ok) throw new Error(registration.error);
    const agentId = registration.value.agentId;

    await first.saveSnapshot();

    // Reload with an effectively zero heartbeat timeout: restored agents whose
    // last heartbeat came from the previous process are stale.
    const second = await Blackboard.create({
      heartbeatTimeout: 1,
      runId: 'prune_run_2',
      storagePath,
    });

    const restored = second.getRegisteredAgents().find((a) => a.agentId === agentId);
    expect(restored).to.not.be.undefined;
    expect(restored!.status).to.equal('offline');
    expect(second.getActiveAgents().some((a) => a.agentId === agentId)).to.equal(false);
  });

  it('revives a pruned agent when a silent heartbeat arrives', async () => {
    const tmp = path.join(os.tmpdir(), `shadow-auditor-revive-${Date.now()}-${Math.random()}`);
    const storagePath = path.join(tmp, 'blackboard');

    const blackboard = await Blackboard.create({
          heartbeatTimeout: 100,
          runId: 'revive_run',
          storagePath,
        });

        const registration = blackboard.registerAgent('recon', ['typescript']);
        expect(registration.ok).to.be.true;
        if (!registration.ok) throw new Error(registration.error);
        const agentId = registration.value.agentId;

        // Age the registration past the prune window, then prune.
        await new Promise((resolve) => {
          setTimeout(resolve, 150);
        });
        blackboard.pruneInactiveAgents();
    expect(
          blackboard.getRegisteredAgents().find((a) => a.agentId === agentId)!.status,
    ).to.equal('offline');

    const heartbeat = blackboard.heartbeat(agentId);
    expect(heartbeat.ok).to.be.true;
    if (!heartbeat.ok) throw new Error(heartbeat.error);

    expect(heartbeat.value.status).to.equal('idle');
    expect(blackboard.getActiveAgents().some((a) => a.agentId === agentId)).to.equal(true);
  });
});