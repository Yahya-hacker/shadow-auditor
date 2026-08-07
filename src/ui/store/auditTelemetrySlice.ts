import type { StateCreator } from 'zustand';

import type { AuditStage } from '../../core/graph/pipeline-artifacts.js';
import type { AppState } from './appStore.js';

export interface AuditTelemetrySlice {
  activeAuditStage: AuditStage | null;
  currentVulnerabilityIds: string[];
  resetAuditTelemetry: () => void;
  setAuditTelemetry: (telemetry: {
    activeStage: AuditStage;
    candidateIds: string[];
    verifiedFindingIds: string[];
  }) => void;
  verifiedFindingIds: string[];
}

export const createAuditTelemetrySlice: StateCreator<AppState, [], [], AuditTelemetrySlice> = (set) => ({
  activeAuditStage: null,
  currentVulnerabilityIds: [],
  resetAuditTelemetry: () => set({
    activeAuditStage: null,
    currentVulnerabilityIds: [],
    verifiedFindingIds: [],
  }),
  setAuditTelemetry(telemetry) {
    const verified = new Set(telemetry.verifiedFindingIds);
    set({
      activeAuditStage: telemetry.activeStage,
      currentVulnerabilityIds: [...new Set(telemetry.candidateIds)].filter((id) => !verified.has(id)),
      verifiedFindingIds: [...verified],
    });
  },
  verifiedFindingIds: [],
});
