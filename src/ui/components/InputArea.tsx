/**
 * InputArea — OpenTUI query input with focus-aware border.
 *
 * Architecture:
 *   InputArea (outer) — subscribes to focus, streaming, searchActive.
 *     Does NOT subscribe to `input` or `searchQuery`.
 *   InputBorder — memoized wrapper for border (stable across keystrokes).
 *   InputContent — subscribes to `input`/`searchQuery` from store.
 *
 * Strict Focus Isolation: when the <input> is focused and has text,
 * ALL keystrokes stay in the input. Navigation shortcuts only activate
 * when the input is empty (handled in ShellScreen's useHandleSubmit).
 */

import React, { memo } from 'react';

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
    <box
      border={{ color: panelStyle.borderColor, style: panelStyle.borderStyle }}
      flexDirection="column"
      paddingX={1}
    >
      <text style={{ color: panelStyle.borderColor, fontWeight: 'bold' }}>Query</text>
      {children}
    </box>
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
      <box>
        <text style={{ color: colors.brand, fontWeight: 'bold' }}>❯ </text>
        <text style={{ color: colors.agent }} animate="pulse">
          ● Agent is thinking...
        </text>
      </box>
    );
  }

  if (searchActive) {
    const handleSubmit = () => {
      if (!searchQuery) setSearchActive(false);
    };
    return (
      <box>
        <text style={{ color: colors.pending, fontWeight: 'bold' }}>filter ❯ </text>
        <input
          value={searchQuery}
          onChange={(val: string) => setSearchQuery(val)}
          onSubmit={handleSubmit}
          placeholder="filter messages… (Esc to clear)"
        />
      </box>
    );
  }

  if (isFocused) {
    return (
      <box>
        <text style={{ color: colors.brand, fontWeight: 'bold' }}>❯ </text>
        <input
          value={input}
          onChange={(val: string) => setInput(val)}
          onSubmit={onSubmit}
          placeholder={placeholder}
        />
      </box>
    );
  }

  return (
    <text style={{ color: colors.muted }}>
      {input || 'Press <Enter> to search or type a command...'}
    </text>
  );
});
InputContent.displayName = 'InputContent';

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
    <box flexDirection="column">
      <InputBorder isFocused={isFocused} searchActive={searchActive}>
        <InputContent
          isFocused={isFocused}
          onSubmit={onSubmit}
          placeholder={placeholder}
          searchActive={searchActive}
          streaming={streaming}
        />
      </InputBorder>
    </box>
  );
});

InputArea.displayName = 'InputArea';
