/**
 * Main-thread proxy for AgentSession running in a Worker thread.
 *
 * Provides the same `sendMessage` / `resumeWithHumanInput` /
 * `isPausedAwaitingHumanInput` interface as AgentSession, but all
 * LangGraph computation happens off the main thread. The TUI stays
 * 100% responsive because Ink processes keystrokes on the main thread
 * while the Worker handles parsing, knowledge graph assembly, and
 * LLM streaming on a separate thread.
 */

import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

import type { ShadowConfig } from '../../utils/config.js';
import type { AgentSessionOptions, AgentStreamEvent } from '../agent.js';
import type { HumanInputRequest } from '../graph/state.js';

interface WorkerOutMessage {
  event?: AgentStreamEvent;
  message?: string;
  request?: HumanInputRequest;
  result?: string;
  text?: string;
  type: string;
}

/**
 * Promise-based proxy that runs AgentSession in a Worker thread.
 * Usage is identical to AgentSession:
 *
 *   const session = new AgentSessionWorker(config, repoMap, targetPath, opts);
 *   await session.ready;  // wait for init
 *   const result = await session.sendMessage("Find SQL injection", onChunk, onEvent);
 */
export class AgentSessionWorker {
  private humanInputResolve: ((answer: boolean | string) => void) | null = null;
  private pauseRequest: HumanInputRequest | null = null;
  private readyPromise: Promise<void>;
  private worker: Worker;

  constructor(
    config: ShadowConfig,
    repoMap: string,
    targetPath: string,
    options: AgentSessionOptions = {},
  ) {
    // Resolve the worker script relative to this file
    const workerPath = path.resolve(
      import.meta.dirname,
      'agent-worker.js',
    );

    this.worker = new Worker(workerPath, {
      workerData: { config, options, repoMap, targetPath },
    });

    this.readyPromise = new Promise((resolve, reject) => {
      this.worker.on('message', (msg: WorkerOutMessage) => {
        if (msg.type === 'ready') resolve();
        if (msg.type === 'error') reject(new Error(msg.message));
      });
      this.worker.on('error', reject);
    });

    // Send the init message to the worker. This is redundant with
    // workerData (which the worker also receives), but the message
    // protocol ensures proper sequencing — the worker responds with
    // 'ready' only after AgentSession initialization completes.
    this.worker.postMessage({
      config,
      options,
      repoMap,
      targetPath,
      type: 'init',
    } as any);
  }

  /** Resolves once the agent is initialized. */
  get ready(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Get the current human input request, if any.
   */
  getHumanInputRequest(): HumanInputRequest | null {
    return this.pauseRequest;
  }

  /**
   * Check if the workflow is currently paused awaiting human input.
   */
  isPausedAwaitingHumanInput(): boolean {
    return this.pauseRequest !== null;
  }

  /**
   * Resume a paused workflow with the human's answer.
   * Same signature as AgentSession.resumeWithHumanInput.
   */
  resumeWithHumanInput(
    answer: boolean | string,
    onChunk: (text: string) => void,
    onEvent?: (event: AgentStreamEvent) => void,
  ): Promise<string> {
    this.pauseRequest = null;

    return new Promise((resolve, reject) => {
      const handler = (msg: WorkerOutMessage) => {
        switch (msg.type) {
          case 'chunk': {
            onChunk(msg.text!);
            break;
          }

          case 'done': {
            this.worker.off('message', handler);
            resolve(msg.result!);
            break;
          }

          case 'error': {
            this.worker.off('message', handler);
            reject(new Error(msg.message));
            break;
          }

          case 'event': {
            onEvent?.(msg.event!);
            break;
          }

          case 'human_input_required': {
            this.pauseRequest = msg.request!;
            resolve(`[AWAITING_HUMAN_INPUT] ${msg.request!.question}`);
            this.worker.off('message', handler);
            break;
          }
        }
      };

      this.worker.on('message', handler);
      this.worker.postMessage({ answer, type: 'resume' });
    });
  }

  /**
   * Send a message to the agent and stream responses back.
   * Same signature as AgentSession.sendMessage.
   */
  sendMessage(
    userMessage: string,
    onChunk: (text: string) => void,
    onEvent?: (event: AgentStreamEvent) => void,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const handler = (msg: WorkerOutMessage) => {
        switch (msg.type) {
          case 'chunk': {
            onChunk(msg.text!);
            break;
          }

          case 'done': {
            // Only resolve if we haven't already (human_input_required
            // resolves first when an interrupt occurs).
            this.worker.off('message', handler);
            resolve(msg.result!);
            break;
          }

          case 'error': {
            this.worker.off('message', handler);
            reject(new Error(msg.message));
            break;
          }

          case 'event': {
            onEvent?.(msg.event!);
            break;
          }

          case 'human_input_required': {
            this.pauseRequest = msg.request!;
            // The TUI will call resumeWithHumanInput when the user answers.
            // Return a sentinel value so the caller knows the run is paused.
            // We don't resolve yet — that happens after resume completes.
            resolve(`[AWAITING_HUMAN_INPUT] ${msg.request!.question}`);
            this.worker.off('message', handler);
            break;
          }
        }
      };

      this.worker.on('message', handler);
      this.worker.postMessage({ message: userMessage, type: 'send' });
    });
  }

  /** Shut down the worker thread. */
  shutdown(): void {
    this.worker.postMessage({ type: 'shutdown' });
  }
}
