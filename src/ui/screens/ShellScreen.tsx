import { Box, useApp, useInput } from 'ink';
import React, { useCallback, useMemo, useRef, useState } from 'react';

import { useAgentSessionRef } from '../AgentSessionContext.js';
import { FiltersPanel } from '../components/FiltersPanel.js';
import { Header } from '../components/Header.js';
import { HelpOverlay } from '../components/HelpOverlay.js';
import { InputArea } from '../components/InputArea.js';
import { MetadataPanel } from '../components/MetadataPanel.js';
import { OutputArea } from '../components/OutputArea.js';
import { StatusLine } from '../components/StatusLine.js';
import { SwarmPanel } from '../components/SwarmPanel.js';
import { Layout, type LayoutResult } from '../layout/Layout.js';
import { type AppState, type FocusTarget, useAppStore } from '../store/appStore.js';

interface KeyLike {
  downArrow: boolean;
  escape: boolean;
  return: boolean;
  tab: boolean;
  upArrow: boolean;
}

interface KeyActions {
  setFocus: (focus: FocusTarget) => void;
  setInput: (input: string) => void;
  setScrollOffset: (offset: number) => void;
  setSearchActive: (active: boolean) => void;
  toggleHelp: () => void;
  togglePanel: () => void;
}

/** Key handling while the filters panel is focused. */
function handleFiltersFocusKey(
  char: string,
  key: KeyLike,
  _state: AppState,
  actions: KeyActions,
): void {
  if (key.tab || key.escape || char === 'i') {
    actions.setFocus('input');
    
  }

  // j/k navigate filter items, Space toggles — handled by local state in
  // FiltersPanel; global handler just needs focus routing.
}

