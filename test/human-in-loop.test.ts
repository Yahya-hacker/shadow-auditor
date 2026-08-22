import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import {
  Annotation,
  END,
  MemorySaver,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { expect } from 'chai';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

import { wrapTool } from '../src/core/graph/tools/langchain-wrapper.js';
import { createPathGuard } from '../src/core/policy/path-guard.js';
import { createEditFileTool, replaceAllExact } from '../src/core/tools/edit-file.js';
import { createExecuteCommandTool } from '../src/core/tools/execute-command.js';
import { useAppStore } from '../src/ui/store/appStore.js';
import { HumanInteractionService } from '../src/utils/human-in-loop.js';

async function beginCommandConfirmation(service: HumanInteractionService, command: string): Promise<void> {
  let interrupted = false;
  try {
    await service.confirmCommandExecution(command);
  } catch {
    interrupted = true;
  }

  expect(interrupted).to.equal(true);
}

describe('human interaction isolation', () => {
  it('restores a checkpointed confirmation identity after a process restart', async () => {
    const firstProcess = new HumanInteractionService();
    firstProcess.enableLangGraphContext();
    await beginCommandConfirmation(firstProcess, 'echo restarted');

    const requestId = createHash('sha256')
      .update(JSON.stringify([
        'PROPOSED COMMAND EXECUTION',
        'Allow execution of command: echo restarted?',
        null,
      ]))
      .digest('hex');
    const restartedProcess = new HumanInteractionService();
    restartedProcess.enableLangGraphContext();

    expect(restartedProcess.resolvePendingDecision(true, requestId)).to.equal(true);
    expect(await restartedProcess.confirmCommandExecution('echo restarted')).to.equal(true);
  });

  it('consumes an explicit denial on replay', async () => {
    const service = new HumanInteractionService();
    service.enableLangGraphContext();

    await beginCommandConfirmation(service, 'echo denied');
    expect(service.resolvePendingDecision(false)).to.equal(true);
    expect(await service.confirmCommandExecution('echo denied')).to.equal(false);
  });

  it('rejects stale and duplicate decisions', async () => {
    const service = new HumanInteractionService();
    service.enableLangGraphContext();

    expect(service.resolvePendingDecision(true)).to.equal(false);
    await beginCommandConfirmation(service, 'echo once');
    expect(service.resolvePendingDecision(true)).to.equal(true);
    expect(service.resolvePendingDecision(true)).to.equal(false);
    expect(await service.confirmCommandExecution('echo once')).to.equal(true);
    expect(service.resolvePendingDecision(true)).to.equal(false);
  });

  it('keeps pending decisions isolated between service instances', async () => {
    const first = new HumanInteractionService();
    const second = new HumanInteractionService();
    first.enableLangGraphContext();
    second.enableLangGraphContext();

    await beginCommandConfirmation(first, 'echo first');
    await beginCommandConfirmation(second, 'echo second');
    first.reset();

    expect(first.resolvePendingDecision(true)).to.equal(false);
    expect(second.resolvePendingDecision(false)).to.equal(true);
    expect(await second.confirmCommandExecution('echo second')).to.equal(false);
  });

  it('does not execute a denied command', async () => {
    const service = new HumanInteractionService();
    service.enableLangGraphContext();
    const command = 'echo should-not-run';
    const tool = createExecuteCommandTool({
      commandPolicy: {},
      humanInteraction: service,
      workingDirectory: process.cwd(),
    });

    let interrupted = false;
    try {
      await tool.execute({ command });
    } catch {
      interrupted = true;
    }

    expect(interrupted).to.equal(true);

    expect(service.resolvePendingDecision(false)).to.equal(true);
    expect(await tool.execute({ command })).to.equal(
      `[DENIED] User denied command execution: "${command}".`,
    );
  });

  it('does not resolve safe commands from the audited repository', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-command-path-'));
    const marker = path.join(root, 'executed.txt');
    const executable = path.join(root, process.platform === 'win32' ? 'git.cmd' : 'git');
    const originalPath = process.env.PATH;
    await fs.writeFile(
      executable,
      process.platform === 'win32'
        ? `@echo planted>${marker}\r\n`
        : `#!/bin/sh\nprintf planted > '${marker}'\n`,
      'utf8',
    );
    if (process.platform !== 'win32') await fs.chmod(executable, 0o755);
    process.env.PATH = `${root}${path.delimiter}${originalPath ?? ''}`;

    try {
      const service = new HumanInteractionService();
      service.enableLangGraphContext();
      const tool = createExecuteCommandTool({
        commandPolicy: {},
        humanInteraction: service,
        workingDirectory: root,
      });

      let interrupted = false;
      try {
        await tool.execute({command: 'git status'});
      } catch {
        interrupted = true;
      }

      expect(interrupted).to.equal(true);
      expect(service.resolvePendingDecision(true)).to.equal(true);
      await tool.execute({command: 'git status'});
      let markerExists = true;
      try {
        await fs.access(marker);
      } catch {
        markerExists = false;
      }

      expect(markerExists).to.equal(false);
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(root, {force: true, recursive: true});
    }
  });

  it('does not write a denied edit', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-hil-'));
    const filePath = path.join(root, 'target.txt');
    await fs.writeFile(filePath, 'before', 'utf8');

    try {
      const service = new HumanInteractionService();
      service.enableLangGraphContext();
      const tool = createEditFileTool(await createPathGuard(root), service);
      const input = { filePath: 'target.txt', replacementCode: 'after', targetCode: 'before' };
      let interrupted = false;

      try {
        await tool.execute(input);
      } catch {
        interrupted = true;
      }

      expect(interrupted).to.equal(true);
      expect(service.resolvePendingDecision(false)).to.equal(true);
      expect(await tool.execute(input)).to.contain('DENIED');
      expect(await fs.readFile(filePath, 'utf8')).to.equal('before');
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  it('does not reuse approval for different edit contents', async () => {
    const service = new HumanInteractionService();
    service.enableLangGraphContext();

    let firstInterrupted = false;
    try {
      await service.confirmFileEdit('target.txt', 'before', 'safe');
    } catch {
      firstInterrupted = true;
    }

    expect(firstInterrupted).to.equal(true);
    expect(service.resolvePendingDecision(true)).to.equal(true);
    expect(await service.confirmFileEdit('target.txt', 'before', 'safe')).to.equal(true);

    let interrupted = false;
    try {
      await service.confirmFileEdit('target.txt', 'before', 'different');
    } catch {
      interrupted = true;
    }

    expect(interrupted).to.equal(true);
  });

    it('replaceAllExact replaces every occurrence and reports the real count', () => {
      const content = 'x = 1;\nif (x && x) { use(x); }\n// x remains\nx += 1;';
      const result = replaceAllExact(content, 'x', 'value');

      // The literal 'x' appears in "use(x)" and "x;"/"x &&" etc — verify it is
      // not present anywhere in the output (a single-pass global replace).
      expect(result.content.includes('x')).to.equal(false);
      // {{occurrences}} equals the number of split pieces minus one.
      expect(result.occurrences).to.equal(content.split('x').length - 1);
    });

    it('replaceAllExact returns the original when the target is absent', () => {
      const content = 'hello world';
      const result = replaceAllExact(content, 'zzz', 'q');
      expect(result.content).to.equal(content);
      expect(result.occurrences).to.equal(0);
    });

  it('requires a new confirmation for an identical side-effecting operation', async () => {
    const service = new HumanInteractionService();
    service.enableLangGraphContext();

    await beginCommandConfirmation(service, 'echo repeat');
    expect(service.resolvePendingDecision(true)).to.equal(true);
    expect(await service.confirmCommandExecution('echo repeat')).to.equal(true);

    await beginCommandConfirmation(service, 'echo repeat');
  });

  it('collects explicit patch revision instructions without applying approval', async () => {
    const service = new HumanInteractionService();
    const review = service.reviewValidatedPatch({
      diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n',
      findingId: 'finding-1',
      testResult: {
        command: 'npm test',
        degraded: false,
        durationMs: 10,
        exitCode: 0,
        fingerprint: {
          entries: [{ status: 'pass', testName: 'validation' }],
          exitCode: 0,
          framework: 'npm',
          hash: 'hash',
          outputLineCount: 1,
          timestamp: new Date().toISOString(),
        },
        framework: 'npm',
        newFailures: [],
        passed: true,
        resolvedFailures: [],
        stderr: '',
        stdout: 'validation passed',
      },
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    useAppStore.getState().confirmation.onSelect?.('revise');
    expect(useAppStore.getState().confirmation.kind).to.equal('text');
    useAppStore.getState().confirmation.onSelect?.('Use the shared sanitizer.');

    expect(await review).to.deep.equal({
      action: 'revise',
      instructions: 'Use the shared sanitizer.',
    });
    useAppStore.getState().closeConfirmation();
  });

  it('pauses and denies a tool exactly once through a compiled graph', async () => {
    const service = new HumanInteractionService();
    service.enableLangGraphContext();
    let executions = 0;
    const confirmTool = wrapTool({
      description: 'Run an operation after confirmation.',
      async execute() {
        if (!await service.confirmCommandExecution('echo graph-confirmation')) {
          return 'denied';
        }

        executions++;
        return 'executed';
      },
      inputSchema: z.object({}),
    }, 'confirm_operation');
    /* eslint-disable new-cap */
    const GraphState = Annotation.Root({
      messages: Annotation<BaseMessage[]>({
        default: () => [],
        reducer: (left, right) => [...left, ...right],
      }),
      pendingHumanInput: Annotation<undefined | {
        context?: string;
        question: string;
        type: 'confirmation';
      }>(),
    });
    const graph = new StateGraph(GraphState)
      .addNode('tools', new ToolNode([confirmTool]), { ends: ['HumanIntervention'] })
      .addNode('HumanIntervention', () => ({}))
      .addEdge(START, 'tools')
      .addEdge('tools', END)
      .addEdge('HumanIntervention', 'tools')
      .compile({
        checkpointer: new MemorySaver(),
        interruptBefore: ['HumanIntervention'],
      });
    /* eslint-enable new-cap */

    const config = { configurable: { thread_id: 'confirmation-graph' } };
    const paused = await graph.invoke({
      messages: [new AIMessage({
        content: '',
        tool_calls: [{ args: {}, id: 'confirm-call', name: 'confirm_operation' }],
      })],
    }, config);

    expect(paused.pendingHumanInput?.question).to.contain('echo graph-confirmation');
    expect((await graph.getState(config)).next).to.include('HumanIntervention');
    expect(executions).to.equal(0);
    expect(service.resolvePendingDecision(false)).to.equal(true);

    const completed = await graph.invoke(null, config);
    const toolMessages = completed.messages.filter((message) => message.getType() === 'tool');
    expect(toolMessages).to.have.length(1);
    expect(String(toolMessages[0]?.content)).to.equal('denied');
    expect(executions).to.equal(0);
    expect(service.resolvePendingDecision(true)).to.equal(false);
  });
});
