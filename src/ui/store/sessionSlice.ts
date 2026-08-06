/**
 * Session Slice — screen navigation, configuration, and session metadata.
 */

import type { StateCreator } from 'zustand';

import type { LicenseGateResult } from '../../core/policy/license-guard.js';
import type { AuditTargetIdentity } from '../../utils/audit-target.js';
import type { ShadowConfig } from '../../utils/config.js';
import type { AppState } from './appStore.js';

export type AppScreen =
  | 'boot'
  | 'history'
  | 'initializing'
  | 'license-blocked'
  | 'setup'
  | 'shell'
  | 'target'
  | 'tools';

export type SessionPhase = 'error' | 'idle' | 'initializing' | 'ready';

export interface SessionSlice {
  config: null | ShadowConfig;
  elapsedTime: number;
  licenseGate: LicenseGateResult | null;
  screen: AppScreen;
  session: {
    error: null | string;
    phase: SessionPhase;
    targetIdentity: AuditTargetIdentity | null;
    targetPath: string;
  };
  setConfig: (config: ShadowConfig) => void;
  setElapsedTime: (seconds: number) => void;
  setLicenseGate: (gate: LicenseGateResult | null) => void;
  setScreen: (screen: AppScreen) => void;
  setSessionError: (error: null | string) => void;
  setSessionPhase: (phase: SessionPhase) => void;
  setSessionTarget: (targetPath: string, targetIdentity?: AuditTargetIdentity | null) => void;
  setUserName: (name: string) => void;
  userName: string;
}

export const createSessionSlice: StateCreator<AppState, [], [], SessionSlice> = (set) => ({
  config: null,
  elapsedTime: 0,
  licenseGate: null,
  screen: 'boot',
  session: {
    error: null,
    phase: 'idle',
    targetIdentity: null,
    targetPath: '',
  },
  setConfig: (config) => set({ config }),
  setElapsedTime: (elapsedTime) => set({ elapsedTime }),
  setLicenseGate: (gate) => set({ licenseGate: gate }),
  setScreen: (screen) => set({ screen }),
  setSessionError: (error) =>
    set((state) => ({ session: { ...state.session, error } })),
  setSessionPhase: (phase) =>
    set((state) => ({ session: { ...state.session, phase } })),
  setSessionTarget: (targetPath, targetIdentity = null) =>
    set((state) => ({ session: { ...state.session, targetIdentity, targetPath } })),
  setUserName: (userName) => set({ userName }),
  userName: '',
});
