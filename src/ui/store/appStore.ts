import { create } from 'zustand';

import type { AgentStreamEvent } from '../../core/agent.js';
import type { SwarmStateSnapshot } from '../../core/hivemind/swarm-supervisor.js';
import type { LicenseGateResult } from '../../core/policy/license-guard.js';
import type { ShadowConfig } from '../../utils/config.js';

export type AppScreen =
  | 'boot'
  | 'initializing'
  | 'license-blocked'
  | 'setup'
  | 'shell'
  | 'target';

export type SessionPhase = 'error' | 'idle' | 'initializing' | 'ready';

export type MessageRole = 'agent' | 'error' | 'system' | 'user';

export interface ChatMessageData {
  id: string;
  role: MessageRole;
  text: string;
}

export interface ActivityEvent {
  id: string;
  kind: string;
  text: string;
}

export interface ConfirmationState {
  details?: string;
  message: string;
  onConfirm: (confirmed: boolean) => void;
  open: boolean;
  title: string;
}

export interface AppState {
  // Activity stream
  activity: ActivityEvent[];
  addActivityEvent: (event: AgentStreamEvent) => void;
  addAgentMessage: (text: string) => void;
  addErrorMessage: (text: string) => void;

  addSystemMessage: (text: string) => void;
  addUserMessage: (text: string) => void;

  appendStreamChunk: (chunk: string) => void;
  clearActivity: () => void;
  clearChat: () => void;
  // UI interaction state for the enterprise shell: help overlay, togglable
  // swarm panel, chat search/scroll, and focus cycling between input & panel.
  clearScroll: () => void;

  closeConfirmation: () => void;
  // Configuration
  config: null | ShadowConfig;
  // Confirmation dialog
  confirmation: ConfirmationState;
  finishStreaming: () => void;
  focus: 'input' | 'panel';
  helpOpen: boolean;
  // Input
  input: string;
  licenseGate: LicenseGateResult | null;
  // Chat
  messages: ChatMessageData[];
  panelOpen: boolean;
  requestConfirmation: (params: {
    details?: string;
    message: string;
    onConfirm: (confirmed: boolean) => void;
    title: string;
  }) => void;

  // UI navigation
  screen: AppScreen;
  scrollOffset: number;
  searchActive: boolean;

  searchQuery: string;
  // Session
  session: {
    error: null | string;
    phase: SessionPhase;
    targetPath: string;
  };

  setConfig: (config: ShadowConfig) => void;
  setFocus: (focus: 'input' | 'panel') => void;
  setHelpOpen: (open: boolean) => void;

  setInput: (input: string) => void;
  setLicenseGate: (gate: LicenseGateResult | null) => void;

  setPanelOpen: (open: boolean) => void;
  setScreen: (screen: AppScreen) => void;
  setScrollOffset: (offset: number) => void;
  setSearchActive: (active: boolean) => void;
  setSearchQuery: (query: string) => void;
  setSessionError: (error: null | string) => void;
  setSessionPhase: (phase: SessionPhase) => void;
  setSessionTarget: (targetPath: string) => void;
  setSwarmState: (state: null | SwarmStateSnapshot) => void;
  startStreaming: () => void;
  streaming: boolean;
  streamingText: string;
  // Live swarm snapshot (task stats, agents, claims, consensus) streamed from
  // the supervisor's evaluateConsensus node; rendered by the swarm panel and
  // status bar.
  swarmState: null | SwarmStateSnapshot;
  toggleHelp: () => void;
  togglePanel: () => void;
}

const MAX_MESSAGES = 200;
const MAX_ACTIVITY = 40;

