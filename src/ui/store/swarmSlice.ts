/**
 * Swarm Slice — swarm coordinator state snapshot.
 */

import type { StateCreator } from 'zustand';

import type { SwarmStateSnapshot } from '../../core/hivemind/swarm-supervisor.js';
import type { AppState } from './appStore.js';

export interface SwarmSlice {
  setSwarmState: (state: null | SwarmStateSnapshot) => void;
  swarmState: null | SwarmStateSnapshot;
}

export const createSwarmSlice: StateCreator<AppState, [], [], SwarmSlice> = (set) => ({
  setSwarmState: (swarmState) => set({ swarmState }),
  swarmState: null,
});
