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

import React from 'react';

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
      <box
        alignItems="center"
        flexDirection="column"
        width="100%"
        height="100%"
        justifyContent="center"
      >
        <box
          border={{ color: colors.warning, style: 'round' }}
          flexDirection="column"
          padding={1}
        >
          <box marginBottom={1}>
            <text style={{ color: colors.warning, fontWeight: 'bold' }}>
              {humanInputRequest.question}
            </text>
          </box>
          {humanInputRequest.context && (
            <box
              border={{ color: colors.dim, style: 'single' }}
              marginBottom={1}
              padding={1}
            >
              <text style={{ color: colors.muted, fontStyle: 'italic' }}>
                {humanInputRequest.context}
              </text>
            </box>
          )}
          <OptionList options={options} onSelect={handleSelect} focused={true} />
        </box>
      </box>
    );
  }

  // ── LangGraph interrupt-driven question (type your answer) ─────────
  if (humanInputRequest && humanInputRequest.type === 'question') {
    return (
      <box
        alignItems="center"
        flexDirection="column"
        width="100%"
        height="100%"
        justifyContent="center"
      >
        <box
          border={{ color: colors.info, style: 'round' }}
          flexDirection="column"
          padding={1}
        >
          <box marginBottom={1}>
            <text style={{ color: colors.info, fontWeight: 'bold' }}>
              {humanInputRequest.question}
            </text>
          </box>
          {humanInputRequest.context && (
            <box marginBottom={1}>
              <text style={{ color: colors.muted, fontStyle: 'italic' }}>
                {humanInputRequest.context}
              </text>
            </box>
          )}
          <text style={{ color: colors.muted, fontStyle: 'italic' }}>
            Type your answer below and press Enter.
          </text>
        </box>
      </box>
    );
  }

  // ── Legacy Zustand confirmation ────────────────────────────────────
  if (!confirmation.open) {
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
    <box
      alignItems="center"
      flexDirection="column"
      width="100%"
      height="100%"
      justifyContent="center"
    >
      <box
        border={{ color: 'yellow', style: 'round' }}
        flexDirection="column"
        padding={1}
      >
        <box marginBottom={1}>
          <text style={{ color: 'yellow', fontWeight: 'bold' }}>
            {confirmation.title}
          </text>
        </box>
        <box marginBottom={1}>
          <text>{confirmation.message}</text>
        </box>
        {confirmation.details && (
          <box
            border={{ color: 'gray', style: 'single' }}
            marginBottom={1}
            padding={1}
          >
            <text style={{ color: colors.muted, fontStyle: 'italic' }}>
              {confirmation.details}
            </text>
          </box>
        )}
        <OptionList options={options} onSelect={handleSelect} focused={true} />
      </box>
    </box>
  );
};