export const useAppStore = create<AppState>((set, get) => ({
  activity: [],
  addActivityEvent: (event) =>
    set((state) => {
      // Structured swarm snapshots are routed to the swarmState slice (rendered
      // by the panel/status bar) instead of cluttering the activity feed.
      if (event.kind === 'swarm_state' && event.swarmState) {
        return { swarmState: event.swarmState };
      }

      const timestamp = new Date(event.timestamp).toLocaleTimeString();
      let text = `${timestamp} • ${event.message}`;
      if (event.toolName) text += ` [${event.toolName}]`;
      const counter = state.activity.length + 1;
      return {
        activity: [...state.activity, { id: `a-${counter}`, kind: event.kind, text }].slice(-MAX_ACTIVITY),
      };
    }),
  addAgentMessage: (text) =>
    set((state) => ({
      messages: [...state.messages, { id: `a-${Date.now()}`, role: 'agent' as const, text }].slice(-MAX_MESSAGES),
    })),
  addErrorMessage: (text) =>
    set((state) => ({
      messages: [...state.messages, { id: `e-${Date.now()}`, role: 'error' as const, text }].slice(-MAX_MESSAGES),
    })),

  addSystemMessage: (text) =>
    set((state) => ({
      messages: [...state.messages, { id: `s-${Date.now()}`, role: 'system' as const, text }].slice(-MAX_MESSAGES),
    })),
  addUserMessage: (text) =>
    set((state) => ({
      messages: [...state.messages, { id: `u-${Date.now()}`, role: 'user' as const, text }].slice(-MAX_MESSAGES),
    })),

  appendStreamChunk: (chunk) =>
    set((state) => ({ streamingText: state.streamingText + chunk })),
  clearActivity: () => set({ activity: [] }),
  clearChat: () => set({ messages: [], streaming: false, streamingText: '' }),
  clearScroll: () => set({ scrollOffset: 0 }),

  closeConfirmation: () =>
    set({
      confirmation: {
        details: undefined,
        message: '',
        onConfirm() {},
        open: false,
        title: '',
      },
    }),
  config: null,
  confirmation: {
    details: undefined,
    message: '',
    onConfirm() {},
    open: false,
    title: '',
  },
  finishStreaming: () =>
    set((state) => {
      if (state.streamingText) {
        return {
          messages: [...state.messages, { id: `a-${Date.now()}`, role: 'agent' as const, text: state.streamingText }].slice(-MAX_MESSAGES),
          streaming: false,
          streamingText: '',
        };
      }

      return { streaming: false, streamingText: '' };
    }),
  focus: 'input',
  helpOpen: false,
  input: '',
  licenseGate: null,
  messages: [],
  panelOpen: false,
  requestConfirmation: ({ details, message, onConfirm, title }) =>
    set({
      confirmation: {
        details,
        message,
        onConfirm,
        open: true,
        title,
      },
    }),

  screen: 'boot',
  scrollOffset: 0,
  searchActive: false,

  searchQuery: '',
  session: {
    error: null,
    phase: 'idle',
    targetPath: '',
  },

  setConfig: (config) => set({ config }),
  setFocus: (focus) => set({ focus }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),

  setInput: (input) => set({ input }),
  setLicenseGate: (gate) => set({ licenseGate: gate }),

  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setScreen: (screen) => set({ screen }),
  setScrollOffset: (scrollOffset) => set({ scrollOffset }),
  setSearchActive: (searchActive) => set({ searchActive }),
  setSearchQuery: (searchQuery) => set({ searchActive: searchQuery.length > 0, searchQuery }),
  setSessionError: (error) =>
    set((state) => ({ session: { ...state.session, error } })),
  setSessionPhase: (phase) =>
    set((state) => ({ session: { ...state.session, phase } })),
  setSessionTarget: (targetPath) =>
    set((state) => ({ session: { ...state.session, targetPath } })),
  setSwarmState: (swarmState) => set({ swarmState }),
  startStreaming: () => set({ streaming: true, streamingText: '' }),
  streaming: false,
  streamingText: '',
  swarmState: null,
  toggleHelp: () => set((state) => ({ helpOpen: !state.helpOpen })),
  togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),
}));
