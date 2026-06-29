import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import React, { useState } from 'react';

interface ConfirmDialogProps {
  details?: string;
  message: string;
  onConfirm: (confirmed: boolean) => void;
  title: string;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({ details, message, onConfirm, title }) => {
  const options = [
    { label: 'Yes, approve', value: true },
    { label: 'No, deny', value: false },
  ];

  const handleSelect = (item: { value: boolean }) => {
    onConfirm(item.value);
  };

  return (
    <Box borderColor="yellow" borderStyle="round" flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="yellow">{title}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text>{message}</Text>
      </Box>
      {details && (
        <Box borderColor="gray" borderStyle="single" marginBottom={1} padding={1}>
          <Text dimColor>{details}</Text>
        </Box>
      )}
      <SelectInput items={options} onSelect={handleSelect} />
    </Box>
  );
};

interface FileEditPreviewProps {
  filePath: string;
  onConfirm: (confirmed: boolean) => void;
  replacementCode: string;
  targetCode: string;
}

export const FileEditPreview: React.FC<FileEditPreviewProps> = ({
  filePath,
  onConfirm,
  replacementCode,
  targetCode,
}) => {
  const options = [
    { label: 'Apply patch', value: true },
    { label: 'Deny', value: false },
  ];

  const handleSelect = (item: { value: boolean }) => {
    onConfirm(item.value);
  };

  return (
    <Box borderColor="yellow" borderStyle="double" flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="yellow">🔧 PROPOSED FILE EDIT</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color="cyan">File: </Text>
        <Text>{filePath}</Text>
      </Box>
      
      {/* Remove section */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="red">─── REMOVE ───</Text>
        {targetCode.split('\n').map((line, idx) => (
          <Text color="red" key={`remove-${idx}`}>- {line}</Text>
        ))}
      </Box>

      {/* Add section */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="green">+++ ADD +++</Text>
        {replacementCode.split('\n').map((line, idx) => (
          <Text color="green" key={`add-${idx}`}>+ {line}</Text>
        ))}
      </Box>

      <Box marginBottom={1}>
        <Text bold>Apply this patch to {filePath}?</Text>
      </Box>
      
      <SelectInput items={options} onSelect={handleSelect} />
    </Box>
  );
};

interface CommandPreviewProps {
  command: string;
  onConfirm: (confirmed: boolean) => void;
}

export const CommandPreview: React.FC<CommandPreviewProps> = ({ command, onConfirm }) => {
  const options = [
    { label: 'Execute', value: true },
    { label: 'Deny', value: false },
  ];

  const handleSelect = (item: { value: boolean }) => {
    onConfirm(item.value);
  };

  return (
    <Box borderColor="yellow" borderStyle="round" flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="yellow">⚡ PROPOSED COMMAND EXECUTION</Text>
      </Box>
      <Box borderColor="magenta" borderStyle="single" marginBottom={1} padding={1}>
        <Text color="magenta">$ {command}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text bold>Execute this command?</Text>
      </Box>
      <SelectInput items={options} onSelect={handleSelect} />
    </Box>
  );
};
