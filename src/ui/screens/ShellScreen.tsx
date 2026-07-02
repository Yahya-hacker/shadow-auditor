import { Box, useApp } from 'ink';
import React, { useState } from 'react';

import { useAgentSessionRef } from '../AgentSessionContext.js';
import { ActivityPanel } from '../components/ActivityPanel.js';
import { ChatArea } from '../components/ChatArea.js';
import { Header } from '../components/Header.js';
import { InputArea } from '../components/InputArea.js';
import { StatusLine } from '../components/StatusLine.js';
import { StreamingResponse } from '../components/StreamingResponse.js';
import { Layout, Panel } from '../layout/Layout.js';
import { useAppStore } from '../store/appStore.js';

function useHandleSubmit(
  setIsProcessing: (value: boolean) => void,
  exit: () => void,
): (command: string) => void {
  const agentSessionRef = useAgentSessionRef();
  const addUserMessage = useAppStore((state) => state.addUserMessage);
  const setInput = useAppStore((state) => state.setInput);
  const clearActivity = useAppStore((state) => state.clearActivity);
  const startStreaming = useAppStore((state) => state.startStreaming);
  const appendStreamChunk = useAppStore((state) => state.appendStreamChunk);
  const finishStreaming = useAppStore((state) => state.finishStreaming);
  const addErrorMessage = useAppStore((state) => state.addErrorMessage);
  const addActivityEvent = useAppStore((state) => state.addActivityEvent);

  return async (command: string) => {
    const trimmed = command.trim();
    if (!trimmed) return;

    if ([':q', ':quit', 'exit', 'quit'].includes(trimmed.toLowerCase())) {
      exit();
      return;
    }

    addUserMessage(trimmed);
    setInput('');
    setIsProcessing(true);
    clearActivity();
    startStreaming();

    try {
      await agentSessionRef.current?.sendMessage(
        trimmed,
        (chunk: string) => {
          appendStreamChunk(chunk);
        },
        (event) => {
          addActivityEvent(event);
        },
      );
      finishStreaming();
    } catch (error) {
      const errMsg = (error as Error).message;
      if (errMsg.includes('API key') || errMsg.includes('401') || errMsg.includes('authentication')) {
        addErrorMessage('Authentication failed. Run again with --reconfigure.');
      } else {
        addErrorMessage(`Error: ${errMsg}`);
      }

      finishStreaming();
    } finally {
      setIsProcessing(false);
    }
  };
}

export const ShellScreen: React.FC = () => {
  const config = useAppStore((state) => state.config);
  const targetPath = useAppStore((state) => state.session.targetPath);
  const isStreaming = useAppStore((state) => state.streaming);
  const streamingText = useAppStore((state) => state.streamingText);
  const activity = useAppStore((state) => state.activity);
  const [isProcessing, setIsProcessing] = useState(false);
  const { exit } = useApp();

  const handleSubmit = useHandleSubmit(setIsProcessing, exit);

  return (
    <Layout>
      {(rect) => (
        <Box
          flexDirection="column"
          height={rect.header.height + rect.body.height + rect.status.height + rect.input.height}
          width={rect.header.width}
        >
          <Panel rect={rect.header}>
            <Header
              expertUnsafe={config?.expertUnsafe}
              model={config?.model ?? 'unknown'}
              provider={config?.provider ?? 'unknown'}
              targetName={targetPath}
            />
          </Panel>
          <Panel rect={rect.body}>
            <Box flexDirection="column" height={rect.body.height}>
              <ChatArea />
              {isStreaming && <StreamingResponse text={streamingText} />}
              {activity.length > 0 && <ActivityPanel />}
            </Box>
          </Panel>
          <Panel rect={rect.status}>
            <StatusLine />
          </Panel>
          <Panel rect={rect.input}>
            <InputArea isProcessing={isProcessing} onSubmit={handleSubmit} />
          </Panel>
        </Box>
      )}
    </Layout>
  );
};
