import { Box, Text, Input } from "../../opentui/components.js";
/**
 * TargetSelectionScreen — choose audit target directory.
 *
 * `<Input>` replaces ink-text-input for path entry.
 */

import React, { useCallback, useState } from 'react';

import { startRepoMapGeneration } from '../hooks/useAgentSession.js';
import { useAppStore } from '../store/appStore.js';
import { colors, labels, spacing } from '../theme/chalkTheme.js';

export const TargetSelectionScreen: React.FC = () => {
  const [showCustom, setShowCustom] = useState(false);
  const [customPath, setCustomPath] = useState('');
  const [error, setError] = useState('');
  const setScreen = useAppStore((state) => state.setScreen);
  const setSessionTarget = useAppStore((state) => state.setSessionTarget);

  const proceed = (target: string) => {
    startRepoMapGeneration(target);
    setSessionTarget(target);
    setScreen('initializing');
  };

  const handleDefaultSubmit = (value: string) => {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'n' || normalized === 'no') {
      setShowCustom(true);
      setCustomPath('');
      setError('');
      return;
    }
    proceed(process.cwd());
  };

  const handleCustomSubmit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError('Please enter a path.');
      return;
    }
    proceed(trimmed);
  };

  return (
    <Box flexDirection="column" paddingX={spacing.panelPadX}>
      <Box
        borderColor={colors.brand} borderStyle={'rounded'}
        paddingX={spacing.panelPadX}
        paddingY={spacing.panelPadY}
      >
        <Text color={colors.brand} bold>
          ◈ {labels.appName} — Target Selection
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {showCustom ? (
          <Box flexDirection="column">
            <Box>
              <Text color={colors.pending}>Enter target directory: </Text>
              <Input
                value={customPath}
                onChange={(v: string) => setCustomPath(v)}
                onSubmit={handleCustomSubmit}
                placeholder="/path/to/project"
              />
            </Box>
            {error && (
              <Box marginTop={1}>
                <Text color={colors.error}>✖ {error}</Text>
              </Box>
            )}
          </Box>
        ) : (
          <Box>
            <Text color={colors.pending}>
              Use current directory (
            </Text>
            <Text color={colors.bright} bold>
              {process.cwd()}
            </Text>
            <Text color={colors.pending}>
              ) for the audit? [Y/n]{' '}
            </Text>
            <Input
              value={customPath}
              onChange={(v: string) => setCustomPath(v)}
              onSubmit={handleDefaultSubmit}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
};
