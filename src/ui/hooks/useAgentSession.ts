import { useCallback, useRef } from 'react';

import type { ShadowConfig } from '../../utils/config.js';

import { AgentSession } from '../../core/agent.js';

export interface SessionInitOptions {
  diffScopeHint?: string;
  expertUnsafe?: boolean;
}

export function useAgentSession() {
  const agentSessionRef = useRef<AgentSession | null>(null);

  const initSession = useCallback(async (
    config: ShadowConfig,
    targetPath: string,
    options: SessionInitOptions,
  ) => {
    const { generateRepoMap } = await import('../../utils/repo-map.js');
    const map = await generateRepoMap(targetPath);

    const session = new AgentSession(config, map, targetPath, {
      diffScopeHint: options.diffScopeHint,
      expertUnsafe: options.expertUnsafe,
    });

    agentSessionRef.current = session;
  }, []);

  return {
    agentSessionRef,
    initSession,
  };
}
