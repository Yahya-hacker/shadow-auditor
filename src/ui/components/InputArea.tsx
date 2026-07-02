import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import React from 'react';

import { useAppStore } from '../store/appStore.js';
import { colors, spacing } from '../theme/chalkTheme.js';
import { Footer } from './Footer.js';

interface InputAreaProps {
  isProcessing: boolean;
  onSubmit: (command: string) => void;
}

/**
 * Input region with three modes:
 * - search: a filter TextInput bound to `searchQuery` (entered via `/`).
 * - input (default): the message TextInput for typing commands.
 * - panel: a static, non-capturing view of the current input, so global
 *   navigation keys (j/k, g/G, ?) don't conflict with typing while the swarm
 *   panel is focused. Press `i` or `Tab` to return to editable input.
 */
export const InputArea: React.FC<InputAreaProps> = ({ isProcessing, onSubmit }) => {
  const input = useAppStore((state) => state.input);
  const setInput = useAppStore((state) => state.setInput);
  const targetPath = useAppStore((state) => state.session.targetPath);
  const focus = useAppStore((state) => state.focus);
  const searchActive = useAppStore((state) => state.searchActive);
  const searchQuery = useAppStore((state) => state.searchQuery);
  const setSearchQuery = useAppStore((state) => state.setSearchQuery);
  const setSearchActive = useAppStore((state) => state.setSearchActive);

  const modeLabel = searchActive ? 'search' : focus === 'panel' ? 'panel' : 'ready';
  const prompt = searchActive ? 'filter' : targetPath;
  const promptColor = searchActive ? colors.pending : colors.success;

  return (
    <Box flexDirection="column" marginTop={1} paddingX={spacing.inputPadX}>
      <Box>
        <Text color={promptColor}>{prompt} </Text>
        <Text color={colors.muted}>[{modeLabel}]</Text>
      </Box>

      <Box marginTop={1}>
        <Text bold color={colors.brand}>
          ❯{' '}
        </Text>
        {isProcessing ? (
          <Text color={colors.agent}>
            <Spinner type="dots" /> Agent is thinking...
          </Text>
        ) : searchActive ? (
          <TextInput
            onChange={setSearchQuery}
            onSubmit={() => {
              if (!searchQuery) setSearchActive(false);
            }}
            placeholder="filter messages… (Esc to clear)"
            value={searchQuery}
          />
        ) : focus === 'input' ? (
          <TextInput
            onChange={setInput}
            onSubmit={onSubmit}
            placeholder="Describe a security concern or ask a question..."
            value={input}
          />
        ) : (
          <Text color={colors.muted}>
            {input || '(press i or Tab to edit)'}
          </Text>
        )}
      </Box>

      <Box marginTop={1}>
        <Footer />
      </Box>
    </Box>
  );
};
