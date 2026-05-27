/**
 * SwarmCoordinator Tests.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { Blackboard } from '../src/core/hivemind/blackboard.js';
import { SwarmCoordinator } from '../src/core/hivemind/swarm-coordinator.js';

describe('SwarmCoordinator', () => {
  let tmpDir: string;
  let storageDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-test-'));
    storageDir = path.join(tmpDir, 'storage');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { force: true, recursive: true });
  });

  it('can initialize, set up tasks in blackboard, and execute', async () => {
    const coordinator = new SwarmCoordinator({
      allTools: {
        finish_task: {
          description: 'Finish task tool',
          execute: async () => ({ text: 'Task completed successfully.' }),
        } as any,
      },
      config: {
        swarm: {
          roles: ['recon', 'taint-tracer', 'exploit-analyst', 'verifier', 'reporter'],
        },
      },
      model: {} as any,
      runId: 'test-swarm-run',
      storagePath: storageDir,
    });

    const promise = coordinator.executeMission('Test objective');

    // Wait a tiny bit for coordinator to populate blackboard and start workers
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });

    const blackboard = coordinator.getBlackboard();
    expect(blackboard).to.exist;

    const taskGraph = blackboard.getTaskGraph();
    const tasks = taskGraph.getAllTasks();

    expect(tasks.length).to.be.greaterThan(4);

    const reconTask = tasks.find((t) => t.taskType === 'recon');
    expect(reconTask).to.exist;
    expect(reconTask?.requiredRole).to.equal('recon');

    const taintTask = tasks.find((t) => t.taskType === 'taint');
    expect(taintTask).to.exist;
    expect(taintTask?.dependencies).to.include(reconTask!.taskId);

    // Clean up/terminate workers from the coordinator to shut down the execution loop gracefully
    const workers = (coordinator as any).workers;
    for (const worker of workers.values()) {
      worker.terminate();
    }

    // Await the coordination promise which should terminate gracefully now
    try {
      await promise;
    } catch {
      // Ignore execution loop termination errors in stub setting
    }
  });

  it('verifies blackboard claim pub/sub and consensus channels', async () => {
    const blackboard = await Blackboard.create({
      runId: 'test-pubsub',
      storagePath: storageDir,
    });

    let claimSubmitted = false;
    let claimVerified = false;

    blackboard.onClaimSubmitted((claim) => {
      expect(claim.claimType).to.equal('recon_entrypoint');
      claimSubmitted = true;
    });

    blackboard.onClaimVerified((claim) => {
      expect(claim.status).to.equal('verified');
      claimVerified = true;
    });

    const reg1 = blackboard.registerAgent('recon');
    const reg2 = blackboard.registerAgent('verifier');

    if (!reg1.ok || !reg2.ok) {
      throw new Error('Registration failed');
    }

    const claimRes = blackboard.submitClaim(reg1.value.agentId, 'recon_entrypoint', { entrypoint: '/api/v1/user' });
    expect(claimRes.ok).to.be.true;
    expect(claimSubmitted).to.be.true;

    if (!claimRes.ok) {
      throw new Error('Claim submission failed');
    }

    const verifyRes = blackboard.verifyClaim(claimRes.value.claimId, reg2.value.agentId);
    expect(verifyRes.ok).to.be.true;
    expect(claimVerified).to.be.true;
  });
});
