import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import React from 'react';

import { useAppStore } from '../store/appStore.js';
import { colors, spacing } from '../theme/chalkTheme.js';

interface InputAreaProps {
  isProcessing: boolean;
  onSubmit: (command: string) => void;
}

export const InputArea: React.FC<InputAreaProps> = ({ isProcessing, onSubmit }) => {
  const input = useAppStore((state) => state.input);
  const setInput = useAppStore((state) => state.setInput);
  const targetPath = useAppStore((state) => state.session.targetPath);

  return (
    <Box flexDirection="column" marginTop={1} paddingX={spacing.inputPadX}>
      <Box>
        <Text color={colors.success}>{targetPath} </Text>
        <Text color={colors.muted}>[ready]</Text>
      </Box>

      <Box marginTop={1}>
        <Text bold color={colors.brand}>
          ❯{' '}
        </Text>
        {isProcessing ? (
          <Text color={colors.agent}>
            <Spinner type="dots" /> Agent is thinking...
          </Text>
        ) : (
          <TextInput
            onChange={setInput}
            onSubmit={onSubmit}
            placeholder="Describe a security concern or ask a question..."
            value={input}
          />
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={colors.dim}>
          Press <Text bold>Enter</Text> to send • Type{' '}
          <Text bold>:q</Text> or <Text bold>Ctrl+C</Text> to exit
        </Text>
      </Box>
    </Box>
  );
};
