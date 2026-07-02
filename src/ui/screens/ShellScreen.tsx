import { Box, useApp, useInput } from 'ink';
import React, { useState } from 'react';

import { useAgentSessionRef } from '../AgentSessionContext.js';
import { ActivityPanel } from '../components/ActivityPanel.js';
import { ChatArea } from '../components/ChatArea.js';
import { Header } from '../components/Header.js';
import { HelpOverlay } from '../components/HelpOverlay.js';
import { InputArea } from '../components/InputArea.js';
import { StatusLine } from '../components/StatusLine.js';
import { StreamingResponse } from '../components/StreamingResponse.js';
import { SwarmPanel } from '../components/SwarmPanel.js';
import { Layout, Panel } from '../layout/Layout.js';
import { type AppState, useAppStore } from '../store/appStore.js';

interface KeyLike {
  downArrow: boolean;
  escape: boolean;
  return: boolean;
  tab: boolean;
  upArrow: boolean;
}

interface KeyActions {
  setFocus: (focus: 'input' | 'panel') => void;
  setInput: (input: string) => void;
  setScrollOffset: (offset: number) => void;
  setSearchActive: (active: boolean) => void;
  toggleHelp: () => void;
  togglePanel: () => void;
}

/** Key handling while the swarm panel is focused (message TextInput unmounted). */
function handlePanelFocusKey(char: string, key: KeyLike, state: AppState, actions: KeyActions): void {
  if (key.upArrow) {
    actions.setScrollOffset(state.scrollOffset + 1);
    return;
  }

  if (key.downArrow) {
    actions.setScrollOffset(Math.max(0, state.scrollOffset - 1));
    return;
  }

  if (key.escape) {
    actions.setFocus('input');
    return;
  }

  if (key.tab || char === 'i') {
    actions.setFocus('input');
    return;
  }

  switch (char) {
    case '/': {
      actions.setSearchActive(true);
      break;
    }

    case '?': {
      actions.toggleHelp();
      break;
    }

    case 'G': {
      actions.setScrollOffset(0);
      break;
    }

    case 'g': {
      actions.setScrollOffset(Number.MAX_SAFE_INTEGER);
      break;
    }

    case 'j': {
      actions.setScrollOffset(Math.max(0, state.scrollOffset - 1));
      break;
    }

    case 'k': {
      actions.setScrollOffset(state.scrollOffset + 1);
      break;
    }

    case 'P': {
      actions.togglePanel();
      break;
    }
  }
}

/** Key handling while the input is focused (TextInput capturing typing). */
function handleInputFocusKey(char: string, key: KeyLike, state: AppState, actions: KeyActions): void {
  if (key.upArrow) {
    actions.setScrollOffset(state.scrollOffset + 1);
    return;
  }

  if (key.downArrow) {
    actions.setScrollOffset(Math.max(0, state.scrollOffset - 1));
    return;
  }

  if (key.tab && state.panelOpen) {
    actions.setFocus('panel');
    return;
  }

  // Command keys only fire on an empty input to avoid clashing with typing.
  if (state.input.length > 0) return;

  switch (char) {
    case '/': {
      actions.setInput('');
      actions.setSearchActive(true);
      break;
    }

    case '?': {
      actions.toggleHelp();
      break;
    }

    case 'G': {
      actions.setScrollOffset(0);
      break;
    }

    case 'g': {
      actions.setScrollOffset(Number.MAX_SAFE_INTEGER);
      break;
    }

    case 'P': {
      actions.togglePanel();
      break;
    }
  }
}

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
  const panelOpen = useAppStore((state) => state.panelOpen);
  const helpOpen = useAppStore((state) => state.helpOpen);
  const [isProcessing, setIsProcessing] = useState(false);
  const { exit } = useApp();

  const handleSubmit = useHandleSubmit(setIsProcessing, exit);

  // Stable action references; state values are read fresh via getState() to
  // avoid stale closures inside the global key handler.
  const actions: KeyActions = {
    setFocus: useAppStore((state) => state.setFocus),
    setInput: useAppStore((state) => state.setInput),
    setScrollOffset: useAppStore((state) => state.setScrollOffset),
    setSearchActive: useAppStore((state) => state.setSearchActive),
    toggleHelp: useAppStore((state) => state.toggleHelp),
    togglePanel: useAppStore((state) => state.togglePanel),
  };

  useInput((char, key) => {
    const state = useAppStore.getState();
    const keyArg: KeyLike = {
      downArrow: key.downArrow,
      escape: key.escape,
      return: key.return,
      tab: key.tab,
      upArrow: key.upArrow,
    };

    // Help overlay is a focus trap: only `?` / Esc close it.
    if (state.helpOpen) {
      if (keyArg.escape || char === '?') actions.toggleHelp();
      return;
    }

    // Search mode: Esc clears; the search TextInput handles typing.
    if (state.searchActive) {
      if (keyArg.escape) actions.setSearchActive(false);
      return;
    }

    if (state.focus === 'panel') {
      handlePanelFocusKey(char, keyArg, state, actions);
    } else {
      handleInputFocusKey(char, keyArg, state, actions);
    }
  });

  return (
    <Layout rightPanel={panelOpen}>
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
          <Box flexDirection="row" height={rect.body.height}>
            <Panel rect={rect.body}>
              <Box flexDirection="column" height={rect.body.height}>
                {helpOpen ? (
                  <HelpOverlay />
                ) : (
                  <>
                    <ChatArea height={rect.body.height} />
                    {isStreaming && <StreamingResponse text={streamingText} />}
                    {activity.length > 0 && <ActivityPanel />}
                  </>
                )}
              </Box>
            </Panel>
            {rect.swarm.width > 0 && (
              <Panel rect={rect.swarm}>
                <SwarmPanel />
              </Panel>
            )}
          </Box>
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
