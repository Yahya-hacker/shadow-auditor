import { Box, Text } from 'ink';
import React from 'react';

import { useAppStore } from '../store/appStore.js';
import { colors } from '../theme/chalkTheme.js';

export const StatusLine: React.FC = () => {
  const config = useAppStore((state) => state.config);
  const targetPath = useAppStore((state) => state.session.targetPath);

  const provider = config?.provider ?? 'unknown';
  const model = config?.model ?? 'unknown';
  const auditMode = config?.auditMode;

  return (
    <Box borderColor={colors.border} borderStyle="single" paddingX={1}>
      <Box flexGrow={1}>
        <Text bold color={colors.brand}>
          Shadow
        </Text>
        <Text color={colors.muted}> │ </Text>
        <Text color={colors.info}>{provider}</Text>
        <Text color={colors.muted}> │ </Text>
        <Text color={colors.bright}>{model}</Text>
        <Text color={colors.muted}> │ </Text>
        <Text color={colors.muted}>{targetPath}</Text>
        {auditMode && (
          <>
            <Text color={colors.muted}> │ </Text>
            <Text color={colors.pending}>{auditMode}</Text>
          </>
        )}
        {config?.expertUnsafe && (
          <>
            <Text color={colors.muted}> │ </Text>
            <Text bold color={colors.error}>
              EXPERT-UNSAFE
            </Text>
          </>
        )}
      </Box>
    </Box>
  );
};
