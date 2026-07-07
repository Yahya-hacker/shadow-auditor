/**
 * FiltersPanel — checkbox-style filter sidebar.
 *
 * Uses `scrollOffset` from the store as the highlighted index (driven by
 * ShellScreen's global keyboard handler: j/k to navigate, Space to toggle).
 * Tab/Esc/i return focus to input.
 */

import React from 'react';

import { useAppStore } from '../store/appStore.js';
import { colors, getPanelStyle, layout } from '../theme/chalkTheme.js';

export const FiltersPanel: React.FC = () => {
  const filters = useAppStore((state) => state.filters);
  const focus = useAppStore((state) => state.focus);
  const scrollOffset = useAppStore((state) => state.scrollOffset);

  const isFocused = focus === 'filters';
  const panelStyle = getPanelStyle(isFocused, true);
  const entries = Object.entries(filters);
  const panelInnerWidth = layout.MIN_SIDEBAR_WIDTH - 2;

  // Use scrollOffset as the selected index when focused
  const selectedIndex = Math.min(scrollOffset, entries.length - 1);

  const lightFg = colors.panelLightFg;
  const lightBg = colors.panelLightBg;

  return (
    <box
      border={{ color: panelStyle.borderColor, style: panelStyle.borderStyle }}
      flexDirection="column"
      paddingX={1}
    >
      <text
        style={{
          color: lightFg,
          fontWeight: 'bold',
          backgroundColor: lightBg,
        }}
      >
        {'Filters'.padEnd(panelInnerWidth)}
      </text>
      {entries.map(([key, value], index) => {
        const isSelected = isFocused && index === selectedIndex;
        const check = value ? 'x' : ' ';
        const label = `[${check}] ${key}`;
        const paddedLabel = label.padEnd(panelInnerWidth);

        return (
          <text
            key={key}
            style={{
              backgroundColor: lightBg,
              color: isSelected ? colors.focusBorder : lightFg,
              fontWeight: isSelected ? 'bold' : 'normal',
            }}
          >
            {paddedLabel}
          </text>
        );
      })}
      <text style={{ backgroundColor: lightBg }}>
        {' '.repeat(panelInnerWidth)}
      </text>
    </box>
  );
};
