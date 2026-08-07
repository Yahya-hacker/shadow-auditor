import React, { useEffect, useState } from 'react';
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

import { debugLog } from '../utils/debug-logger.js';
import { useAgentSessionRef } from './AgentSessionContext.js';
import { OptionList } from './components/OptionList.js';
import { createThrottledStream } from './hooks/useAgentSubmit.js';
import { Box, Input, Text } from "./primitives.js";
import { useAppStore } from './store/appStore.js';
import { colors } from './theme/chalkTheme.js';

export const ConfirmDialog: React.FC = () => {
  const confirmation = useAppStore((state) => state.confirmation);
  const closeConfirmation = useAppStore((state) => state.closeConfirmation);
  const humanInputRequest = useAppStore((state) => state.humanInputRequest);
  const setHumanInputRequest = useAppStore((state) => state.setHumanInputRequest);
  const addUserMessage = useAppStore((state) => state.addUserMessage);
  const startStreaming = useAppStore((state) => state.startStreaming);
  const finishStreaming = useAppStore((state) => state.finishStreaming);
  const addErrorMessage = useAppStore((state) => state.addErrorMessage);
  const agentSessionRef = useAgentSessionRef();

  // Local state for the question input so users get visual feedback while typing.
  const [questionInput, setQuestionInput] = useState('');

  // Reset question input whenever a new human-input request arrives.
  useEffect(() => {
    if (humanInputRequest?.type === 'question' || confirmation.kind === 'text') {
      setQuestionInput('');
    }
  }, [confirmation.kind, humanInputRequest]);

  // ── LangGraph interrupt-driven confirmation ────────────────────────
  if (humanInputRequest && humanInputRequest.type === 'confirmation') {
    const options = [
      { label: 'Yes, approve', value: 'yes' },
      { label: 'No, deny', value: 'no' },
    ];

    const handleSelect = async (value: string) => {
      const request = humanInputRequest;
      const approved = value === 'yes';
      const answerText = approved ? 'Yes, approve' : 'No, deny';

      addUserMessage(answerText);
      setHumanInputRequest(null);
      startStreaming();
      const stream = createThrottledStream();

      try {
        const finalAnswer = await agentSessionRef.current?.resumeWithHumanInput(
          approved,
          stream.onChunk,
          stream.onEvent,
        );
        stream.finish();
        finishStreaming(finalAnswer);
      } catch (error) {
        stream.finish();
        debugLog(`[ConfirmDialog] Resume failed: ${error}`);
        setHumanInputRequest(request);
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
        width="100%"
      >
        <Box
          borderColor={colors.warning} borderStyle={'rounded'}
          flexDirection="column"
          padding={1}
        >
          <Box marginBottom={1}>
            <Text bold color={colors.warning}>
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
            focused={true}
            onCancel={() => handleSelect('no')}
            onSelect={handleSelect}
            options={options}
          />
        </Box>
      </Box>
    );
  }

  // ── LangGraph interrupt-driven question (type your answer) ─────────
  if (humanInputRequest && humanInputRequest.type === 'question') {
    const handleQuestionSubmit = async (answer: string) => {
      const request = humanInputRequest;
      const trimmed = answer.trim();
      if (!trimmed) return;

      setQuestionInput('');
      addUserMessage(trimmed);
      setHumanInputRequest(null);
      startStreaming();
      const stream = createThrottledStream();

      try {
        const finalAnswer = await agentSessionRef.current?.resumeWithHumanInput(
          trimmed,
          stream.onChunk,
          stream.onEvent,
        );
        stream.finish();
        finishStreaming(finalAnswer);
      } catch (error) {
        stream.finish();
        debugLog(`[ConfirmDialog] Question resume failed: ${error}`);
        setHumanInputRequest(request);
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
        width="100%"
      >
        <Box
          borderColor={colors.info} borderStyle={'rounded'}
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
              <Text color={colors.muted} italic>
                {humanInputRequest.context}
              </Text>
            </Box>
          )}
          <Text color={colors.muted} italic>
            Type your answer below and press Enter.
          </Text>
          <Box marginTop={1}>
            <Text bold color={colors.brand}>❯ </Text>
            <Input
              onChange={(v: string) => setQuestionInput(v)}
              onSubmit={handleQuestionSubmit}
              placeholder="Type your answer..."
              value={questionInput}
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
          height="100%"
          justifyContent="center"
          width="100%"
        >
          <Box
            borderColor={colors.warning} borderStyle={'rounded'}
            flexDirection="column"
            padding={1}
          >
            <Box marginBottom={1}>
              <Text bold color={colors.warning}>
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

  if (confirmation.kind === 'text') {
    const handleSubmit = (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      const onSubmit = confirmation.onSelect;
      closeConfirmation();
      onSubmit?.(trimmed);
    };

    return (
      <Box alignItems="center" flexDirection="column" height="100%" justifyContent="center" width="100%">
        <Box borderColor={colors.info} borderStyle={'rounded'} flexDirection="column" padding={1}>
          <Text bold color={colors.info}>{confirmation.title}</Text>
          <Box marginTop={1}><Text>{confirmation.message}</Text></Box>
          <Box marginTop={1}>
            <Text bold color={colors.brand}>❯ </Text>
            <Input
              onChange={(value: string) => setQuestionInput(value)}
              onSubmit={handleSubmit}
              placeholder={confirmation.placeholder ?? 'Type your answer...'}
              value={questionInput}
            />
          </Box>
        </Box>
      </Box>
    );
  }

  const options = confirmation.options ?? [
    { label: 'Yes, approve', value: 'yes' },
    { label: 'No, deny', value: 'no' },
  ];

  const handleSelect = (value: string) => {
    const onSelect = confirmation.onSelect;
    const onConfirm = confirmation.onConfirm;
    closeConfirmation();
    if (onSelect) onSelect(value);
    else onConfirm(value === 'yes');
  };

  return (
    <Box
      alignItems="center"
      flexDirection="column"
      height="100%"
      justifyContent="center"
      width="100%"
    >
      <Box
        borderColor={colors.warning} borderStyle={'rounded'}
        flexDirection="column"
        padding={1}
      >
        <Box marginBottom={1}>
          <Text bold color={colors.warning}>
            {confirmation.title}
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text>{confirmation.message}</Text>
        </Box>
        {confirmation.details && confirmation.kind !== 'patch' && (
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
        {confirmation.details && confirmation.kind === 'patch' && (
          <Box borderColor={colors.dim} borderStyle={'single'} flexDirection="column" marginBottom={1} padding={1}>
            {confirmation.details.split('\n').slice(0, 80).map((line, index) => (
              <Text
                color={line.startsWith('+') && !line.startsWith('+++')
                  ? colors.success
                  : line.startsWith('-') && !line.startsWith('---')
                    ? colors.error
                    : line.startsWith('@@')
                      ? colors.info
                      : colors.muted}
                key={`${index}-${line}`}
              >
                {line || ' '}
              </Text>
            ))}
            {confirmation.details.split('\n').length > 80 && (
              <Text color={colors.muted}>… diff truncated in terminal preview</Text>
            )}
          </Box>
        )}
        <OptionList
          focused={true}
          onCancel={() => handleSelect('no')}
          onSelect={handleSelect}
          options={options}
        />
      </Box>
    </Box>
  );
};
