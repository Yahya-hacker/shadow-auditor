import { useCallback, useRef } from 'react';

import type { ShadowConfig } from '../../utils/config.js';

import { AgentSession } from '../../core/agent.js';

export interface SessionInitOptions {
  diffScopeHint?: string;
  expertUnsafe?: boolean;
  /** Name of the user, collected during onboarding, passed to the AI. */
  userName?: string;
}

/** Shared interface for both direct and worker-backed agent sessions. */
export interface AgentSessionLike {
  sendMessage(
    userMessage: string,
    onChunk: (text: string) => void,
    onEvent?: (event: import('../../core/agent.js').AgentStreamEvent) => void,
  ): Promise<string>;
  resumeWithHumanInput(
    answer: boolean | string,
    onChunk: (text: string) => void,
    onEvent?: (event: import('../../core/agent.js').AgentStreamEvent) => void,
  ): Promise<string>;
  isPausedAwaitingHumanInput(): boolean | Promise<boolean>;
}

// Module-level cache for the repo map generation promise
let repoMapPromiseCache: null | { path: string; promise: Promise<string> } = null;

/**
 * Start generating the repo map in the background.
 * This can be called early (e.g., when target is selected) to avoid blocking
 * the UI during session initialization.
 */
export function startRepoMapGeneration(targetPath: string): void {
  // Only start if not already in progress for this path
  if (repoMapPromiseCache && repoMapPromiseCache.path === targetPath) {
    return;
  }

  repoMapPromiseCache = {
    path: targetPath,
    promise: import('../../utils/repo-map.js').then((m) => m.generateRepoMap(targetPath)),
  };
}

export function useAgentSession() {
  const agentSessionRef = useRef<AgentSessionLike | null>(null);

  const initSession = useCallback(async (
    config: ShadowConfig,
    targetPath: string,
    options: SessionInitOptions,
  ) => {
    // Use cached repo map if available, otherwise generate it
    let map: string;
    if (repoMapPromiseCache && repoMapPromiseCache.path === targetPath) {
      map = await repoMapPromiseCache.promise;
    } else {
      const { generateRepoMap } = await import('../../utils/repo-map.js');
      map = await generateRepoMap(targetPath);
    }

    const session = new AgentSession(config, map, targetPath, {
      diffScopeHint: options.diffScopeHint,
      expertUnsafe: options.expertUnsafe,
      userName: options.userName,
    });

    agentSessionRef.current = session;
  }, []);

  return {
    agentSessionRef,
    initSession,
  };
}
