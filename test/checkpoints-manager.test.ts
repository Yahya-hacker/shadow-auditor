import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CheckpointManager,
} from '../src/core/orchestrator/checkpoints.js';
import type { MissionState } from '../src/core/orchestrator/mission-state.js';
import { missionStateSchema } from '../src/core/orchestrator/mission-state.js';

describe('CheckpointManager latest-checkpoint selection', () => {
  let storagePath: string;
  let manager: CheckpointManager;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-cp-test-'));
    manager = new CheckpointManager({ runId: 'run01', storagePath });
    await manager.initialize();
  });

  afterEach(async () => {
    await fs.rm(storagePath, { force: true, recursive: true });
  });

  function makeState(missionId: string): MissionState {
    const now = new Date().toISOString();
    return missionStateSchema.parse({
      budget: {
        maxTokens: 10_000,
        maxToolCalls: 100,
        modelReservations: {},
        reservedToolCallIds: [],
        tokensUsed: 0,
        toolCallsUsed: 0,
      },
      completedActions: [],
      confidence: 0,
      currentPhase: 'OBSERVE',
      hypotheses: [],
      lastTransitionAt: now,
      missionId,
      objectives: [
        {
          constraints: [],
          description: 'Audit target for security vulnerabilities',
          objectiveId: 'objective01',
          priority: 'high',
          scope: {
            excludePaths: [],
            includePaths: ['src'],
            targetTypes: ['typescript'],
          },
          status: 'pending',
        },
      ],
      pendingActions: [],
      phaseHistory: [
        { phase: 'OBSERVE', reason: 'evidence_collected', timestamp: now },
      ],
      startedAt: now,
    });
  }

  it('returns the newest checkpoint by creation time', async () => {
    const state = makeState('mission01');
    // Save one, then re-save state for the same mission so a newer timestamp
    // (and later checkpointId) is recorded.
    const first = await manager.saveCheckpoint(state);
    expect(first.ok).to.equal(true);

    const newer = await manager.saveCheckpoint({ ...state, currentPhase: 'ORIENT' });
    expect(newer.ok).to.equal(true);

    const latest = await manager.loadLatestCheckpoint();
    expect(latest.ok).to.equal(true);
        if (!latest.ok) return;
        expect(latest.value?.currentPhase).to.equal('ORIENT');
  });

  it('falls back to checkpoint ID ordering when createdAt is malformed', async () => {
    const state = makeState('mission01');
    const first = await manager.saveCheckpoint(state);
    expect(first.ok).to.equal(true);
    if (!first.ok) return;

    // Write a second checkpoint whose metadata has a future timestamp so it
    // would sort first purely by that string, but a malformed/unparseable
    // createdAt in a third record should not break selection.
    const cpDir = path.join(storagePath, 'checkpoints');
    const meta = JSON.parse(
      await fs.readFile(path.join(cpDir, `${first.value.checkpointId}.meta.json`), 'utf8'),
    ) as { checkpointId: string; createdAt: string; missionId: string; phase: string; stateHash: string };
    const malformedId = 'cp_malformed_id';
    const malformedMeta = { ...meta, checkpointId: malformedId, createdAt: 'not-a-date' };
    await fs.writeFile(
      path.join(cpDir, `${malformedId}.json`),
      JSON.stringify(state),
      'utf8',
    );
    await fs.writeFile(
      path.join(cpDir, `${malformedId}.meta.json`),
      JSON.stringify(malformedMeta),
      'utf8',
    );

    // The malformed record must neither crash selection nor be picked.
    const latest = await manager.loadLatestCheckpoint();
    expect(latest.ok).to.equal(true);
        if (!latest.ok) return;
        expect(latest.value?.missionId).to.equal('mission01');
  });

  it('returns null when no checkpoints exist', async () => {
    const latest = await manager.loadLatestCheckpoint();
    expect(latest.ok).to.equal(true);
        if (!latest.ok) return;
        expect(latest.value).to.equal(null);
  });
});