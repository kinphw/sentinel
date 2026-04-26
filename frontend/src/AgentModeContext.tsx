import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

export type AgentMode = 'live' | 'mock';

const STORAGE_KEY = 'sentinel:agentMode';

interface AgentModeContextValue {
  mode: AgentMode;
  setMode: (mode: AgentMode) => void;
}

const AgentModeContext = createContext<AgentModeContextValue | null>(null);

function readInitialMode(): AgentMode {
  if (typeof window === 'undefined') return 'live';
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === 'mock' ? 'mock' : 'live';
}

export function AgentModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<AgentMode>(readInitialMode);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  const setMode = useCallback((next: AgentMode) => setModeState(next), []);

  return (
    <AgentModeContext.Provider value={{ mode, setMode }}>
      {children}
    </AgentModeContext.Provider>
  );
}

export function useAgentMode(): AgentModeContextValue {
  const ctx = useContext(AgentModeContext);
  if (!ctx) throw new Error('useAgentMode must be used inside AgentModeProvider');
  return ctx;
}
