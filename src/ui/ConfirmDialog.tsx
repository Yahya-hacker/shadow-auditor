import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import React from 'react';

import { useAppStore } from './store/appStore.js';
import { colors } from './theme/chalkTheme.js';

export const ConfirmDialog: React.FC = () => {
  const confirmation = useAppStore((state) => state.confirmation);
  const closeConfirmation = useAppStore((state) => state.closeConfirmation);

  if (!confirmation.open) {
    return null;
  }

  const options = [
    { label: 'Yes, approve', value: 'yes' },
    { label: 'No, deny', value: 'no' },
  ];

  const handleSelect = (item: { value: string }) => {
    confirmation.onConfirm(item.value === 'yes');
    closeConfirmation();
  };

  return (
    <Box
      alignItems="center"
      flexDirection="column"
      height="100%"
      justifyContent="center"
    >
      <Box
        borderColor="yellow"
        borderStyle="round"
        flexDirection="column"
        padding={1}
      >
        <Box marginBottom={1}>
          <Text bold color="yellow">
            {confirmation.title}
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text>{confirmation.message}</Text>
        </Box>
        {confirmation.details && (
          <Box borderColor="gray" borderStyle="single" marginBottom={1} padding={1}>
            <Text dimColor>{confirmation.details}</Text>
          </Box>
        )}
        <SelectInput items={options} onSelect={handleSelect} />
      </Box>
    </Box>
  );
};
