import { Box, Text, Input } from "../opentui/components.js";
/**
 * Confirmation dialog — OpenTUI interactive elements.
 *
 * Handles two interruption sources:
 * 1. LangGraph interrupt-driven confirmations (humanInputRequest)
 * 2. Legacy Zustand confirmation (blocking Promise pattern)
 *
 * Now renders as a modal replacement (App.tsx switches to dialog-only
 * when active), fixing the Yoga sibling-stacking layout issue.
 */

import React, { useEffect, useState } from 'react';

import { debugLog } from '../utils/debug-logger.js';
import { useAgentSessionRef } from './AgentSessionContext.js';
import { OptionList } from './components/OptionList.js';
import { useAppStore } from './store/appStore.js';
import { colors } from './theme/chalkTheme.js';

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

  // Local state for the question input so users get visual feedback while typing.
  const [questionInput, setQuestionInput] = useState('');

  // Reset question input whenever a new human-input request arrives.
  useEffect(() => {
    if (humanInputRequest?.type === 'question') {
      setQuestionInput('');
    }
  }, [humanInputRequest]);

  // ── LangGraph interrupt-driven confirmation ────────────────────────
  if (humanInputRequest && humanInputRequest.type === 'confirmation') {
    const options = [
      { label: 'Yes, approve', value: 'yes' },
      { label: 'No, deny', value: 'no' },
    ];

    const handleSelect = async (value: string) => {
      const approved = value === 'yes';
      const answerText = approved ? 'Yes, approve' : 'No, deny';

      addUserMessage(answerText);
      setHumanInputRequest(null);
      startStreaming();

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
        width="100%"
        height="100%"
        justifyContent="center"
      >
        <Box
          borderColor={colors.warning} borderStyle={'rounded'}
          flexDirection="column"
          padding={1}
        >
          <Box marginBottom={1}>
            <Text color={colors.warning} bold>
              {humanInputRequest.question}
            </Text>
          </Box>
          {humanInputRequest.context && (
            <Box
              borderColor={colors.dim} borderStyle={'single'}
              marginBottom={1}
              padding={1}
            >
              <Text color={colors.muted} italic>
                {humanInputRequest.context}
              </Text>
            </Box>
          )}
          <OptionList
            options={options}
            onSelect={handleSelect}
            onCancel={() => handleSelect('no')}
            focused={true}
          />
        </Box>
      </Box>
    );
  }

  // ── LangGraph interrupt-driven question (type your answer) ─────────
  if (humanInputRequest && humanInputRequest.type === 'question') {
    const handleQuestionSubmit = async (answer: string) => {
      const trimmed = answer.trim();
      if (!trimmed) return;

      setQuestionInput('');
      addUserMessage(trimmed);
      setHumanInputRequest(null);
      startStreaming();

      try {
        await agentSessionRef.current?.resumeWithHumanInput(
          trimmed,
          (chunk: string) => { appendStreamChunk(chunk); },
          (event) => { addActivityEvent(event); },
        );
        finishStreaming();
      } catch (error) {
        debugLog(`[ConfirmDialog] Question resume failed: ${error}`);
        addErrorMessage(`Error: ${(error as Error).message}`);
        finishStreaming();
      }
    };

    return (
      <Box
        alignItems="center"
        flexDirection="column"
        width="100%"
        height="100%"
        justifyContent="center"
      >
        <Box
          borderColor={colors.info} borderStyle={'rounded'}
          flexDirection="column"
          padding={1}
        >
          <Box marginBottom={1}>
            <Text color={colors.info} bold>
              {humanInputRequest.question}
            </Text>
          </Box>
          {humanInputRequest.context && (
            <Box marginBottom={1}>
              <Text color={colors.muted} italic>
                {humanInputRequest.context}
              </Text>
            </Box>
          )}
          <Text color={colors.muted} italic>
            Type your answer below and press Enter.
          </Text>
          <Box marginTop={1}>
            <Text color={colors.brand} bold>❯ </Text>
            <Input
              value={questionInput}
              onChange={(v: string) => setQuestionInput(v)}
              onSubmit={handleQuestionSubmit}
              placeholder="Type your answer..."
            />
          </Box>
        </Box>
      </Box>
    );
  }

  // ── Legacy Zustand confirmation ────────────────────────────────────
  // Also reached when humanInputRequest exists but has an unrecognized type.
  if (!confirmation.open) {
    // If we have a humanInputRequest with an unknown type, render a generic prompt.
    if (humanInputRequest) {
      return (
        <Box
          alignItems="center"
          flexDirection="column"
          width="100%"
          height="100%"
          justifyContent="center"
        >
          <Box
            borderColor={colors.warning} borderStyle={'rounded'}
            flexDirection="column"
            padding={1}
          >
            <Box marginBottom={1}>
              <Text color={colors.warning} bold>
                {humanInputRequest.question || 'Input required'}
              </Text>
            </Box>
            <Text color={colors.muted}>
              Unsupported prompt type: {humanInputRequest.type}. Press Enter to continue.
            </Text>
          </Box>
        </Box>
      );
    }
    return null;
  }

  const options = [
    { label: 'Yes, approve', value: 'yes' },
    { label: 'No, deny', value: 'no' },
  ];

  const handleSelect = (value: string) => {
    confirmation.onConfirm(value === 'yes');
    closeConfirmation();
  };

  return (
    <Box
      alignItems="center"
      flexDirection="column"
      width="100%"
      height="100%"
      justifyContent="center"
    >
      <Box
        borderColor={colors.warning} borderStyle={'rounded'}
        flexDirection="column"
        padding={1}
      >
        <Box marginBottom={1}>
          <Text color={colors.warning} bold>
            {confirmation.title}
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text>{confirmation.message}</Text>
        </Box>
        {confirmation.details && (
          <Box
            borderColor={colors.dim} borderStyle={'single'}
            marginBottom={1}
            padding={1}
          >
            <Text color={colors.muted} italic>
              {confirmation.details}
            </Text>
          </Box>
        )}
        <OptionList
          options={options}
          onSelect={handleSelect}
          onCancel={() => handleSelect('no')}
          focused={true}
        />
      </Box>
    </Box>
  );
};
