import { Box, Static, Text } from 'ink';
import React from 'react';

import { useAppStore } from '../store/appStore.js';
import { colors } from '../theme/chalkTheme.js';
import { ChatMessage } from './ChatMessage.js';

interface ChatAreaProps {
  /** Available body height (rows) for windowing the message list. */
  height: number;
}

/**
 * Chat transcript using Ink's <Static> component.
 *
 * By using <Static>, messages are written to the terminal once and for all,
 * never re-evaluating them during subsequent refreshes. This instantly removes
 * flickering from frozen text sections and avoids the "Ink Full-Rerender Trap"
 * where the entire component tree is cleared and redrawn on every token stream.
 */
export const ChatArea: React.FC<ChatAreaProps> = ({ height }) => {
  const messages = useAppStore((state) => state.messages);
  const searchActive = useAppStore((state) => state.searchActive);
  const searchQuery = useAppStore((state) => state.searchQuery);

  const query = searchActive && searchQuery ? searchQuery.toLowerCase() : '';
  const filtered = query ? messages.filter((m) => m.text.toLowerCase().includes(query)) : messages;

  if (filtered.length === 0) {
    return (
      <Box flexGrow={1}>
        {searchActive && (
          <Text color={colors.muted}>
            No messages match &quot;{searchQuery}&quot;.
          </Text>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Static items={filtered}>
        {(msg) => <ChatMessage key={msg.id} message={msg} />}
      </Static>
    </Box>
  );
};
