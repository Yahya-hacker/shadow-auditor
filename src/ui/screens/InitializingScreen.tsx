import React, { memo } from 'react';
/**
 * InitializingScreen — loading state while the security engine spins up.
 *
 * Replaces static pulse dots with IndeterminateStep spinners that show
 * descriptive labels for each initialization phase. When real progress
 * data becomes available (via appStore.initProgress), determinate
 * ProgressBar components are rendered instead.
 */

import { IndeterminateStep, ProgressBar } from '../components/ProgressBar.js';
import { Box, Text } from "../primitives.js";
import { useAppStore } from '../store/appStore.js';
import { colors, spacing } from '../theme/chalkTheme.js';

/**
 * Init step definitions — each maps to a key in InitProgress.
 * Order matches the visual display order.
 */
const INIT_STEPS = [
  { key: 'astParsing', label: 'Parsing AST with tree-sitter' },
  { key: 'semanticIndexing', label: 'Building semantic index & embeddings' },
  { key: 'knowledgeGraph', label: 'Loading knowledge graph' },
  { key: 'fileScanning', label: 'Scanning project files' },
] as const;

export const InitializingScreen: React.FC = memo(() => {
  const targetPath = useAppStore((state) => state.session.targetPath);
  const initProgress = useAppStore((state) => state.initProgress);

  return (
    <Box flexDirection="column" paddingX={spacing.panelPadX}>
      <Box
        borderColor={colors.agent} borderStyle={'rounded'}
        flexDirection="column"
        paddingX={spacing.panelPadX}
        paddingY={spacing.panelPadY}
      >
        <Text bold color={colors.brand}>
          ◈ Initializing Security Engine
        </Text>
        <Box flexDirection="column" gap={1} marginTop={1}>
          {INIT_STEPS.map(({ key, label }) => {
            const value = initProgress?.[key];
            // If a numeric value (0–100) is provided, show determinate bar;
            // otherwise show an indeterminate spinner with descriptive label.
            if (value !== undefined && value >= 0) {
              return (
                <ProgressBar
                  key={key}
                  label={label}
                  value={value}
                  width={20}
                />
              );
            }

            return <IndeterminateStep key={key} label={label} />;
          })}
        </Box>
        <Box marginTop={1}>
          <Text color={colors.dim}>Target: {targetPath}</Text>
        </Box>
      </Box>
    </Box>
  );
});

InitializingScreen.displayName = 'InitializingScreen';
