/**
 * Agent Worker — runs AgentSession in a Node.js Worker thread.
 *
 * The main thread (Ink TUI) communicates with this worker via postMessage.
 * This keeps LangGraph's CPU-intensive work (parsing, graph computation,
 * streaming) off the main thread, so the TUI remains responsive to
 * keystrokes even during heavy analysis.
 *
 * Protocol:
 *   Main → Worker:
 *     { type: 'init', config, targetPath, options }
 *     { type: 'send', message }
 *     { type: 'resume', answer }
 *     { type: 'shutdown' }
 *
 *   Worker → Main:
 *     { type: 'ready' }
 *     { type: 'chunk', text }
 *     { type: 'event', event }
 *     { type: 'done', result }
 *     { type: 'human_input_required', request }
 *     { type: 'error', message }
 *     { type: 'warning', message }
 */

import { isMainThread, parentPort, workerData } from 'node:worker_threads';

import type { ShadowConfig } from '../../utils/config.js';
import type { AgentStreamEvent } from '../agent.js';

import { AgentSession } from '../agent.js';

// Only run in worker context
if (isMainThread) {
  throw new Error('agent-worker.ts must be run as a Worker, not on the main thread');
}

const port = parentPort!;

interface InitMessage {
  config: ShadowConfig;
  options: { diffScopeHint?: string; expertUnsafe?: boolean };
  repoMap: string;
  targetPath: string;
}

interface CommandMessage {
  message: string;
  type: 'send';
}

interface ResumeMessage {
  answer: boolean | string;
  type: 'resume';
}

interface ShutdownMessage {
  type: 'shutdown';
}

type WorkerInMessage =
  | CommandMessage
  | (InitMessage & { type: 'init' })
  | ResumeMessage
  | ShutdownMessage;

let agent: AgentSession | null = null;

port.on('message', async (msg: WorkerInMessage) => {
  try {
    switch (msg.type) {
      case 'init': {
        const { config, options, repoMap, targetPath } = msg;
        agent = new AgentSession(config, repoMap, targetPath, options);
        // Wait for initialization to complete
        await (agent as any).initialized;
        port.postMessage({ type: 'ready' });
        // Forward any runtime warnings
        const warnings = (agent as any).runtimeWarnings as string[] | undefined;
        if (warnings) {
          for (const w of warnings) {
            port.postMessage({ message: w, type: 'warning' });
          }
        }

        break;
      }

      case 'resume': {
        if (!agent) {
          port.postMessage({ message: 'Agent not initialized', type: 'error' });
          return;
        }

        const result = await agent.resumeWithHumanInput(
          msg.answer,
          (chunk: string) => {
            port.postMessage({ text: chunk, type: 'chunk' });
          },
          (event: AgentStreamEvent) => {
            port.postMessage({ event, type: 'event' });
            if (event.kind === 'human_input_required' && event.humanInputRequest) {
              port.postMessage({
                request: event.humanInputRequest,
                type: 'human_input_required',
              });
            }
          },
        );

        port.postMessage({ result, type: 'done' });
        break;
      }

      case 'send': {
        if (!agent) {
          port.postMessage({ message: 'Agent not initialized', type: 'error' });
          return;
        }

        const result = await agent.sendMessage(
          msg.message,
          // onChunk — stream text chunks back to main thread
          (chunk: string) => {
            port.postMessage({ text: chunk, type: 'chunk' });
          },
          // onEvent — stream activity events back to main thread
          (event: AgentStreamEvent) => {
            port.postMessage({ event, type: 'event' });

            // Human input requests need special handling — the TUI must
            // pause and show the question. The worker holds the graph
            // state, so resume must come back as a 'resume' message.
            if (event.kind === 'human_input_required' && event.humanInputRequest) {
              port.postMessage({
                request: event.humanInputRequest,
                type: 'human_input_required',
              });
            }
          },
        );

        port.postMessage({ result, type: 'done' });
        break;
      }

      case 'shutdown': {
        agent = null;
        process.exit(0);
      }
    }
  } catch (error) {
    port.postMessage({
      message: error instanceof Error ? error.message : String(error),
      type: 'error',
    });
  }
});
