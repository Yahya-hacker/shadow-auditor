import { Box } from 'ink';
import React from 'react';

import { useAppStore } from '../store/appStore.js';
import { ChatMessage } from './ChatMessage.js';

export const ChatArea: React.FC = () => {
  const messages = useAppStore((state) => state.messages);

  if (messages.length === 0) {
    return <Box flexGrow={1} />;
  }

  return (
    <Box flexDirection="column" flexGrow={1} overflowY="hidden">
      {messages.map((msg) => (
        <ChatMessage key={msg.id} message={msg} />
      ))}
    </Box>
  );
};
