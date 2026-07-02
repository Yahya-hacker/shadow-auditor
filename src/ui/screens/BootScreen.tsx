import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import React, { useEffect } from 'react';

import { useAppStore } from '../store/appStore.js';
import { colors, labels } from '../theme/chalkTheme.js';

export const BootScreen: React.FC = () => {
  const setScreen = useAppStore((state) => state.setScreen);

  useEffect(() => {
    const timer = setTimeout(() => {
      setScreen('target');
    }, 1500);
    return () => clearTimeout(timer);
  }, [setScreen]);

  return (
    <Box alignItems="center" flexDirection="column" justifyContent="center" paddingY={2}>
      <Box flexDirection="column">
        <Text bold color={colors.brand}>
          {'  ███████╗██╗  ██╗ █████╗ ██████╗  ██████╗ ██╗    ██╗'}
        </Text>
        <Text bold color={colors.brand}>
          {'  ██╔════╝██║  ██║██╔══██╗██╔══██╗██╔═══██╗██║    ██║'}
        </Text>
        <Text bold color={colors.brand}>
          {'  ███████╗███████║███████║██║  ██║██║   ██║██║ █╗ ██║'}
        </Text>
        <Text color={colors.brand}>
          {'  ╚════██║██╔══██║██╔══██║██║  ██║██║   ██║██║███╗██║'}
        </Text>
        <Text color={colors.brand}>
          {'  ███████║██║  ██║██║  ██║██████╔╝╚██████╔╝╚███╔███╔╝'}
        </Text>
        <Text color={colors.brand}>
          {'  ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝  ╚═════╝  ╚══╝╚══╝'}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text bold color={colors.bright}>
          {labels.appName}
        </Text>
        <Text color={colors.dim}> {labels.version}</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={colors.muted}>{labels.appTagline}</Text>
      </Box>

      <Box marginTop={2}>
        <Text color={colors.agent}>
          <Spinner type="dots" />{' '}
        </Text>
        <Text color={colors.muted}>Booting security engine</Text>
        <Text color={colors.dim}>...</Text>
      </Box>
    </Box>
  );
};
