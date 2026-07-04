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

interface ChatMessageProps {
  /** Compact mode: reduced padding, no margin between messages. */
  compact?: boolean;
  message: ChatMessageData;
}

/**
 * Single chat message with █ gutter prefix and role-colored prefix glyph.
 *
 * In the new OutputArea, messages are prefixed with a colored █ gutter
 * character that visually separates content from the left margin. Code
 * blocks are rendered inside bordered sub-boxes.
 */
export const ChatMessage: React.FC<ChatMessageProps> = ({ compact = false, message }) => {
  const config = roleConfig[message.role];

  // Check for code blocks in agent messages
  const codeBlocks = extractCodeBlocks(message.text);
  const hasCodeBlocks = codeBlocks.length > 0;

  if (hasCodeBlocks) {
    const textWithoutBlocks = removeCodeBlocks(message.text);
    return (
      <Box flexDirection="column" marginBottom={compact ? 0 : 1} paddingX={spacing.inputPadX}>
        <Box>
          <Text color={colors.brand}>█ </Text>
          <Text bold color={config.color}>{config.prefix} </Text>
          {message.role === 'user' ? (
            <Text color={config.color}>{textWithoutBlocks}</Text>
          ) : (
            <Text wrap="wrap">{textWithoutBlocks}</Text>
          )}
        </Box>
        {codeBlocks.map((block, i) => (
          <Box
            borderColor={colors.dim}
            borderStyle="single"
            flexDirection="column"
            key={`cb-${i}`}
            paddingX={1}
          >
            <Text wrap="wrap">{block}</Text>
          </Box>
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={compact ? 0 : 1} paddingX={spacing.inputPadX}>
      <Box>
        <Text color={colors.brand}>█ </Text>
        <Text bold color={config.color}>{config.prefix} </Text>
        {message.role === 'user' ? (
          <Text color={config.color}>{message.text}</Text>
        ) : (
          <Text wrap="wrap">{message.text}</Text>
        )}
      </Box>
    </Box>
  );
};

function extractCodeBlocks(text: string): string[] {
  const regex = /```[\s\S]*?```/g;
  const blocks: string[] = [];
  let match = regex.exec(text);
  while (match !== null) {
    const block = match[0].replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
    blocks.push(block);
    match = regex.exec(text);
  }

  return blocks;
}

function removeCodeBlocks(text: string): string {
  return text.replaceAll(/```[\s\S]*?```/g, '').trim();
}
