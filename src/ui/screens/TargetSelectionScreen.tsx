import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
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

  const proceed = (target: string) => {
    // Start repo map generation in the background before transitioning
    startRepoMapGeneration(target);
    setSessionTarget(target);
    setScreen('initializing');
  };

  useInput(useCallback((_, key) => {
    if (key.escape && showCustom) {
      setShowCustom(false);
      setError('');
    }
  }, [showCustom]));

  return (
    <Box flexDirection="column" paddingX={spacing.panelPadX}>
      <Box
        borderColor={colors.brand}
        borderStyle="round"
        paddingX={spacing.panelPadX}
        paddingY={spacing.panelPadY}
      >
        <Text bold color={colors.brand}>
          ◈ {labels.appName} — Target Selection
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {showCustom ? (
          <Box flexDirection="column">
            <Box>
              <Text color={colors.pending}>Enter target directory: </Text>
              <TextInput
                onChange={setCustomPath}
                onSubmit={handleCustomSubmit}
                placeholder="/path/to/project"
                value={customPath}
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
            <Text bold color={colors.bright}>
              {process.cwd()}
            </Text>
            <Text color={colors.pending}>
              ) for the audit? [Y/n]{' '}
            </Text>
            <TextInput
              onChange={setCustomPath}
              onSubmit={handleDefaultSubmit}
              value={customPath}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
};
