/**
 * App Store — Zustand store assembled from focused slices.
 *
 * Each slice manages a cohesive set of state fields. The combined store
 * preserves the original public API (field names, action names, exported
 * types) so that all existing components continue to work unchanged.
 */

import { create } from 'zustand';

import { type AuditTelemetrySlice, createAuditTelemetrySlice } from './auditTelemetrySlice.js';
import { type ChatSlice, createChatSlice } from './chatSlice.js';
import { type ConfirmSlice, createConfirmSlice } from './confirmSlice.js';
import { createFilterSlice, type FilterSlice } from './filterSlice.js';
import { createSessionSlice, type SessionSlice } from './sessionSlice.js';
import { createSwarmSlice, type SwarmSlice } from './swarmSlice.js';
import { createUiSlice, type UiSlice } from './uiSlice.js';

// ============================================================================
// Combined store type
// ============================================================================

export type AppState = AuditTelemetrySlice & ChatSlice & ConfirmSlice & FilterSlice & SessionSlice & SwarmSlice & UiSlice;

export const useAppStore = create<AppState>()((...a) => ({
  ...createAuditTelemetrySlice(...a),
  ...createChatSlice(...a),
  ...createConfirmSlice(...a),
  ...createFilterSlice(...a),
  ...createSessionSlice(...a),
  ...createSwarmSlice(...a),
  ...createUiSlice(...a),
}));

// ============================================================================
// Re-exports — types that consumers previously imported from appStore.ts
// ============================================================================

export type { ActivityEvent, ChatMessageData, MessageRole } from './chatSlice.js';
export type { ConfirmationState } from './confirmSlice.js';
export type { AppScreen, SessionPhase } from './sessionSlice.js';
export type { FocusTarget, InitProgress, Toast, TokenUsage } from './uiSlice.js';
