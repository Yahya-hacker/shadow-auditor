import React, { memo, useMemo } from 'react';
/**
 * InputArea — OpenTUI query input with focus-aware border and slash command
 * suggestions.
 *
 * Architecture:
 *   InputArea (outer) — subscribes to focus, streaming, searchActive.
 *     Does NOT subscribe to `input` or `searchQuery`.
 *   InputBorder — memoized wrapper for border (stable across keystrokes).
 *   InputContent — subscribes to `input`/`searchQuery` from store.
 *   CommandSuggestions — shows available slash commands when input starts with `/`.
 */

import { getCommandSuggestions } from '../commands.js';
import { Box, Input, Text } from "../primitives.js";
import { useAppStore } from '../store/appStore.js';
import { colors, getPanelStyle } from '../theme/chalkTheme.js';

interface InputAreaProps {
  onSubmit: (command: string) => void;
}

/** Stable border wrapper — only re-renders when focus/search/streaming changes. */
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
      borderColor={panelStyle.borderColor} borderStyle={panelStyle.borderStyle}
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
  const input = useAppStore((s) => s.input);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setInput = useAppStore((s) => s.setInput);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const setSearchActive = useAppStore((s) => s.setSearchActive);

  if (streaming) {
    return (
      <Box>
        <Text bold color={colors.brand}>❯ </Text>
        <Text animate="pulse" color={colors.agent}>
          ● Agent is thinking...
        </Text>
      </Box>
    );
  }

  if (searchActive) {
    const handleSubmit = () => {
      // Enter in search mode: exit search and return focus to input.
      setSearchActive(false);
    };

    return (
      <Box>
        <Text bold color={colors.pending}>filter ❯ </Text>
        <Input
          onChange={(val: string) => setSearchQuery(val)}
          onSubmit={handleSubmit}
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
        <Input
          onChange={(val: string) => setInput(val)}
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

/**
 * Shows matching slash commands when input starts with `/`.
 * Subscribes to `input` directly so only this leaf re-renders.
 */
const CommandSuggestions: React.FC = memo(() => {
  const input = useAppStore((s) => s.input);

  const suggestions = useMemo(() => {
    if (!input.startsWith('/')) return [];
    // Don't show suggestions after a space (user has typed args)
    if (input.includes(' ')) return [];
    return getCommandSuggestions(input);
  }, [input]);

  if (suggestions.length === 0) return null;

  return (
    <Box flexDirection="column">
      {suggestions.map((cmd) => (
        <Text key={cmd.name}>
          <Text bold color={colors.brand}>{cmd.name}</Text>
          <Text color={colors.muted}> — {cmd.description}</Text>
        </Text>
      ))}
    </Box>
  );
});
CommandSuggestions.displayName = 'CommandSuggestions';

export const InputArea: React.FC<InputAreaProps> = memo(({ onSubmit }) => {
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
      <CommandSuggestions />
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
