/**
 * UI Slice — focus state, search, help overlay, panel visibility, toasts,
 * compact header, init progress, and token usage.
 */

import type { StateCreator } from 'zustand';

import type { AppState } from './appStore.js';

export type FocusTarget = 'filters' | 'input' | 'output' | 'panel';

/**
 * Per-phase init progress values (0–100). Keys match the init steps shown
 * on the InitializingScreen. Undefined = phase not started / no data.
 */
export interface InitProgress {
  astParsing?: number;
  fileScanning?: number;
  knowledgeGraph?: number;
  semanticIndexing?: number;
}

/**
 * Provider-reported token usage for the current session.
 */
export interface TokenUsage {
  completion: number;
  prompt: number;
  total: number;
}

export interface Toast {
  duration?: number;
  id: string;
  message: string;
  type: 'error' | 'info' | 'success' | 'warning';
}

export interface UiSlice {
  addToast: (toast: Omit<Toast, 'id'> & { id?: string }) => void;
  compactHeader: boolean;
  dismissToast: (id: string) => void;
  focus: FocusTarget;
  focusScope: string;
  helpOpen: boolean;
  initProgress: InitProgress | null;
  isCompact: boolean;
  outputScroll: number;
  panelOpen: boolean;
  scrollOutput: (deltaLines: number) => void;
  searchActive: boolean;
  searchQuery: string;
  setFocus: (focus: FocusTarget) => void;
  setFocusScope: (scope: string) => void;
  setHelpOpen: (open: boolean) => void;
  setInitProgress: (progress: Partial<InitProgress>) => void;
  setIsCompact: (compact: boolean) => void;
  setOutputScroll: (lines: number) => void;
  setPanelOpen: (open: boolean) => void;
  setSearchActive: (active: boolean) => void;
  setSearchQuery: (query: string) => void;
  toasts: Toast[];
  toggleCompactHeader: () => void;
  toggleHelp: () => void;
  togglePanel: () => void;
  tokenUsage: TokenUsage;
  updateTokenUsage: (usage: { completion?: number; prompt?: number }) => void;
}

export const createUiSlice: StateCreator<AppState, [], [], UiSlice> = (set) => ({
  addToast: (toast) =>
    set((state) => {
      const id = toast.id ?? `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const newToast: Toast = { duration: 5000, ...toast, id };
      return { toasts: [...state.toasts, newToast].slice(-5) };
    }),
  compactHeader: false,
  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  focus: 'input',
  focusScope: 'Global',
  helpOpen: false,
  initProgress: null,
  isCompact: false,
  outputScroll: 0,
  panelOpen: false,
  scrollOutput: (deltaLines) => set((state) => ({ outputScroll: Math.max(0, state.outputScroll + deltaLines) })),
  searchActive: false,
  searchQuery: '',
  setFocus: (focus) => set({ focus }),
  setFocusScope: (focusScope) => set({ focusScope }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  setInitProgress: (progress) =>
    set((state) => ({
      initProgress: { ...state.initProgress, ...progress },
    })),
  setIsCompact: (isCompact) => set({ isCompact }),
  setOutputScroll: (lines) => set({ outputScroll: Math.max(0, lines) }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setSearchActive: (searchActive) => set({ searchActive }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  toasts: [],
  toggleCompactHeader: () =>
    set((state) => ({ compactHeader: !state.compactHeader })),
  toggleHelp: () => set((state) => ({ helpOpen: !state.helpOpen })),
  togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),
  tokenUsage: { completion: 0, prompt: 0, total: 0 },
  updateTokenUsage: (usage) =>
    set((state) => {
      const prompt = state.tokenUsage.prompt + (usage.prompt ?? 0);
      const completion = state.tokenUsage.completion + (usage.completion ?? 0);
      const total = prompt + completion;
      return { tokenUsage: { completion, prompt, total } };
    }),
});
