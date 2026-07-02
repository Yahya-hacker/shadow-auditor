import { Box, Text } from 'ink';
import React from 'react';

import type { ChatMessageData } from '../store/appStore.js';

import { colors, rolePrefix, spacing } from '../theme/chalkTheme.js';

const roleConfig: Record<ChatMessageData['role'], { color: string; prefix: string }> = {
  agent: { color: colors.agent, prefix: rolePrefix.agent },
  error: { color: colors.error, prefix: rolePrefix.error },
  system: { color: colors.system, prefix: rolePrefix.system },
  user: { color: colors.user, prefix: rolePrefix.user },
};

export const ChatMessage: React.FC<{ message: ChatMessageData }> = ({ message }) => {
  const config = roleConfig[message.role];

  return (
    <Box flexDirection="column" marginBottom={1} paddingX={spacing.inputPadX}>
      <Box>
        <Text bold color={config.color}>
          {config.prefix}{' '}
        </Text>
        {message.role === 'user' ? (
          <Text color={config.color}>{message.text}</Text>
        ) : (
          <Text wrap="wrap">{message.text}</Text>
        )}
      </Box>
    </Box>
  );
};
