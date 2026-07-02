import React, { createContext, useContext } from 'react';

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
}> = ({ agentSessionRef, children }) => (
  <AgentSessionContext.Provider value={{ agentSessionRef }}>
    {children}
  </AgentSessionContext.Provider>
);
