import { Box, Text } from 'ink';
import React from 'react';

import { colors, labels, spacing } from '../theme.js';

export interface HeaderProps {
  expertUnsafe?: boolean;
  model: string;
  provider: string;
  targetName: string;
}

export const Header: React.FC<HeaderProps> = ({ expertUnsafe, model, provider, targetName }) => (
  <Box
    borderColor={colors.border}
    borderStyle="round"
    flexDirection="column"
    paddingX={spacing.panelPadX}
    paddingY={spacing.panelPadY}
  >
    <Box>
      <Text bold color={colors.brand}>
        ◈ {labels.appName}
      </Text>
      <Text color={colors.muted}> {labels.version}</Text>
    </Box>
    <Box marginTop={1}>
      <Text color={colors.muted}>{labels.shellTitle}</Text>
    </Box>
    <Box marginTop={1}>
      <Text color={colors.dim}>
        {provider}/{model} → {targetName}
      </Text>
      {expertUnsafe && (
        <Text color={colors.warning}> ⚠ expert-unsafe</Text>
      )}
    </Box>
  </Box>
);
