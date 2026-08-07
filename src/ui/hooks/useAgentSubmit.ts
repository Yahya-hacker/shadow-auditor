/**
 * useAgentSubmit — unified submit handler for the agent shell.
 *
 * Extracted from ShellScreen.tsx's `useHandleSubmit` to deduplicate the
 * two execution paths (human-input confirmation and normal message) and
 * centralize auth-error detection via `isAuthError`.
 */

import { useCallback } from 'react';

import type { AgentStreamEvent } from '../../core/agent.js';

import { toUserFacingError } from '../../utils/error-classification.js';
import { useAgentSessionRef } from '../AgentSessionContext.js';
import { requestShutdown } from '../shutdown.js';
import { useAppStore } from '../store/appStore.js';

// ============================================================================
// Stream throttling — batch chunks at 100ms so React re-renders 10×/sec
// ============================================================================

export function createThrottledStream(intervalMs = 100) {
  let chunkBuffer = '';
  let eventBuffer: AgentStreamEvent[] = [];
  let flushTimer: null | ReturnType<typeof setTimeout> = null;
  // Capture the generation at creation time so we can discard chunks
  // from a previous (aborted) stream when startStreaming() is called again.
  const generation = useAppStore.getState().streamGeneration;

  const flush = () => {
    flushTimer = null;
    const store = useAppStore.getState();
    // Discard if a new stream has started since this one was created.
    if (store.streamGeneration !== generation) {
      chunkBuffer = '';
      eventBuffer = [];
      return;
    }

    if (chunkBuffer) {
      store.appendStreamChunk(chunkBuffer);
      chunkBuffer = '';
    }

    for (const evt of eventBuffer) store.addActivityEvent(evt);
    eventBuffer = [];
  };

  return {
    finish() {
      if (flushTimer) clearTimeout(flushTimer);
      flush();
    },
    onChunk(chunk: string) {
      chunkBuffer += chunk;
      if (!flushTimer) flushTimer = setTimeout(flush, intervalMs);
    },
    onEvent(event: AgentStreamEvent) {
      eventBuffer.push(event);
      if (!flushTimer) flushTimer = setTimeout(flush, intervalMs);
    },
  };
}

// ============================================================================
// Error display helper
// ============================================================================

function displayError(error: unknown): void {
  const store = useAppStore.getState();
  const msg = error instanceof Error ? error.message : String(error);

  store.addErrorMessage(toUserFacingError(msg));
}

// ============================================================================
// Submit handler
// ============================================================================

export function useHandleSubmit(): (command: string) => void {
  const agentSessionRef = useAgentSessionRef();

  return useCallback(async (command: string) => {
    const trimmed = command.trim();
    if (!trimmed) return;
    if ([':q', ':quit', 'exit', 'quit'].includes(trimmed.toLowerCase())) {
      await requestShutdown();
      return;
    }

    const store = useAppStore.getState();
    store.setSessionPhase('ready');
    const currentRequest = store.humanInputRequest;

    if (currentRequest) {
      // ── Human-input confirmation path ──────────────────────────────────
      store.addUserMessage(trimmed);
      store.setInput('');
      store.startStreaming();
      const stream = createThrottledStream();

      try {
        let answer: boolean | string;
        if (currentRequest.type === 'confirmation') {
          answer = ['approve', 'confirm', 'ok', 'y', 'yes'].includes(trimmed.toLowerCase());
        } else {
          answer = trimmed;
        }

        const finalAnswer = await agentSessionRef.current?.resumeWithHumanInput(answer, stream.onChunk, stream.onEvent);
        stream.finish();
        useAppStore.getState().setHumanInputRequest(null);
        useAppStore.getState().finishStreaming(finalAnswer);
      } catch (error) {
        stream.finish();
        useAppStore.getState().setHumanInputRequest(null);
        useAppStore.getState().finishStreaming();
        displayError(error);
      }

      return;
    }

    // ── Normal message path ──────────────────────────────────────────────
    store.addUserMessage(trimmed);
    store.setInput('');
    store.startStreaming();

    const stream = createThrottledStream();
    try {
      const finalAnswer = await agentSessionRef.current?.sendMessage(trimmed, stream.onChunk, stream.onEvent);
      stream.finish();
      useAppStore.getState().finishStreaming(finalAnswer);
    } catch (error) {
      stream.finish();
      useAppStore.getState().finishStreaming();
      displayError(error);
    }
  }, [agentSessionRef]);
}
