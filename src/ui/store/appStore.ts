import { create } from 'zustand';

import type { AgentStreamEvent } from '../../core/agent.js';
import type { HumanInputRequest } from '../../core/graph/state.js';
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

export type FocusTarget = 'filters' | 'input' | 'output' | 'panel';

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
  // Elapsed time (seconds) since the last query was submitted
  elapsedTime: number;
  // Filter state: key = filter label, value = enabled
  filters: Record<string, boolean>;
  finishStreaming: () => void;
  focus: FocusTarget;
  // Scope label for the metadata panel (e.g. 'Global', 'src/config.ts')
  focusScope: string;
  helpOpen: boolean;
  // Hit count (number of findings/vulnerabilities surfaced)
  hitCount: number;
  // Human input request from the agent (when the LangGraph graph interrupts
  // at HumanIntervention). Set when the TUI receives a human_input_required
  // event; cleared when the user responds and the graph is resumed.
  humanInputRequest: HumanInputRequest | null;
  // Input
  input: string;
  // Compact mode (derived from terminal width < COMPACT_THRESHOLD)
  isCompact: boolean;
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
  setElapsedTime: (seconds: number) => void;
  setFilter: (key: string, value: boolean) => void;
  setFocus: (focus: FocusTarget) => void;
  setFocusScope: (scope: string) => void;
  setHelpOpen: (open: boolean) => void;
  setHitCount: (count: number) => void;
  setHumanInputRequest: (request: HumanInputRequest | null) => void;

  setInput: (input: string) => void;
  setIsCompact: (compact: boolean) => void;
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
  setUserName: (name: string) => void;
  startStreaming: () => void;
  streaming: boolean;
  streamingText: string;
  // Monotonically increasing generation counter. Incremented each time
  // startStreaming() is called so appendStreamChunk can discard chunks
  // from a previous (aborted) stream.
  streamGeneration: number;
  // Live swarm snapshot (task stats, agents, claims, consensus) streamed from
  // the supervisor's evaluateConsensus node; rendered by the swarm panel and
  // status bar.
  swarmState: null | SwarmStateSnapshot;
  toggleFilter: (key: string) => void;
  toggleHelp: () => void;
  togglePanel: () => void;
  userName: string;
}

const MAX_MESSAGES = 200;
const MAX_ACTIVITY = 40;

export const useAppStore = create<AppState>((set, get) => ({
  activity: [],
  addActivityEvent: (event) =>
    set((state) => {
      // Human-input requests from LangGraph interrupts are routed to the
      // humanInputRequest slice (rendered by ConfirmDialog/InputArea) instead
      // of cluttering the activity feed.
      if (event.kind === 'human_input_required' && event.humanInputRequest) {
        return { humanInputRequest: event.humanInputRequest };
      }

      // Structured swarm snapshots are routed to the swarmState slice (rendered
      // by the panel/status bar) instead of cluttering the activity feed.
      if (event.kind === 'swarm_state' && event.swarmState) {
        return { swarmState: event.swarmState };
      }

      const timestamp = new Date(event.timestamp).toLocaleTimeString();
      let text = `${timestamp} • ${event.message}`;
      if (event.toolName) text += ` [${event.toolName}]`;
      // Use timestamp + random suffix for unique IDs, avoiding collisions
      // when multiple events are flushed in the same tick (throttled batch).
      const uniqueId = `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      return {
        activity: [...state.activity, { id: uniqueId, kind: event.kind, text }].slice(-MAX_ACTIVITY),
      };
    }),
  addAgentMessage: (text) =>
    set((state) => {
      const isHit = text.includes('[Hit]') || text.includes('[Alert]');
      return {
        hitCount: isHit ? state.hitCount + 1 : state.hitCount,
        messages: [...state.messages, { id: `a-${Date.now()}`, role: 'agent' as const, text }].slice(-MAX_MESSAGES),
      };
    }),
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
  elapsedTime: 0,
  filters: { 'auto_agent': false, 'crit:high': false, 'doc_type:pdf': false },
  finishStreaming: () =>
    set((state) => {
      if (state.streamingText) {
        const isHit = state.streamingText.includes('[Hit]') || state.streamingText.includes('[Alert]');
        return {
          hitCount: isHit ? state.hitCount + 1 : state.hitCount,
          messages: [...state.messages, { id: `a-${Date.now()}`, role: 'agent' as const, text: state.streamingText }].slice(-MAX_MESSAGES),
          streaming: false,
          streamingText: '',
        };
      }

      return { streaming: false, streamingText: '' };
    }),
  focus: 'input',
  focusScope: 'Global',
  helpOpen: false,
  hitCount: 0,
  humanInputRequest: null,
  input: '',
  isCompact: false,
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
  setElapsedTime: (elapsedTime) => set({ elapsedTime }),
  setFilter: (key, value) =>
    set((state) => ({ filters: { ...state.filters, [key]: value } })),
  setFocus: (focus) => set({ focus, scrollOffset: 0 }),
  setFocusScope: (focusScope) => set({ focusScope }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  setHitCount: (hitCount) => set({ hitCount }),
  setHumanInputRequest: (humanInputRequest) => set({ humanInputRequest }),

  setInput: (input) => set({ input }),
  setIsCompact: (isCompact) => set({ isCompact }),
  setLicenseGate: (gate) => set({ licenseGate: gate }),

  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setScreen: (screen) => set({ screen }),
  setScrollOffset: (scrollOffset) => set({ scrollOffset }),
  setSearchActive: (searchActive) => set({ searchActive }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSessionError: (error) =>
    set((state) => ({ session: { ...state.session, error } })),
  setSessionPhase: (phase) =>
    set((state) => ({ session: { ...state.session, phase } })),
  setSessionTarget: (targetPath) =>
    set((state) => ({ session: { ...state.session, targetPath } })),
  setSwarmState: (swarmState) => set({ swarmState }),
  setUserName: (userName) => set({ userName }),
  startStreaming: () => set((s) => ({ streaming: true, streamingText: '', streamGeneration: s.streamGeneration + 1 })),
  streaming: false,
  streamingText: '',
  streamGeneration: 0,
  swarmState: null,
  toggleFilter: (key) =>
    set((state) => ({ filters: { ...state.filters, [key]: !state.filters[key] } })),
  toggleHelp: () => set((state) => ({ helpOpen: !state.helpOpen })),
  togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),
  userName: '',
}));
