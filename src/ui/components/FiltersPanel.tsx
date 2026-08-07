import React, { useCallback, useMemo, useState } from 'react';
/**
 * FiltersPanel — checkbox-style filter sidebar with real message categories.
 *
 * Categories: all, findings, tool_calls, errors, agent, user.
 * Handles its own keyboard navigation when focused (j/k to navigate,
 * Space to toggle, Tab/Esc/i to return focus to input).
 */

import { Box, type KeyEvent, Text, useKeyHandler } from "../primitives.js";
import { useAppStore } from '../store/appStore.js';
import { colors, getPanelStyle, layout } from '../theme/chalkTheme.js';

const filterLabels: Record<string, string> = {
  'agent': 'Agent Messages',
  'all': 'Show All',
  'errors': 'Errors',
  'findings': 'Findings',
  'tool_calls': 'Tool Calls',
  'user': 'User Messages',
};

export const FiltersPanel: React.FC = () => {
  const filters = useAppStore((state) => state.filters);
  const focus = useAppStore((state) => state.focus);
  const [highlightIdx, setHighlightIdx] = useState(0);

  const isFocused = focus === 'filters';
  const panelStyle = getPanelStyle(isFocused, true);
  const entries = useMemo(() => Object.entries(filters), [filters]);
  const panelInnerWidth = layout.MIN_SIDEBAR_WIDTH - 2;

  const lightFg = colors.panelLightFg;
  const lightBg = colors.panelLightBg;

  // Clamp highlight to valid range
  const safeHighlight = Math.min(highlightIdx, entries.length - 1);

  // Handle keyboard navigation locally when focused
  const handleKeyDown = useCallback(
    (evt: KeyEvent) => {
      if (!isFocused) return;
      switch (evt.key) {
        case ' ': {
          const key = entries[safeHighlight]?.[0];
          if (key) useAppStore.getState().toggleFilter(key);
          break;
        }

        case 'ArrowDown':
        case 'j': {
          setHighlightIdx((p) => Math.min(p + 1, entries.length - 1));
          break;
        }

        case 'ArrowUp':
        case 'k': {
          setHighlightIdx((p) => Math.max(p - 1, 0));
          break;
        }

        case 'Escape':
        case 'i':
        case 'Tab': {
          useAppStore.getState().setFocus('input');
          break;
        }
      }
    },
    [isFocused, entries, safeHighlight],
  );

  useKeyHandler(handleKeyDown, isFocused);

  return (
    <Box
      borderColor={panelStyle.borderColor} borderStyle={panelStyle.borderStyle}
      flexDirection="column"
      paddingX={1}
    >
      <Text
        backgroundColor={lightBg}
        bold
        color={lightFg}
      >
        {'Filters'.padEnd(panelInnerWidth)}
      </Text>
      {entries.map(([key, value], index) => {
        const isSelected = isFocused && index === safeHighlight;
        const check = value ? 'x' : ' ';
        const displayName = filterLabels[key] ?? key;
        const label = `[${check}] ${displayName}`;
        const paddedLabel = label.padEnd(panelInnerWidth);

        return (
          <Text
            backgroundColor={lightBg}
            bold={isSelected}
            color={isSelected ? colors.focusBorder : lightFg}
            key={key}
          >
            {paddedLabel}
          </Text>
        );
      })}
      <Text backgroundColor={lightBg}>
        {' '.repeat(panelInnerWidth)}
      </Text>
    </Box>
  );
};
