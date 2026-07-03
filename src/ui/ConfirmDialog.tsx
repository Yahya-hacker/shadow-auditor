import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import React from 'react';

import type { HumanInputRequest } from '../core/graph/state.js';

import { useAgentSessionRef } from './AgentSessionContext.js';
import { useAppStore } from './store/appStore.js';
import { colors } from './theme/chalkTheme.js';
import { debugLog } from '../utils/debug-logger.js';

/**
 * Confirmation dialog for two sources:
 * 1. Legacy Zustand confirmation (blocking Promise pattern from the Vercel AI
 *    SDK flow, used by the swarm coordinator).
 * 2. LangGraph interrupt-driven confirmations (humanInputRequest set when the
 *    graph pauses at HumanIntervention via interruptBefore).
 *
 * For type='confirmation', renders a Yes/No dialog that calls
 * `agent.resumeWithHumanInput(true/false)` on selection.
 * For type='question', shows the question and instructs the user to type
 * their answer in the InputArea (which routes through useHandleSubmit).
 */
export const ConfirmDialog: React.FC = () => {
  const confirmation = useAppStore((state) => state.confirmation);
  const closeConfirmation = useAppStore((state) => state.closeConfirmation);
  const humanInputRequest = useAppStore((state) => state.humanInputRequest);
  const setHumanInputRequest = useAppStore((state) => state.setHumanInputRequest);
  const addUserMessage = useAppStore((state) => state.addUserMessage);
  const startStreaming = useAppStore((state) => state.startStreaming);
  const appendStreamChunk = useAppStore((state) => state.appendStreamChunk);
  const finishStreaming = useAppStore((state) => state.finishStreaming);
  const addActivityEvent = useAppStore((state) => state.addActivityEvent);
  const addErrorMessage = useAppStore((state) => state.addErrorMessage);
  const agentSessionRef = useAgentSessionRef();

  // Handle LangGraph interrupt-driven confirmation
  if (humanInputRequest && humanInputRequest.type === 'confirmation') {
    const options = [
      { label: 'Yes, approve', value: 'yes' },
      { label: 'No, deny', value: 'no' },
    ];

    const handleSelect = async (item: { value: string }) => {
      const approved = item.value === 'yes';
      const answerText = approved ? 'Yes, approve' : 'No, deny';
      
      addUserMessage(answerText);
      setHumanInputRequest(null);
      startStreaming();

      // Resume the LangGraph graph with the human's answer
      try {
        await agentSessionRef.current?.resumeWithHumanInput(
          approved,
          (chunk: string) => { appendStreamChunk(chunk); },
          (event) => { addActivityEvent(event); },
        );
        finishStreaming();
      } catch (error) {
        debugLog(`[ConfirmDialog] Resume failed: ${error}`);
        addErrorMessage(`Error: ${(error as Error).message}`);
        finishStreaming();
      }
    };

    return (
      <Box
        alignItems="center"
        flexDirection="column"
        height="100%"
        justifyContent="center"
      >
        <Box
          borderColor={colors.warning}
          borderStyle="round"
          flexDirection="column"
          padding={1}
        >
          <Box marginBottom={1}>
            <Text bold color={colors.warning}>
              {humanInputRequest.question}
            </Text>
          </Box>
          {humanInputRequest.context && (
            <Box borderColor={colors.dim} borderStyle="single" marginBottom={1} padding={1}>
              <Text dimColor>{humanInputRequest.context}</Text>
            </Box>
          )}
          <SelectInput items={options} onSelect={handleSelect} />
        </Box>
      </Box>
    );
  }

  // Handle LangGraph interrupt-driven question (user types answer in InputArea)
  if (humanInputRequest && humanInputRequest.type === 'question') {
    return (
      <Box
        alignItems="center"
        flexDirection="column"
        height="100%"
        justifyContent="center"
      >
        <Box
          borderColor={colors.info}
          borderStyle="round"
          flexDirection="column"
          padding={1}
        >
          <Box marginBottom={1}>
            <Text bold color={colors.info}>
              {humanInputRequest.question}
            </Text>
          </Box>
          {humanInputRequest.context && (
            <Box marginBottom={1}>
              <Text dimColor>{humanInputRequest.context}</Text>
            </Box>
          )}
          <Text color={colors.muted}>
            Type your answer below and press Enter.
          </Text>
        </Box>
      </Box>
    );
  }

  // Handle legacy Zustand confirmation (blocking Promise pattern)
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
