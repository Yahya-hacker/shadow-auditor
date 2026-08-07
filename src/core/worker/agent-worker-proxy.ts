/**
 * Main-thread proxy for AgentSession running in a Worker thread.
 *
 * Every operation is request-correlated and dispatched through one listener,
 * preventing chunks or completion messages from leaking between requests.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

import type { ShadowConfig } from '../../utils/config.js';
import type { AgentSessionOptions, AgentStreamEvent } from '../agent.js';
import type { HumanInputRequest } from '../graph/state.js';

const PROTOCOL_VERSION = 1;

interface WorkerOutMessage {
  event?: AgentStreamEvent;
  message?: string;
  protocolVersion: number;
  request?: HumanInputRequest;
  requestId: string;
  result?: string;
  text?: string;
  type: 'chunk' | 'done' | 'error' | 'event' | 'human_input_required' | 'ready' | 'shutting_down' | 'warning';
}

interface PendingRequest {
  onChunk?: (text: string) => void;
  onEvent?: (event: AgentStreamEvent) => void;
  reject: (error: Error) => void;
  resolve: (result: string) => void;
}

export class AgentSessionWorker {
  private disposed = false;
  private pauseRequest: HumanInputRequest | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly readyPromise: Promise<void>;
  private readonly worker: Worker;

  constructor(
    config: ShadowConfig,
    repoMap: string,
    targetPath: string,
    options: AgentSessionOptions = {},
  ) {
    const workerPath = path.resolve(import.meta.dirname, 'agent-worker.js');
    this.worker = new Worker(workerPath);
    this.worker.on('error', (error) => this.rejectAll(error));
    this.worker.on('exit', (code) => {
      if (code !== 0 || !this.disposed) {
        this.rejectAll(new Error(`Agent worker exited unexpectedly with code ${code}.`));
      }
    });
    this.worker.on('message', (message: WorkerOutMessage) => this.dispatch(message));
    this.worker.on('messageerror', (error) => this.rejectAll(error));

    const requestId = randomUUID();
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.pending.set(requestId, {
        reject,
        resolve: () => resolve(),
      });
    });
    this.worker.postMessage({
      config,
      options,
      protocolVersion: PROTOCOL_VERSION,
      repoMap,
      requestId,
      targetPath,
      type: 'init',
    });
  }

  get ready(): Promise<void> {
    return this.readyPromise;
  }

  getHumanInputRequest(): HumanInputRequest | null {
    return this.pauseRequest;
  }

  isPausedAwaitingHumanInput(): boolean {
    return this.pauseRequest !== null;
  }

  resumeWithHumanInput(
    answer: boolean | string,
    onChunk: (text: string) => void,
    onEvent?: (event: AgentStreamEvent) => void,
  ): Promise<string> {
    if (!this.pauseRequest) {
      return Promise.reject(new Error('Agent worker is not awaiting human input.'));
    }

    this.pauseRequest = null;
    return this.startRequest('resume', { answer }, onChunk, onEvent);
  }

  sendMessage(
    userMessage: string,
    onChunk: (text: string) => void,
    onEvent?: (event: AgentStreamEvent) => void,
  ): Promise<string> {
    return this.startRequest('send', { message: userMessage }, onChunk, onEvent);
  }

  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAll(new Error('Agent worker is shutting down.'));
    const requestId = randomUUID();
    const acknowledged = new Promise<string>((resolve, reject) => {
      this.pending.set(requestId, { reject, resolve });
    });
    this.worker.postMessage({
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      type: 'shutdown',
    });
    await acknowledged;
    await this.worker.terminate();
  }

  private dispatch(message: WorkerOutMessage): void {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      this.rejectAll(new Error(`Unsupported worker protocol version: ${message.protocolVersion}.`));
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) return;

    switch (message.type) {
      case 'chunk': {
        pending.onChunk?.(message.text ?? '');
        break;
      }

      case 'done':
      case 'ready': {
        this.pending.delete(message.requestId);
        pending.resolve(message.result ?? '');
        break;
      }

      case 'error': {
        this.pending.delete(message.requestId);
        pending.reject(new Error(message.message ?? 'Agent worker failed.'));
        break;
      }

      case 'event': {
        if (message.event) pending.onEvent?.(message.event);
        break;
      }

      case 'human_input_required': {
        this.pending.delete(message.requestId);
        this.pauseRequest = message.request ?? null;
        pending.resolve(`[AWAITING_HUMAN_INPUT] ${message.request?.question ?? ''}`);
        break;
      }

      case 'shutting_down': {
        this.pending.delete(message.requestId);
        pending.resolve('');
        break;
      }

      case 'warning': {
        break;
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private startRequest(
    type: 'resume' | 'send',
    payload: { answer: boolean | string } | { message: string },
    onChunk: (text: string) => void,
    onEvent?: (event: AgentStreamEvent) => void,
  ): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('Agent worker is shut down.'));
    if (this.pending.size > 0) {
      return Promise.reject(new Error('Another agent worker operation is already in progress.'));
    }

    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { onChunk, onEvent, reject, resolve });
      this.worker.postMessage({
        ...payload,
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        type,
      });
    });
  }
}
