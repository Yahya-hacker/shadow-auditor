import React, { createContext, useContext } from 'react';

import type { AgentSessionLike } from './hooks/useAgentSession.js';

interface AgentSessionContextValue {
  agentSessionRef: React.MutableRefObject<AgentSessionLike | null>;
}

export const AgentSessionContext = createContext<AgentSessionContextValue | null>(null);

export function useAgentSessionRef(): React.MutableRefObject<AgentSessionLike | null> {
  const context = useContext(AgentSessionContext);
  if (!context) {
    throw new Error('useAgentSessionRef must be used within an AgentSessionProvider');
  }

  return context.agentSessionRef;
}

export const AgentSessionProvider: React.FC<{
  agentSessionRef: React.MutableRefObject<AgentSessionLike | null>;
  children: React.ReactNode;
}> = ({ agentSessionRef, children }) => {
  // The ref object identity is stable across renders, so no useMemo needed.
  const value = { agentSessionRef };
  return (
    <AgentSessionContext.Provider value={value}>
      {children}
    </AgentSessionContext.Provider>
  );
};
