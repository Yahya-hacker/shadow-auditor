import { Box, Text } from 'ink';
import React, { useState } from 'react';

import { useAppStore } from '../store/appStore.js';
import { colors, getPanelStyle, layout } from '../theme.js';

/**
 * Checkbox-style filter panel in the sidebar.
 *
 * ┌─ Filters ────────┐
 * │ [ ] doc_type:pdf │
 * │ [ ] crit:high    │
 * │ [x] auto_agent   │
 * └──────────────────┘
 *
 * Light panel styling: dark foreground on light background for visual contrast
 * against the dark output area. Focus-driven border: single (idle) → double
 * (focused). Keyboard navigation: j/k select, Space toggles, Tab/Esc returns
 * to input.
 */
export const FiltersPanel: React.FC = () => {
  const filters = useAppStore((state) => state.filters);
  const focus = useAppStore((state) => state.focus);
  const toggleFilter = useAppStore((state) => state.toggleFilter);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const isFocused = focus === 'filters';
  const panelStyle = getPanelStyle(isFocused, true);
  const entries = Object.entries(filters);
  const panelInnerWidth = layout.MIN_SIDEBAR_WIDTH - 2;

  // Clamp selection index to valid range
  const clampedIndex = Math.min(selectedIndex, entries.length - 1);

  const lightFg = colors.panelLightFg;
  const lightBg = colors.panelLightBg;

  return (
    <Box
      borderColor={panelStyle.borderColor}
      borderStyle={panelStyle.borderStyle}
      flexDirection="column"
      paddingX={1}
    >
      <Text backgroundColor={lightBg} bold color={lightFg}>
        {'Filters'.padEnd(panelInnerWidth)}
      </Text>
      {entries.map(([key, value], index) => {
        const isSelected = isFocused && index === clampedIndex;
        const check = value ? 'x' : ' ';
        const label = `[${check}] ${key}`;
        const paddedLabel = label.padEnd(panelInnerWidth);

        return (
          <Text
            backgroundColor={isSelected ? lightBg : lightBg}
            bold={isSelected}
            color={isSelected ? colors.focusBorder : lightFg}
            inverse={isSelected}
            key={key}
          >
            {paddedLabel}
          </Text>
        );
      })}
      {/* Fill remaining space with light background */}
      <Text backgroundColor={lightBg}>
        {' '.repeat(panelInnerWidth)}
      </Text>
    </Box>
  );
};

/**
 * Get the currently selected filter key for external key handlers.
 * Exported for use in ShellScreen's handleFiltersFocusKey.
 */
export function useSelectedFilterIndex(): [number, (index: number) => void] {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const filters = useAppStore((state) => state.filters);
  const entries = Object.keys(filters);
  const clamped = Math.min(selectedIndex, entries.length - 1);
  return [clamped, setSelectedIndex];
}

export function getFilterKeys(): string[] {
  return Object.keys(useAppStore.getState().filters);
}
