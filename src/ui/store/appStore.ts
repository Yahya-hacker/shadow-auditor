import { create } from 'zustand';

import type { AgentStreamEvent } from '../../core/agent.js';
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
  closeConfirmation: () => void;

  // Configuration
  config: null | ShadowConfig;
  // Confirmation dialog
  confirmation: ConfirmationState;
  finishStreaming: () => void;
  // Input
  input: string;
  licenseGate: LicenseGateResult | null;
  // Chat
  messages: ChatMessageData[];
  requestConfirmation: (params: {
    details?: string;
    message: string;
    onConfirm: (confirmed: boolean) => void;
    title: string;
  }) => void;
  // UI navigation
  screen: AppScreen;
  // Session
  session: {
    error: null | string;
    phase: SessionPhase;
    targetPath: string;
  };
  setConfig: (config: ShadowConfig) => void;
  setInput: (input: string) => void;

  setLicenseGate: (gate: LicenseGateResult | null) => void;
  setScreen: (screen: AppScreen) => void;
  setSessionError: (error: null | string) => void;

  setSessionPhase: (phase: SessionPhase) => void;
  setSessionTarget: (targetPath: string) => void;

  startStreaming: () => void;
  streaming: boolean;
  streamingText: string;
}

const MAX_MESSAGES = 200;
const MAX_ACTIVITY = 40;

export const useAppStore = create<AppState>((set, get) => ({
  activity: [],
  addActivityEvent: (event) =>
    set((state) => {
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
  input: '',
  licenseGate: null,
  messages: [],
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
  session: {
    error: null,
    phase: 'idle',
    targetPath: '',
  },
  setConfig: (config) => set({ config }),
  setInput: (input) => set({ input }),

  setLicenseGate: (gate) => set({ licenseGate: gate }),
  setScreen: (screen) => set({ screen }),
  setSessionError: (error) =>
    set((state) => ({ session: { ...state.session, error } })),

  setSessionPhase: (phase) =>
    set((state) => ({ session: { ...state.session, phase } })),
  setSessionTarget: (targetPath) =>
    set((state) => ({ session: { ...state.session, targetPath } })),

  startStreaming: () => set({ streaming: true, streamingText: '' }),
  streaming: false,
  streamingText: '',
}));
