/**
 * SwarmCoordinator Tests.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { AIMessage } from '@langchain/core/messages';
import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

import { AgentWorker } from '../src/core/hivemind/agent-worker.js';
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
        model: 'test-model',
        provider: 'test-provider',
        swarm: {
          roles: ['recon', 'taint-tracer', 'exploit-analyst', 'verifier', 'reporter'],
        },
      } as any,
      model: {} as any,
      runId: 'test-swarm-run',
      storagePath: storageDir,
    });

    const promise = coordinator.executeMission('Test objective').catch((error: unknown) => error);

    // Wait a tiny bit for coordinator to populate blackboard and start workers
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });

    const blackboard = coordinator.getBlackboard();
    expect(blackboard).to.exist;
    if (!blackboard) throw new Error('Blackboard should exist after executeMission');

    const taskGraph = blackboard.getTaskGraph();
    const tasks = taskGraph.getAllTasks();

    expect(tasks.length).to.be.greaterThan(4);

    const reconTask = tasks.find((t) => t.taskType === 'recon');
    expect(reconTask).to.exist;
    expect(reconTask?.requiredRole).to.equal('recon');

    const taintTask = tasks.find((t) => t.taskType === 'taint');
    expect(taintTask).to.exist;
    expect(taintTask?.dependencies).to.deep.equal([]);
    const exploitTask = tasks.find((t) => t.taskType === 'exploit');
    expect(exploitTask?.dependencies).to.have.members([reconTask!.taskId, taintTask!.taskId]);

    // Clean up/terminate workers from the coordinator to shut down the execution loop gracefully
    const workers = (coordinator as any).workers;
    for (const worker of workers.values()) {
      worker.terminate();
    }

    // Await the coordination promise which should terminate gracefully now
    await promise;
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

    const claimRes = await blackboard.submitClaim(reg1.value.agentId, 'recon_entrypoint', { entrypoint: '/api/v1/user' });
    expect(claimRes.ok).to.be.true;
    expect(claimSubmitted).to.be.true;

    if (!claimRes.ok) {
      throw new Error('Claim submission failed');
    }

    // The evidence chain must be cryptographically linked: every submitted
    // claim carries a non-empty sha256 evidenceHash binding it to its lineage.
    expect(claimRes.value.evidenceHash.length).to.be.greaterThan(
      0,
      'evidenceHash must be cryptographically linked to the claim lineage',
    );
    // submitClaim must trigger a consensus proposal that is recoverable from
    // the blackboard (and therefore from checkpointed graph state).
    expect(blackboard.getConsensusRecords().length).to.be.greaterThan(
      0,
      'submitClaim must create a consensus proposal',
    );

    const verifyRes = blackboard.verifyClaim(claimRes.value.claimId, reg2.value.agentId);
    expect(verifyRes.ok).to.be.true;
    expect(claimVerified).to.be.true;

    // verifyClaim must cast an evidence-bearing approval vote on the proposal.
    const proposal = blackboard
      .getConsensusRecords()
      .find((r) => r.topic === claimRes.value.claimId);
    expect(proposal, 'consensus proposal for the claim must exist').to.exist;
    if (proposal) {
      expect(proposal.votes.length).to.be.greaterThan(0, 'verifyClaim must record a vote');
      expect(proposal.votes[0].evidenceHash).to.equal(claimRes.value.evidenceHash);
    }
  });

  it('rejects duplicate contests from the same agent', async () => {
    const blackboard = await Blackboard.create({
      runId: 'test-duplicate-contest',
      storagePath: storageDir,
    });
    const author = blackboard.registerAgent('recon');
    const challenger = blackboard.registerAgent('verifier');
    if (!author.ok || !challenger.ok) throw new Error('Registration failed');
    expect(blackboard.setAgentTrustScore(author.value.agentId, 0.95).ok).to.equal(true);
    expect(blackboard.setAgentTrustScore(challenger.value.agentId, 0.2).ok).to.equal(true);

    const claim = await blackboard.submitClaim(
      author.value.agentId,
      'vulnerability_candidate',
      { file: 'src/app.ts' },
    );
    if (!claim.ok) throw new Error(claim.error);

    expect(blackboard.contestClaim(claim.value.claimId, challenger.value.agentId).ok).to.equal(true);
    const duplicate = blackboard.contestClaim(claim.value.claimId, challenger.value.agentId);
    expect(duplicate.ok).to.equal(false);
    const updated = blackboard.getAllClaims().find((item) => item.claimId === claim.value.claimId);
    expect(updated?.contestedBy).to.deep.equal([challenger.value.agentId]);
    expect(updated?.status).to.equal('contested');
    const rejection = blackboard.getConsensusRecords()
      .flatMap((record) => record.votes)
      .find((vote) => vote.agentId === challenger.value.agentId && vote.vote === 'reject');
    expect(rejection?.trustScore).to.equal(0.2);
  });

  it('fails reporter tasks that omit an accepted claim from structured output', async () => {
    const blackboard = await Blackboard.create({
      runId: 'test-reporter-integrity',
      storagePath: storageDir,
    });
    const author = blackboard.registerAgent('recon');
    const verifier = blackboard.registerAgent('verifier');
    const reporter = blackboard.registerAgent('reporter');
    if (!author.ok || !verifier.ok || !reporter.ok) throw new Error('Registration failed');
    const claim = await blackboard.submitClaim(
      author.value.agentId,
      'vulnerability_candidate',
      { title: 'Command injection' },
    );
    if (!claim.ok) throw new Error(claim.error);
    const verified = blackboard.verifyClaim(claim.value.claimId, verifier.value.agentId);
    if (!verified.ok) throw new Error(verified.error);

    const responses = [
      new AIMessage({
        content: '',
        tool_calls: [
          { args: { sourceClaimId: 'wrong-claim' }, id: 'report-1', name: 'report_finding' },
          { args: { sourceClaimId: claim.value.claimId }, id: 'report-2', name: 'report_finding' },
        ],
      }),
      new AIMessage({
        content: '',
        tool_calls: [{ args: {}, id: 'finish-rejected-report', name: 'finish_task' }],
      }),
      new AIMessage('done'),
    ];
    const model = {
      bindTools() {
        return { async invoke() { return responses.shift(); } };
      },
    } as any;
    let committedReports = 0;
    const worker = new AgentWorker({
      agentId: reporter.value.agentId,
      allTools: {
        finish_task: {
          description: 'Finish.',
          execute: async () => 'finished',
          inputSchema: z.object({}),
        },
        report_finding: {
          description: 'Report.',
          execute: async () => ({ accepted: true }),
          inputSchema: z.object({ sourceClaimId: z.string() }).passthrough(),
        },
      } as any,
      blackboard,
      model,
      onReportBatch(findings) {
        committedReports += findings.length;
        return { added: true };
      },
      role: 'reporter',
    });

    let error: unknown;
    try {
      await worker.executeTask({
        assignedAgent: reporter.value.agentId,
        createdAt: new Date().toISOString(),
        dependencies: [],
        description: 'Report accepted findings',
        parameters: {},
        priority: 'high',
        requiredRole: 'reporter',
        status: 'in_progress',
        taskId: 'task_report_integrity',
        taskType: 'report',
        updatedAt: new Date().toISOString(),
      });
    } catch (error_) {
      error = error_;
    } finally {
      worker.terminate();
    }

    expect((error as Error).message).to.include('do not match accepted vulnerability claims');
    expect((error as Error).message).to.include('unknown: wrong-claim');
    expect(committedReports).to.equal(0);
  });

  it('accepts an exact one-to-one structured report mapping', async () => {
    const blackboard = await Blackboard.create({
      runId: 'test-reporter-complete',
      storagePath: storageDir,
    });
    const author = blackboard.registerAgent('recon');
    const verifier = blackboard.registerAgent('verifier');
    const reporter = blackboard.registerAgent('reporter');
    if (!author.ok || !verifier.ok || !reporter.ok) throw new Error('Registration failed');
    const claim = await blackboard.submitClaim(
      author.value.agentId,
      'vulnerability_candidate',
      { title: 'Path traversal' },
    );
    if (!claim.ok) throw new Error(claim.error);
    const verified = blackboard.verifyClaim(claim.value.claimId, verifier.value.agentId);
    if (!verified.ok) throw new Error(verified.error);
    let reports = 0;
    const responses = [
      new AIMessage({
        content: '',
        tool_calls: [{
          args: { sourceClaimId: claim.value.claimId },
          id: 'report-complete',
          name: 'report_finding',
        }],
      }),
      new AIMessage({
        content: '',
        tool_calls: [{ args: {}, id: 'finish-complete-report', name: 'finish_task' }],
      }),
      new AIMessage('complete report'),
    ];
    const worker = new AgentWorker({
      agentId: reporter.value.agentId,
      allTools: {
        finish_task: {
          description: 'Finish.',
          async execute() { return 'finished'; },
          inputSchema: z.object({}),
        },
        report_finding: {
          description: 'Report.',
          async execute() { return { accepted: true }; },
          inputSchema: z.object({ sourceClaimId: z.string() }).passthrough(),
        },
      } as any,
      blackboard,
      model: {
        bindTools() {
          return { async invoke() { return responses.shift(); } };
        },
      } as any,
      onReportBatch(findings) {
        reports += findings.length;
        return { added: true };
      },
      role: 'reporter',
    });
    try {
      const result = await worker.executeTask({
        assignedAgent: reporter.value.agentId,
        createdAt: new Date().toISOString(),
        dependencies: [],
        description: 'Report accepted findings',
        parameters: {},
        priority: 'high',
        requiredRole: 'reporter',
        status: 'in_progress',
        taskId: 'task_report_complete',
        taskType: 'report',
        updatedAt: new Date().toISOString(),
      });
      expect(result).to.equal('finished');
      expect(reports).to.equal(1);
    } finally {
      worker.terminate();
    }
  });

  it('rejects worker output that omits finish_task', async () => {
    const blackboard = await Blackboard.create({
      runId: 'test-terminal-integrity',
      storagePath: storageDir,
    });
    const registration = blackboard.registerAgent('recon');
    if (!registration.ok) throw new Error(registration.error);
    const worker = new AgentWorker({
      agentId: registration.value.agentId,
      allTools: {} as any,
      blackboard,
      model: {
        bindTools() {
          return { async invoke() { return new AIMessage('plain text only'); } };
        },
      } as any,
      role: 'recon',
    });

    let error: unknown;
    try {
      await worker.executeTask({
        assignedAgent: registration.value.agentId,
        createdAt: new Date().toISOString(),
        dependencies: [],
        description: 'Inspect source',
        parameters: {},
        priority: 'high',
        requiredRole: 'recon',
        status: 'in_progress',
        taskId: 'task_terminal_integrity',
        taskType: 'recon',
        updatedAt: new Date().toISOString(),
      });
    } catch (error_) {
      error = error_;
    } finally {
      worker.terminate();
    }

    expect((error as Error).message).to.include('did not complete');
  });

  it('isolates completed sequential missions in distinct checkpoint threads', async function () {
    this.timeout(15_000);
    const model = {
      bindTools() {
        return {
          async invoke(messages: Array<{ getType?: () => string }>) {
            if (messages.some((message) => message.getType?.() === 'tool')) {
              return new AIMessage('mission report');
            }

            return new AIMessage({
              content: '',
              tool_calls: [{ args: {}, id: `finish-${Math.random()}`, name: 'finish_task' }],
            });
          },
        };
      },
    } as any;
    const coordinator = new SwarmCoordinator({
      allTools: {
        finish_task: {
          description: 'Finish the assigned task.',
          execute: async () => 'finished',
          inputSchema: z.object({}),
        },
      } as any,
      config: { model: 'test-model', provider: 'test-provider' } as any,
      model,
      runId: 'sequential-missions',
      storagePath: storageDir,
    });

    expect(await coordinator.executeMission('first mission')).to.equal('finished');
    const firstThread = (coordinator as any).currentThreadId as string;
    const firstTaskIds = coordinator.getBlackboard().getTaskGraph().getAllTasks()
      .map((task) => task.taskId);
    expect(firstTaskIds).not.to.be.empty;

    expect(await coordinator.executeMission('second mission')).to.equal('finished');
    const secondThread = (coordinator as any).currentThreadId as string;
    const secondTasks = coordinator.getBlackboard().getTaskGraph().getAllTasks();
    expect(secondThread).not.to.equal(firstThread);
    expect(secondTasks).not.to.be.empty;
    expect(secondTasks.every((task) => !firstTaskIds.includes(task.taskId))).to.equal(true);
    expect(secondTasks.find((task) => task.taskType === 'recon')?.parameters.userMessage)
      .to.equal('second mission');
  });

  it('removes terminated workers so later missions can recreate them', async () => {
    const coordinator = new SwarmCoordinator({
      allTools: {},
      config: {} as any,
      model: {} as any,
      runId: 'worker-cleanup',
      storagePath: storageDir,
    });
    const workers = (coordinator as any).workers as Map<string, { terminate(): void }>;
    workers.set('agent-1', { terminate() {} });
    coordinator.terminateAllWorkers();
    expect(workers.size).to.equal(0);
  });
});
