/**
 * Chat Slice — messages, activity stream, and streaming state.
 *
 * Extracted from the monolithic appStore to isolate the chat-related
 * state and actions for better testability and maintainability.
 */

import type { StateCreator } from 'zustand';

import type { AgentStreamEvent } from '../../core/agent.js';
import type { AppState } from './appStore.js';

export type MessageRole = 'agent' | 'error' | 'system' | 'user';

export interface ChatMessageData {
  id: string;
  role: MessageRole;
  sequence?: number;
  text: string;
}

export interface ActivityEvent {
  agent?: string;
  detail?: string;
  id: string;
  kind: string;
  resultPreview?: string;
  sequence?: number;
  stage?: AgentStreamEvent['stage'];
  succeeded?: boolean;
  text: string;
  timestamp: string;
  toolCallId?: string;
}

const MAX_MESSAGES = 200;
const MAX_ACTIVITY = 2000;

export interface ChatSlice {
  activity: ActivityEvent[];
  addActivityEvent: (event: AgentStreamEvent) => void;
  addAgentMessage: (text: string) => void;
  addErrorMessage: (text: string) => void;
  addSystemMessage: (text: string) => void;
  addUserMessage: (text: string) => void;
  appendStreamChunk: (chunk: string) => void;
  clearActivity: () => void;
  clearChat: () => void;
  finishStreaming: (fallbackText?: string) => void;
  hitCount: number;
  input: string;
  messages: ChatMessageData[];
  setHitCount: (count: number) => void;
  setInput: (input: string) => void;
  startStreaming: () => void;
  streamGeneration: number;
  streaming: boolean;
  streamingText: string;
  timelineSequence: number;
}

export const createChatSlice: StateCreator<AppState, [], [], ChatSlice> = (set, _get) => ({
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

      if (event.kind === 'audit_telemetry' && event.auditTelemetry) {
        const verified = new Set(event.auditTelemetry.verifiedFindingIds);
        return {
          activeAuditStage: event.auditTelemetry.activeStage,
          currentVulnerabilityIds: [...new Set(event.auditTelemetry.candidateIds)]
            .filter((id) => !verified.has(id)),
          verifiedFindingIds: [...verified],
        };
      }

      if (event.kind === 'token_usage' && event.usage) {
        const prompt = state.tokenUsage.prompt + event.usage.prompt;
        const completion = state.tokenUsage.completion + event.usage.completion;
        const total = prompt + completion;
        return {tokenUsage: {completion, prompt, total}};
      }

      const uniqueId = event.toolCallId
        ? `tool-${event.stage ?? 'unscoped'}-${event.toolCallId}`
        : `${event.kind}-${event.timestamp}-${event.stage ?? ''}-${event.toolName ?? ''}-${event.message}`;
      const existingIndex = state.activity.findIndex((item) => item.id === uniqueId);
      if (existingIndex !== -1) {
        const existing = state.activity[existingIndex]!;
        if (event.kind !== 'tool_result' || existing.kind === 'tool_result') {
          return state;
        }

        const activity = [...state.activity];
        activity[existingIndex] = {
          ...existing,
          ...(event.agent ? {agent: event.agent} : {}),
          ...(event.detail ? {detail: event.detail} : {}),
          kind: event.kind,
          ...(event.resultPreview ? {resultPreview: event.resultPreview} : {}),
          ...(event.succeeded === undefined ? {} : {succeeded: event.succeeded}),
          text: event.message,
        };
        return {activity};
      }

      const sequence = state.timelineSequence + 1;
      return {
        activity: [...state.activity, {
          ...(event.agent ? { agent: event.agent } : {}),
          ...(event.detail ? { detail: event.detail } : {}),
          id: uniqueId,
          kind: event.kind,
          ...(event.resultPreview ? { resultPreview: event.resultPreview } : {}),
          sequence,
          ...(event.stage ? { stage: event.stage } : {}),
          ...(event.succeeded === undefined ? {} : {succeeded: event.succeeded}),
          text: event.message,
          timestamp: event.timestamp,
          ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        }].slice(-MAX_ACTIVITY),
        timelineSequence: sequence,
      };
    }),
  addAgentMessage: (text) =>
    set((state) => {
      const previous = state.messages.at(-1);
      if (previous?.role === 'agent' && previous.text === text) {
        return state;
      }

      const sequence = state.timelineSequence + 1;
      return {
        messages: [...state.messages, { id: `a-${Date.now()}`, role: 'agent' as const, sequence, text }].slice(-MAX_MESSAGES),
        timelineSequence: sequence,
      };
    }),
  addErrorMessage: (text) =>
    set((state) => {
      const sequence = state.timelineSequence + 1;
      return {
        messages: [...state.messages, { id: `e-${Date.now()}`, role: 'error' as const, sequence, text }].slice(-MAX_MESSAGES),
        timelineSequence: sequence,
      };
    }),
  addSystemMessage: (text) =>
    set((state) => {
      const sequence = state.timelineSequence + 1;
      return {
        messages: [...state.messages, { id: `s-${Date.now()}`, role: 'system' as const, sequence, text }].slice(-MAX_MESSAGES),
        timelineSequence: sequence,
      };
    }),
  addUserMessage: (text) =>
    set((state) => {
      const sequence = state.timelineSequence + 1;
      return {
        messages: [...state.messages, { id: `u-${Date.now()}`, role: 'user' as const, sequence, text }].slice(-MAX_MESSAGES),
        timelineSequence: sequence,
      };
    }),
  appendStreamChunk: (chunk) =>
    set((state) => ({ streamingText: state.streamingText + chunk })),
  clearActivity: () => set({ activity: [] }),
  clearChat: () => set({ messages: [], streaming: false, streamingText: '' }),
  finishStreaming: (fallbackText) =>
    set((state) => {
      const finalText = state.streamingText || fallbackText?.trim() || '';
      if (finalText) {
        const previous = state.messages.at(-1);
        if (previous?.role === 'agent' && previous.text === finalText) {
          return { streaming: false, streamingText: '' };
        }

        const sequence = state.timelineSequence + 1;
        return {
          messages: [...state.messages, { id: `a-${Date.now()}`, role: 'agent' as const, sequence, text: finalText }].slice(-MAX_MESSAGES),
          streaming: false,
          streamingText: '',
          timelineSequence: sequence,
        };
      }

      return { streaming: false, streamingText: '' };
    }),
  hitCount: 0,
  input: '',
  messages: [],
  setHitCount: (hitCount) => set({ hitCount }),
  setInput: (input) => set({ input }),
  startStreaming: () => set((s) => ({ outputScroll: 0, streamGeneration: s.streamGeneration + 1, streaming: true, streamingText: '' })),
  streamGeneration: 0,
  streaming: false,
  streamingText: '',
  timelineSequence: 0,
});
