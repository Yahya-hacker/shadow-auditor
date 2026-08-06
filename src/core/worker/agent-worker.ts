/** Request-correlated worker host for AgentSession. */

import { isMainThread, parentPort } from 'node:worker_threads';

import type { ShadowConfig } from '../../utils/config.js';
import type { AgentSessionOptions, AgentStreamEvent } from '../agent.js';

import { AgentSession } from '../agent.js';

const PROTOCOL_VERSION = 1;

interface BaseMessage {
  protocolVersion: number;
  requestId: string;
}

type WorkerInMessage =
  | (BaseMessage & { answer: boolean | string; type: 'resume' })
  | (BaseMessage & {
    config: ShadowConfig;
    options: AgentSessionOptions;
    repoMap: string;
    targetPath: string;
    type: 'init';
  })
  | (BaseMessage & { message: string; type: 'send' })
  | (BaseMessage & { type: 'shutdown' });

if (isMainThread) {
  throw new Error('agent-worker.ts must be run as a Worker, not on the main thread');
}

const port = parentPort!;
let agent: AgentSession | null = null;

function post(requestId: string, message: Record<string, unknown>): void {
  port.postMessage({ ...message, protocolVersion: PROTOCOL_VERSION, requestId });
}

function streamCallbacks(requestId: string) {
  return {
    onChunk(chunk: string) {
      post(requestId, { text: chunk, type: 'chunk' });
    },
    onEvent(event: AgentStreamEvent) {
      post(requestId, { event, type: 'event' });
      if (event.kind === 'human_input_required' && event.humanInputRequest) {
        post(requestId, {
          request: event.humanInputRequest,
          type: 'human_input_required',
        });
      }
    },
  };
}

port.on('message', async (message: WorkerInMessage) => {
  const { requestId } = message;
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    post(requestId, {
      message: `Unsupported worker protocol version: ${message.protocolVersion}.`,
      type: 'error',
    });
    return;
  }

  try {
    switch (message.type) {
      case 'init': {
        if (agent) throw new Error('Agent worker is already initialized.');
        agent = new AgentSession(message.config, message.repoMap, message.targetPath, message.options);
        await agent.waitForReady();
        post(requestId, { type: 'ready' });
        for (const warning of agent.warnings) post(requestId, { message: warning, type: 'warning' });
        break;
      }

      case 'resume': {
        if (!agent) throw new Error('Agent not initialized.');
        const callbacks = streamCallbacks(requestId);
        const result = await agent.resumeWithHumanInput(message.answer, callbacks.onChunk, callbacks.onEvent);
        post(requestId, { result, type: 'done' });
        break;
      }

      case 'send': {
        if (!agent) throw new Error('Agent not initialized.');
        const callbacks = streamCallbacks(requestId);
        const result = await agent.sendMessage(message.message, callbacks.onChunk, callbacks.onEvent);
        post(requestId, { result, type: 'done' });
        break;
      }

      case 'shutdown': {
        const currentAgent = agent;
        agent = null;
        await currentAgent?.dispose();
        post(requestId, { type: 'shutting_down' });
        port.close();
        break;
      }
    }
  } catch (error) {
    post(requestId, {
      message: error instanceof Error ? error.message : String(error),
      type: 'error',
    });
  }
});
