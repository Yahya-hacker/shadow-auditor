/**
 * AgentWorker Tests.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { AgentWorker } from '../src/core/hivemind/agent-worker.js';
import { Blackboard } from '../src/core/hivemind/blackboard.js';
import { buildWorkerSystemPrompt } from '../src/core/hivemind/worker-prompts.js';
import { createRoleToolSet } from '../src/core/hivemind/worker-toolsets.js';

describe('AgentWorker', () => {
  let tmpDir: string;
  let storageDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-test-'));
    storageDir = path.join(tmpDir, 'storage');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { force: true, recursive: true });
  });

  it('filters tools correctly by role', () => {
    const allTools = {
      bash: {} as any,
      context_retrieval: {} as any,
      edit_file: {} as any,
      finish_task: {} as any,
      list_directory: {} as any,
      read_file_content: {} as any,
      search_codebase: {} as any,
    };

    const reconTools = createRoleToolSet('recon', allTools);
    expect(reconTools.read_file_content).to.exist;
    expect(reconTools.list_directory).to.exist;
    expect(reconTools.edit_file).to.not.exist;

    const taintTools = createRoleToolSet('taint-tracer', allTools);
    expect(taintTools.read_file_content).to.exist;
    expect(taintTools.list_directory).to.not.exist;
    expect(taintTools.edit_file).to.not.exist;

    const patchTools = createRoleToolSet('patch-engineer', allTools);
    expect(patchTools.edit_file).to.exist;
    expect(patchTools.list_directory).to.not.exist;
  });

  it('builds worker system prompts with correct roles', () => {
    const reconPrompt = buildWorkerSystemPrompt('recon', { auditMode: 'sast' });
    expect(reconPrompt).to.include('RECON WORKER MISSION');
    expect(reconPrompt).to.include('recon_entrypoint');

    const taintPrompt = buildWorkerSystemPrompt('taint-tracer', { auditMode: 'sast' });
    expect(taintPrompt).to.include('TAINT TRACER WORKER MISSION');
    expect(taintPrompt).to.include('dataflow_path');
  });

  it('registers heartbeats and offlines correctly', async () => {
    const blackboard = await Blackboard.create({
      runId: 'test-run',
      storagePath: storageDir,
    });

    const reg = blackboard.registerAgent('recon');
    expect(reg.ok).to.be.true;
    if (!reg.ok) {
      throw new Error('Registration failed');
    }

    const agentId = reg.value.agentId;

    const worker = new AgentWorker({
      agentId,
      allTools: {},
      blackboard,
      model: {} as any,
      role: 'recon',
    });

    // Check status is idle initially
    const active = blackboard.getActiveAgents();
    expect(active[0].status).to.equal('idle');

    // Terminate worker
    worker.terminate();

    // Check offline status
    const registrations = (blackboard as any).agents;
    expect(registrations.get(agentId).status).to.equal('offline');
  });
});
