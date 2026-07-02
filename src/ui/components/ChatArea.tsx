import { Box, Text } from 'ink';
import React from 'react';

import { useAppStore } from '../store/appStore.js';
import { colors } from '../theme/chalkTheme.js';
import { ChatMessage } from './ChatMessage.js';

interface ChatAreaProps {
  /** Available body height (rows) for windowing the message list. */
  height: number;
}

/**
 * Scrollable, searchable chat transcript.
 *
 * Ink has no native scroll viewport, so we render a window of the most recent
 * messages ending at (length - scrollOffset). scrollOffset 0 follows the
 * latest (auto-scroll); j/k/↑↓ shift the window back/forward. When search is
 * active, messages are live-filtered by substring.
 */
export const ChatArea: React.FC<ChatAreaProps> = ({ height }) => {
  const messages = useAppStore((state) => state.messages);
  const scrollOffset = useAppStore((state) => state.scrollOffset);
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

  // Each message occupies ~2 rows (text + margin); window from body height.
  const maxVisible = Math.max(1, Math.floor((height - 2) / 2));
  // Clamp so an out-of-range offset (e.g. "jump to top") still shows the oldest
  // window rather than an empty one.
  const effectiveOffset = Math.min(scrollOffset, Math.max(0, filtered.length - maxVisible));
  const end = filtered.length - effectiveOffset;
  const start = Math.max(0, end - maxVisible);
  const windowMessages = filtered.slice(start, end);
  const earlier = start;
  const newer = effectiveOffset;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {earlier > 0 && (
        <Text color={colors.dim}>
          ↑ {earlier} earlier message{earlier === 1 ? '' : 's'}
          {searchActive ? ' (filtered)' : ''}
        </Text>
      )}
      {windowMessages.map((msg) => (
        <ChatMessage key={msg.id} message={msg} />
      ))}
      {newer > 0 && (
        <Text color={colors.dim}>
          ↓ {newer} newer message{newer === 1 ? '' : 's'} (press j to follow)
        </Text>
      )}
    </Box>
  );
};