/** Key handling while the output area is focused. */
function handleOutputFocusKey(
  char: string,
  key: KeyLike,
  state: AppState,
  actions: KeyActions,
): void {
  if (key.upArrow) {
    actions.setScrollOffset(state.scrollOffset + 1);
    return;
  }

  if (key.downArrow) {
    actions.setScrollOffset(Math.max(0, state.scrollOffset - 1));
    return;
  }

  if (key.tab) {
    actions.setFocus('filters');
    return;
  }

  if (key.escape || char === 'i') {
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

  if (key.escape || key.tab || char === 'i') {
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

  if (key.tab) {
    // Cycle focus: input → output → filters → panel (if open) → input
    actions.setFocus('output');
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

  // Use refs for stable callbacks — avoids re-creating the submit handler
  // on every keystroke, which would cause Ink to re-process the TextInput.
  const setIsProcessingRef = useRef(setIsProcessing);
  setIsProcessingRef.current = setIsProcessing;
  const exitRef = useRef(exit);
  exitRef.current = exit;

  return useCallback(async (command: string) => {
    const trimmed = command.trim();
    if (!trimmed) return;

    if ([':q', ':quit', 'exit', 'quit'].includes(trimmed.toLowerCase())) {
      exitRef.current();
      return;
    }

    // Read store actions via getState to avoid re-creating this callback
    const store = useAppStore.getState();

    // If the agent is paused awaiting human input (LangGraph interrupt),
    // resume the graph with the user's answer instead of sending a new message.
    const currentRequest = store.humanInputRequest;
    if (currentRequest) {
      setIsProcessingRef.current(true);
      store.startStreaming();
      try {
        let answer: boolean | string;
        if (currentRequest.type === 'confirmation') {
          const lower = trimmed.toLowerCase();
          answer = ['yes', 'y', 'approve', 'confirm', 'ok'].includes(lower);
        } else {
          answer = trimmed;
        }

        await agentSessionRef.current?.resumeWithHumanInput(
          answer,
          (chunk: string) => { useAppStore.getState().appendStreamChunk(chunk); },
          (event) => { useAppStore.getState().addActivityEvent(event); },
        );
        useAppStore.getState().setHumanInputRequest(null);
        useAppStore.getState().finishStreaming();
      } catch (error) {
        useAppStore.getState().addErrorMessage(`Error: ${(error as Error).message}`);
        useAppStore.getState().finishStreaming();
      } finally {
        setIsProcessingRef.current(false);
      }
      return;
    }

    store.addUserMessage(trimmed);
    store.setInput('');
    setIsProcessingRef.current(true);
    store.clearActivity();
    store.startStreaming();

    try {
      await agentSessionRef.current?.sendMessage(
        trimmed,
        (chunk: string) => { useAppStore.getState().appendStreamChunk(chunk); },
        (event) => { useAppStore.getState().addActivityEvent(event); },
      );
      useAppStore.getState().finishStreaming();
    } catch (error) {
      const errMsg = (error as Error).message;
      if (errMsg.includes('API key') || errMsg.includes('401') || errMsg.includes('authentication')) {
        useAppStore.getState().addErrorMessage('Authentication failed. Run again with --reconfigure.');
      } else {
        useAppStore.getState().addErrorMessage(`Error: ${errMsg}`);
      }
      useAppStore.getState().finishStreaming();
    } finally {
      setIsProcessingRef.current(false);
    }
  }, [agentSessionRef]); // Only re-create if the ref changes (it never does)
}

/** Compact layout: single column with output + slim metadata sidebar */
const CompactLayout: React.FC<{ layout: LayoutResult }> = ({ layout }) => (
  <Box flexDirection="row" height={layout.bodyHeight} width={layout.columns}>
    <Box flexDirection="column" flexGrow={1}>
      <OutputArea compact height={layout.bodyHeight} />
    </Box>
    <Box flexDirection="column" width={16}>
      <MetadataPanel compact />
    </Box>
  </Box>
);

/** Expanded layout: sidebar (filters + metadata + swarm) + main output */
const ExpandedLayout: React.FC<{ layout: LayoutResult; panelOpen: boolean }> = ({
  layout,
  panelOpen,
}) => (
  <Box flexDirection="row" height={layout.bodyHeight} width={layout.columns}>
    <Box flexDirection="column" width={layout.sidebarWidth}>
      <FiltersPanel />
      <MetadataPanel />
      {panelOpen && <SwarmPanel />}
    </Box>
    <Box flexDirection="column" flexGrow={1}>
      <OutputArea height={layout.bodyHeight} />
    </Box>
  </Box>
);

export const ShellScreen: React.FC = () => {
  const isStreaming = useAppStore((state) => state.streaming);
  const panelOpen = useAppStore((state) => state.panelOpen);
  const helpOpen = useAppStore((state) => state.helpOpen);
  const isCompact = useAppStore((state) => state.isCompact);
  const [isProcessing, setIsProcessing] = useState(false);
  const { exit } = useApp();

  const handleSubmit = useHandleSubmit(setIsProcessing, exit);

  // Use getState() for actions to avoid re-subscribing on every keystroke.
  // All store action references are stable (zustand guarantees this), so
  // reading them once via getState and memoizing prevents the useInput
  // callback from being recreated on every render.
  const actions: KeyActions = useMemo(() => {
    const s = useAppStore.getState();
    return {
      setFocus: s.setFocus,
      setInput: s.setInput,
      setScrollOffset: s.setScrollOffset,
      setSearchActive: s.setSearchActive,
      toggleHelp: s.toggleHelp,
      togglePanel: s.togglePanel,
    };
  }, []);

  useInput(useCallback((char, key) => {
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
      if (keyArg.escape || char === '?') useAppStore.getState().toggleHelp();
      return;
    }

    // Search mode: Esc clears; the search TextInput handles typing.
    if (state.searchActive) {
      if (keyArg.escape) useAppStore.getState().setSearchActive(false);
      return;
    }

    const a = actions;
    switch (state.focus) {
      case 'filters': {
        handleFiltersFocusKey(char, keyArg, state, a);
        break;
      }

      case 'output': {
        handleOutputFocusKey(char, keyArg, state, a);
        break;
      }

      case 'panel': {
        handlePanelFocusKey(char, keyArg, state, a);
        break;
      }

      case 'input':
      default: {
        handleInputFocusKey(char, keyArg, state, a);
        break;
      }
    }
  }, [actions]));

  // Wrap the Layout render-prop in useCallback so the function reference
  // is stable across renders. Without this, every ShellScreen re-render
  // creates a new children function, which forces Layout to re-invoke it
  // and recreate the entire terminal UI subtree. Dependencies are the
  // values actually used inside the function body.
  const renderLayout = useCallback(
    (layout: LayoutResult) => (
      <Box flexDirection="column" height={layout.rows} width={layout.columns}>
        {/* Row 1: Header (double border, 2-line content) */}
        <Header />

        {/* Row 2: Main Content (sidebar + output or compact) */}
        <Box flexDirection="row" flexGrow={1}>
          {helpOpen ? (
            <Box flexGrow={1}>
              <HelpOverlay />
            </Box>
          ) : isCompact ? (
            <CompactLayout layout={layout} />
          ) : (
            <ExpandedLayout layout={layout} panelOpen={panelOpen} />
          )}
        </Box>

        {/* Row 3: Status + Input */}
        <StatusLine />
        <InputArea isProcessing={isProcessing} onSubmit={handleSubmit} />
      </Box>
    ),
    [helpOpen, isCompact, panelOpen, isProcessing, handleSubmit],
  );

  return <Layout>{renderLayout}</Layout>;
};
