import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import React from 'react';

import { useAppStore } from '../store/appStore.js';
import { colors, getPanelStyle } from '../theme/chalkTheme.js';
import { Footer } from './Footer.js';

interface InputAreaProps {
  isProcessing: boolean;
  onSubmit: (command: string) => void;
}

/**
 * Query panel with focus-driven border styling.
 *
 * Idle:
 * ┌─ Query ────────────────────────────────────────────────────────────────┐
 * │ Press <Enter> to search or type a command...                          │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Focused:
 * ╔═ Query ════════════════════════════════════════════════════════════════╗
 * ║ > Find hardcoded AWS credentials in src/█                            ║
 * ╚═══════════════════════════════════════════════════════════════════════╝
 *
 * Border changes from single+muted (idle) to double+blue (focused).
 * Search mode switches border to pending color. The Footer keybinding bar
 * renders below the query panel.
 */
export const InputArea: React.FC<InputAreaProps> = ({ isProcessing, onSubmit }) => {
  const input = useAppStore((state) => state.input);
  const setInput = useAppStore((state) => state.setInput);
  const focus = useAppStore((state) => state.focus);
  const searchActive = useAppStore((state) => state.searchActive);
  const searchQuery = useAppStore((state) => state.searchQuery);
  const setSearchQuery = useAppStore((state) => state.setSearchQuery);
  const setSearchActive = useAppStore((state) => state.setSearchActive);
  const isCompact = useAppStore((state) => state.isCompact);
  const humanInputRequest = useAppStore((state) => state.humanInputRequest);

  const isFocused = focus === 'input';
  const panelStyle = searchActive
    ? { borderColor: colors.pending, borderStyle: 'double' as const }
    : getPanelStyle(isFocused);

  const titlePrefix = 'Query';

  const placeholder = humanInputRequest
    ? humanInputRequest.type === 'confirmation'
      ? 'Type yes/no to confirm...'
      : 'Type your answer...'
    : 'Describe a security concern or ask a question...';

  return (
    <Box flexDirection="column">
      <Box
        borderColor={panelStyle.borderColor}
        borderStyle={panelStyle.borderStyle}
        flexDirection="column"
        paddingX={1}
      >
        {/* Title line in the panel header */}
        <Text bold color={panelStyle.borderColor}>
          {titlePrefix}
        </Text>

        {/* Input line */}
        {isProcessing ? (
          <Box>
            <Text bold color={colors.brand}>❯ </Text>
            <Text color={colors.agent}>
              <Spinner type="dots" /> Agent is thinking...
            </Text>
          </Box>
        ) : searchActive ? (
          <Box>
            <Text bold color={colors.pending}>filter ❯ </Text>
            <TextInput
              onChange={setSearchQuery}
              onSubmit={() => {
                if (!searchQuery) setSearchActive(false);
              }}
              placeholder="filter messages… (Esc to clear)"
              value={searchQuery}
            />
          </Box>
        ) : isFocused ? (
          <Box>
            <Text bold color={colors.brand}>❯ </Text>
            <TextInput
              onChange={setInput}
              onSubmit={onSubmit}
              placeholder={placeholder}
              value={input}
            />
          </Box>
        ) : (
          <Text color={colors.muted}>
            {input || 'Press <Enter> to search or type a command...'}
          </Text>
        )}
      </Box>

      {/* Footer keybinding bar below the query panel */}
      {!isCompact && (
        <Box paddingX={1}>
          <Footer />
        </Box>
      )}
    </Box>
  );
};
