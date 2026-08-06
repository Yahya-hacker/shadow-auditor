/**
 * ProgressBar — reusable progress indicator for OpenTUI.
 *
 * Supports determinate mode (0-100 value) and indeterminate mode
 * (animated spinner when value is undefined/negative).
 *
 * Renders:  [████████░░░░░░░░░░░░] 42% Indexing files...
 */

import React, { memo } from 'react';

import { Box, Text } from '../primitives.js';
import { colors } from '../theme/chalkTheme.js';

export interface ProgressBarProps {
  /** Whether the bar is in indeterminate mode (value unknown). */
  indeterminate?: boolean;
  /** Label text shown after the bar/percentage. */
  label: string;
  /** Whether to show the percentage number (determinate mode only). */
  showPercent?: boolean;
  /** Current progress value 0–100. Values < 0 or undefined trigger indeterminate mode. */
  value?: number;
  /** Character width of the bar (excluding brackets). */
  width?: number;
}

const FILLED_CHAR = '█';
const EMPTY_CHAR = '░';
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const ProgressBar: React.FC<ProgressBarProps> = memo(
  ({ indeterminate = false, label, showPercent = true, value, width = 30 }) => {
    const isIndeterminate = indeterminate || value === undefined || value < 0;

    if (isIndeterminate) {
      const dashLine = '─'.repeat(width);
      return (
        <Box>
          <Text animate="pulse" color={colors.agent}>●</Text>
          <Text color={colors.muted}>{` [${dashLine}] `}</Text>
          <Text color={colors.muted}>{label}</Text>
        </Box>
      );
    }

    const clamped = Math.min(100, Math.max(0, value));
    const filledCount = Math.round((clamped / 100) * width);
    const emptyCount = width - filledCount;
    const filled = FILLED_CHAR.repeat(filledCount);
    const empty = EMPTY_CHAR.repeat(emptyCount);
    const pctStr = `${clamped.toFixed(0).padStart(3)}%`;

    return (
      <Box>
        <Text color={colors.dim}>[</Text>
        <Text color={colors.success}>{filled}</Text>
        <Text color={colors.dim}>{empty}</Text>
        <Text color={colors.dim}>]</Text>
        {showPercent && (
          <Text color={clamped >= 100 ? colors.success : colors.bright}>{` ${pctStr}`}</Text>
        )}
        <Text color={colors.muted}>{` ${label}`}</Text>
      </Box>
    );
  },
);
ProgressBar.displayName = 'ProgressBar';

/**
 * Indeterminate spinner with a descriptive label.
 * Used for initialization phases where actual progress % is unknown.
 */
export interface IndeterminateStepProps {
  /** Optional detail text (e.g. file count, current file). */
  detail?: string;
  label: string;
}

export const IndeterminateStep: React.FC<IndeterminateStepProps> = memo(({ detail, label }) => (
  <Box>
    <Text animate="pulse" color={colors.agent}>●</Text>
    <Text color={colors.muted}>{` ${label}`}</Text>
    {detail !== undefined && detail !== '' && (
      <Text color={colors.dim}>{` — ${detail}`}</Text>
    )}
  </Box>
));
IndeterminateStep.displayName = 'IndeterminateStep';

export { SPINNER_FRAMES };
