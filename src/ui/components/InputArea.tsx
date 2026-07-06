import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import React, { memo } from 'react';

import { useAppStore } from '../store/appStore.js';
import { colors, getPanelStyle } from '../theme/chalkTheme.js';

interface InputAreaProps {
  onSubmit: (command: string) => void;
}

/**
 * Query panel with focus-driven border styling. The border is stable —
 * it only changes when focus/search/streaming state changes, not on
 * every keystroke. The TextInput content updates independently.
 *
 * Architecture:
 *   InputArea (outer) — subscribes to focus, streaming, searchActive,
 *     humanInputRequest. Does NOT subscribe to `input` or `searchQuery`.
 *   InputBorder — memoized wrapper that only re-renders on border-relevant
 *     state changes (focus, searchActive).
 *   InputContent — subscribes to `input` and `searchQuery` from the store
 *     directly, so only this leaf component re-renders on every keystroke.
 *
 * This separation prevents the terminal border from being redrawn on
 * every keystroke, eliminating the flickering that occurs when Ink
 * has to repaint box-drawing characters during fast typing.
 */

/** Stable border wrapper — only re-renders when focus or streaming changes. */
const InputBorder = memo<{
  children: React.ReactNode;
  isFocused: boolean;
  searchActive: boolean;
}>(({ children, isFocused, searchActive }) => {
  const panelStyle = searchActive
    ? { borderColor: colors.pending, borderStyle: 'double' as const }
    : getPanelStyle(isFocused);

  return (
    <Box
      borderColor={panelStyle.borderColor}
      borderStyle={panelStyle.borderStyle}
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color={panelStyle.borderColor}>Query</Text>
      {children}
    </Box>
  );
});
InputBorder.displayName = 'InputBorder';

/**
 * The actual text input — reads `input` and `searchQuery` from the store
 * directly so only this leaf re-renders on every keystroke.
 */
const InputContent = memo<{
  isFocused: boolean;
  onSubmit: (command: string) => void;
  placeholder: string;
  searchActive: boolean;
  streaming: boolean;
}>(({ isFocused, onSubmit, placeholder, searchActive, streaming }) => {
  // These subscriptions are deliberately here (not in the parent) so that
  // keystroke-driven changes only re-render this leaf component.
  const input = useAppStore((s) => s.input);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setInput = useAppStore((s) => s.setInput);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const setSearchActive = useAppStore((s) => s.setSearchActive);

  if (streaming) {
    return (
      <Box>
        <Text bold color={colors.brand}>❯ </Text>
        <Text color={colors.agent}>
          <Spinner type="dots" /> Agent is thinking...
        </Text>
      </Box>
    );
  }

  if (searchActive) {
    return (
      <Box>
        <Text bold color={colors.pending}>filter ❯ </Text>
        <TextInput
          onChange={setSearchQuery}
          onSubmit={() => { if (!searchQuery) setSearchActive(false); }}
          placeholder="filter messages… (Esc to clear)"
          value={searchQuery}
        />
      </Box>
    );
  }

  if (isFocused) {
    return (
      <Box>
        <Text bold color={colors.brand}>❯ </Text>
        <TextInput
          onChange={setInput}
          onSubmit={onSubmit}
          placeholder={placeholder}
          value={input}
        />
      </Box>
    );
  }

  return (
    <Text color={colors.muted}>
      {input || 'Press <Enter> to search or type a command...'}
    </Text>
  );
});
InputContent.displayName = 'InputContent';

export const InputArea: React.FC<InputAreaProps> = memo(({ onSubmit }) => {
  // Deliberately does NOT subscribe to `input` or `searchQuery` —
  // those are read by InputContent directly to avoid border re-renders.
  const focus = useAppStore((s) => s.focus);
  const streaming = useAppStore((s) => s.streaming);
  const searchActive = useAppStore((s) => s.searchActive);
  const humanInputRequest = useAppStore((s) => s.humanInputRequest);

  const isFocused = focus === 'input';

  const placeholder = humanInputRequest
    ? humanInputRequest.type === 'confirmation'
      ? 'Type yes/no to confirm...'
      : 'Type your answer...'
    : 'Describe a security concern or ask a question...';

  return (
    <Box flexDirection="column">
      <InputBorder isFocused={isFocused} searchActive={searchActive}>
        <InputContent
          isFocused={isFocused}
          onSubmit={onSubmit}
          placeholder={placeholder}
          searchActive={searchActive}
          streaming={streaming}
        />
      </InputBorder>
    </Box>
  );
});

InputArea.displayName = 'InputArea';
