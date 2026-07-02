import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import React from 'react';

import { colors, rolePrefix, spacing } from '../theme/chalkTheme.js';

export interface StreamingResponseProps {
  text: string;
}

export const StreamingResponse: React.FC<StreamingResponseProps> = ({ text }) => (
  <Box flexDirection="column" marginBottom={1} paddingX={spacing.inputPadX}>
    <Box>
      <Text color={colors.agent}>{rolePrefix.streaming} </Text>
      <Text color={colors.agent}>
        <Spinner type="dots" />
      </Text>
      <Text color={colors.muted}> Streaming response</Text>
    </Box>
    {text && (
      <Box marginTop={1}>
        <Text wrap="wrap">{text}</Text>
      </Box>
    )}
  </Box>
);
