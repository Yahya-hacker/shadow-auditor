/**
 * Filter Slice — message filter state and toggles.
 */

import type { StateCreator } from 'zustand';

import type { AppState } from './appStore.js';

export interface FilterSlice {
  filters: Record<string, boolean>;
  setFilter: (key: string, value: boolean) => void;
  toggleFilter: (key: string) => void;
}

export const createFilterSlice: StateCreator<AppState, [], [], FilterSlice> = (set) => ({
  filters: {
    'agent': true,
    'all': false,
    'errors': true,
    'findings': true,
    'tool_calls': true,
    'user': true,
  },
  setFilter: (key, value) =>
    set((state) => {
      const newFilters = { ...state.filters, [key]: value };
      // If toggling 'all', set all others to match
      if (key === 'all') {
        for (const k of Object.keys(newFilters)) {
          newFilters[k] = value;
        }
      } else if (!value) {
        newFilters.all = false;
      }

      return { filters: newFilters };
    }),
  toggleFilter: (key) =>
    set((state) => {
      const newFilters = { ...state.filters, [key]: !state.filters[key] };
      // If toggling 'all', set all others to match
      if (key === 'all') {
        const val = !state.filters[key];
        for (const k of Object.keys(newFilters)) {
          newFilters[k] = val;
        }
      } else if (!newFilters[key]) {
        newFilters.all = false;
      }

      return { filters: newFilters };
    }),
});
