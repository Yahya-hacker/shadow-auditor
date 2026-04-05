import React, { useState } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';

interface ConfirmDialogProps {
  title: string;
  message: string;
  details?: string;
  onConfirm: (confirmed: boolean) => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({ title, message, details, onConfirm }) => {
  const options = [
    { label: 'Yes, approve', value: true },
    { label: 'No, deny', value: false },
  ];

  const handleSelect = (item: { value: boolean }) => {
    onConfirm(item.value);
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="yellow">{title}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text>{message}</Text>
      </Box>
      {details && (
        <Box marginBottom={1} borderStyle="single" borderColor="gray" padding={1}>
          <Text dimColor>{details}</Text>
        </Box>
      )}
      <SelectInput items={options} onSelect={handleSelect} />
    </Box>
  );
};

interface FileEditPreviewProps {
  filePath: string;
  targetCode: string;
  replacementCode: string;
  onConfirm: (confirmed: boolean) => void;
}

export const FileEditPreview: React.FC<FileEditPreviewProps> = ({
  filePath,
  targetCode,
  replacementCode,
  onConfirm,
}) => {
  const options = [
    { label: 'Apply patch', value: true },
    { label: 'Deny', value: false },
  ];

  const handleSelect = (item: { value: boolean }) => {
    onConfirm(item.value);
  };

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="yellow">🔧 PROPOSED FILE EDIT</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color="cyan">File: </Text>
        <Text>{filePath}</Text>
      </Box>
      
      {/* Remove section */}
      <Box marginBottom={1} flexDirection="column">
        <Text bold color="red">─── REMOVE ───</Text>
        {targetCode.split('\n').map((line, idx) => (
          <Text key={`remove-${idx}`} color="red">- {line}</Text>
        ))}
      </Box>

      {/* Add section */}
      <Box marginBottom={1} flexDirection="column">
        <Text bold color="green">+++ ADD +++</Text>
        {replacementCode.split('\n').map((line, idx) => (
          <Text key={`add-${idx}`} color="green">+ {line}</Text>
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
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="yellow">⚡ PROPOSED COMMAND EXECUTION</Text>
      </Box>
      <Box marginBottom={1} borderStyle="single" borderColor="magenta" padding={1}>
        <Text color="magenta">$ {command}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text bold>Execute this command?</Text>
      </Box>
      <SelectInput items={options} onSelect={handleSelect} />
    </Box>
  );
};
