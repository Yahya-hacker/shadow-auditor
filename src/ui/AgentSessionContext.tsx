import React, { createContext, useContext, useMemo } from 'react';

import type { AgentSession } from '../core/agent.js';

interface AgentSessionContextValue {
  agentSessionRef: React.MutableRefObject<AgentSession | null>;
}

export const AgentSessionContext = createContext<AgentSessionContextValue | null>(null);

export function useAgentSessionRef(): React.MutableRefObject<AgentSession | null> {
  const context = useContext(AgentSessionContext);
  if (!context) {
    throw new Error('useAgentSessionRef must be used within an AgentSessionProvider');
  }

  return context.agentSessionRef;
}

export const AgentSessionProvider: React.FC<{
  agentSessionRef: React.MutableRefObject<AgentSession | null>;
  children: React.ReactNode;
}> = ({ agentSessionRef, children }) => {
  // Memoize the context value so consumers don't re-render when the
  // provider's parent re-renders (e.g., App.tsx screen transitions).
  const value = useMemo(() => ({ agentSessionRef }), [agentSessionRef]);
  return (
    <AgentSessionContext.Provider value={value}>
      {children}
    </AgentSessionContext.Provider>
  );
};
