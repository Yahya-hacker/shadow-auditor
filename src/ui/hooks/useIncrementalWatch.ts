import { type MutableRefObject, useEffect } from 'react';

import type { AgentSessionLike } from './useAgentSession.js';

import {
  calculateSecurityDelta,
  formatSecurityDelta,
  IncrementalWatchService,
  updateWatchBaseline,
} from '../../core/watch/incremental-watch.js';
import { toUserFacingError } from '../../utils/error-classification.js';
import { useAppStore } from '../store/appStore.js';
import { createThrottledStream } from './useAgentSubmit.js';

export function useIncrementalWatch(
  enabled: boolean,
  targetPath: null | string,
  agentSessionRef: MutableRefObject<AgentSessionLike | null>,
): void {
  useEffect(() => {
    if (!enabled || !targetPath) return;
    let findingsBaseline = agentSessionRef.current?.getLatestFindings() ?? [];

    const watcher = new IncrementalWatchService({
      canProcess() {
        const state = useAppStore.getState();
        return !state.streaming && !state.confirmation.open && !state.humanInputRequest;
      },
      async onBatch(changedFiles) {
        const session = agentSessionRef.current;
        if (!session) return;
        const store = useAppStore.getState();
        const previousFindings = findingsBaseline;
        store.addSystemMessage(
          `Watch detected ${changedFiles.length} changed file${changedFiles.length === 1 ? '' : 's'}; starting an incremental security audit.`,
        );
        store.clearActivity();
        store.startStreaming();
        const stream = createThrottledStream();
        const scope = changedFiles.map((file) => `- ${file}`).join('\n');
        const prompt = [
          'AUTOMATED INCREMENTAL SECURITY AUDIT.',
          'Analyze the changed files below and only the immediate cross-file dependencies required to establish reachability.',
          'Report complete findings using the normal deterministic audit pipeline. Do not modify files.',
          '',
          scope,
        ].join('\n');

        try {
          const finalAnswer = await session.sendMessage(prompt, stream.onChunk, stream.onEvent);
          stream.finish();
          store.finishStreaming(finalAnswer);
          const delta = calculateSecurityDelta(
            previousFindings,
            session.getLatestFindings(),
            changedFiles,
          );
          findingsBaseline = updateWatchBaseline(delta);
          useAppStore.getState().addSystemMessage(formatSecurityDelta(delta));
        } catch (error) {
          stream.finish();
          store.finishStreaming();
          store.addErrorMessage(toUserFacingError(error instanceof Error ? error.message : String(error)));
        }
      },
      onError(error) {
        useAppStore.getState().addErrorMessage(`Watch audit failed: ${error.message}`);
      },
      root: targetPath,
    });

    watcher.start().then(() => {
      useAppStore.getState().addSystemMessage('Watch mode active. Security audits will run when source files change.');
    }).catch((error: unknown) => {
      useAppStore.getState().addErrorMessage(
        `Watch mode failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    return () => {
      watcher.close().catch((error: unknown) => {
        useAppStore.getState().addErrorMessage(
          `Watch shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    };
  }, [agentSessionRef, enabled, targetPath]);
}
