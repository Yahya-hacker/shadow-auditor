/**
 * Confirm Slice — confirmation dialogs and human-in-loop requests.
 */

import type { StateCreator } from 'zustand';

import type { HumanInputRequest } from '../../core/graph/state.js';
import type { AppState } from './appStore.js';

export interface ConfirmationState {
  details?: string;
  kind?: 'confirmation' | 'patch' | 'text';
  message: string;
  onConfirm: (confirmed: boolean) => void;
  onSelect?: (value: string) => void;
  open: boolean;
  options?: Array<{label: string; value: string}>;
  placeholder?: string;
  title: string;
}

export interface ConfirmSlice {
  closeConfirmation: () => void;
  confirmation: ConfirmationState;
  humanInputRequest: HumanInputRequest | null;
  requestChoice: (params: {
    details?: string;
    kind?: 'confirmation' | 'patch';
    message: string;
    onSelect: (value: string) => void;
    options: Array<{label: string; value: string}>;
    title: string;
  }) => void;
  requestConfirmation: (params: {
    details?: string;
    message: string;
    onConfirm: (confirmed: boolean) => void;
    title: string;
  }) => void;
  requestTextInput: (params: {
    message: string;
    onSubmit: (value: string) => void;
    placeholder?: string;
    title: string;
  }) => void;
  setHumanInputRequest: (request: HumanInputRequest | null) => void;
}

export const createConfirmSlice: StateCreator<AppState, [], [], ConfirmSlice> = (set) => ({
  closeConfirmation: () =>
    set({
      confirmation: {
        details: undefined,
        kind: 'confirmation',
        message: '',
        onConfirm() {},
        open: false,
        title: '',
      },
    }),
  confirmation: {
    details: undefined,
    kind: 'confirmation',
    message: '',
    onConfirm() {},
    open: false,
    title: '',
  },
  humanInputRequest: null,
  requestChoice: ({ details, kind = 'confirmation', message, onSelect, options, title }) =>
    set({
      confirmation: {
        details,
        kind,
        message,
        onConfirm() {},
        onSelect,
        open: true,
        options,
        title,
      },
    }),
  requestConfirmation: ({ details, message, onConfirm, title }) =>
    set({
      confirmation: {
        details,
        kind: 'confirmation',
        message,
        onConfirm,
        open: true,
        title,
      },
    }),
  requestTextInput: ({ message, onSubmit, placeholder, title }) =>
    set({
      confirmation: {
        kind: 'text',
        message,
        onConfirm() {},
        onSelect: onSubmit,
        open: true,
        placeholder,
        title,
      },
    }),
  setHumanInputRequest: (humanInputRequest) => set({ humanInputRequest }),
});
