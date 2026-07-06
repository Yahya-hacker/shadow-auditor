import { Box, useApp, useInput } from 'ink';
import React, { memo, useCallback, useRef } from 'react';

import type { AgentStreamEvent } from '../../core/agent.js';

import { useAgentSessionRef } from '../AgentSessionContext.js';
import { FiltersPanel } from '../components/FiltersPanel.js';
import { Footer } from '../components/Footer.js';
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

// ============================================================================
// Key handlers — use getState() at call time, zero stale closures
// ============================================================================

function handleFiltersFocusKey(char: string, key: KeyLike): void {
  if (key.tab || key.escape || char === 'i') useAppStore.getState().setFocus('input');
}

function handleOutputFocusKey(char: string, key: KeyLike): void {
  const s = useAppStore.getState();
  if (key.upArrow) { s.setScrollOffset(s.scrollOffset + 1); return; }
  if (key.downArrow) { s.setScrollOffset(Math.max(0, s.scrollOffset - 1)); return; }
  if (key.tab) { s.setFocus('filters'); return; }
  if (key.escape || char === 'i') { s.setFocus('input'); return; }
  switch (char) {
    case '/': s.setSearchActive(true); break;
    case '?': s.toggleHelp(); break;
    case 'G': s.setScrollOffset(0); break;
    case 'g': s.setScrollOffset(Number.MAX_SAFE_INTEGER); break;
    case 'j': s.setScrollOffset(Math.max(0, s.scrollOffset - 1)); break;
    case 'k': s.setScrollOffset(s.scrollOffset + 1); break;
    case 'P': s.togglePanel(); break;
  }
}

function handlePanelFocusKey(char: string, key: KeyLike): void {
  const s = useAppStore.getState();
  if (key.upArrow) { s.setScrollOffset(s.scrollOffset + 1); return; }
  if (key.downArrow) { s.setScrollOffset(Math.max(0, s.scrollOffset - 1)); return; }
  if (key.escape || key.tab || char === 'i') { s.setFocus('input'); return; }
  switch (char) {
    case '/': s.setSearchActive(true); break;
    case '?': s.toggleHelp(); break;
    case 'G': s.setScrollOffset(0); break;
    case 'g': s.setScrollOffset(Number.MAX_SAFE_INTEGER); break;
    case 'j': s.setScrollOffset(Math.max(0, s.scrollOffset - 1)); break;
    case 'k': s.setScrollOffset(s.scrollOffset + 1); break;
    case 'P': s.togglePanel(); break;
  }
}

function handleInputFocusKey(char: string, key: KeyLike): void {
  const s = useAppStore.getState();
  // When the input has text, only Tab should escape the input focus.
  // Arrow keys and single-char shortcuts are left to TextInput.
  if (key.tab) { s.setFocus('output'); return; }
  if (s.input.length > 0) return;
  // Input is empty — allow navigation shortcuts
  if (key.upArrow) { s.setScrollOffset(s.scrollOffset + 1); return; }
  if (key.downArrow) { s.setScrollOffset(Math.max(0, s.scrollOffset - 1)); return; }
  switch (char) {
    case '/': s.setInput(''); s.setSearchActive(true); break;
    case '?': s.toggleHelp(); break;
    case 'G': s.setScrollOffset(0); break;
    case 'g': s.setScrollOffset(Number.MAX_SAFE_INTEGER); break;
    case 'P': s.togglePanel(); break;
  }
}

// ============================================================================
// Stream throttling — batch chunks at 100ms so React re-renders 10×/sec
// instead of 100×/sec, leaving the event loop free for keystroke processing.
// ============================================================================

function createThrottledStream(intervalMs = 100) {
  let chunkBuffer = '';
  let eventBuffer: AgentStreamEvent[] = [];
  let flushTimer: null | ReturnType<typeof setTimeout> = null;

  const flush = () => {
    flushTimer = null;
    const store = useAppStore.getState();
    if (chunkBuffer) {
      store.appendStreamChunk(chunkBuffer);
      chunkBuffer = '';
    }
    for (const evt of eventBuffer) store.addActivityEvent(evt);
    eventBuffer = [];
  };

  return {
    finish() {
      if (flushTimer) clearTimeout(flushTimer);
      flush();
    },
    onChunk(chunk: string) {
      chunkBuffer += chunk;
      if (!flushTimer) flushTimer = setTimeout(flush, intervalMs);
    },
    onEvent(event: AgentStreamEvent) {
      eventBuffer.push(event);
      if (!flushTimer) flushTimer = setTimeout(flush, intervalMs);
    },
  };
}

// ============================================================================
// Submit handler — connects user input to agent session using throttled stream
// ============================================================================

function useHandleSubmit(exit: () => void): (command: string) => void {
  const agentSessionRef = useAgentSessionRef();
  const exitRef = useRef(exit);
  exitRef.current = exit;

  return useCallback(async (command: string) => {
    const trimmed = command.trim();
    if (!trimmed) return;
    if ([':q', ':quit', 'exit', 'quit'].includes(trimmed.toLowerCase())) {
      exitRef.current();
      return;
    }

    const store = useAppStore.getState();
    store.setSessionPhase('ready'); // Agent is processing
    const currentRequest = store.humanInputRequest;

    if (currentRequest) {
      // Add the user's answer to the message history so it appears in the
      // chat log. This mirrors the normal path's addUserMessage below.
      // For confirmation-type interruptions, the ConfirmDialog also shows
      // a SelectInput; typed input is an alternative text-based path that
      // should produce the same visible result.
      store.addUserMessage(trimmed);
      store.setInput('');
      store.startStreaming();
      const stream = createThrottledStream();
      try {
        let answer: boolean | string;
        if (currentRequest.type === 'confirmation') {
          // Normalize confirmation answers: yes/y/approve/confirm/ok → true
          answer = ['approve', 'confirm', 'ok', 'y', 'yes'].includes(trimmed.toLowerCase());
        } else {
          answer = trimmed;
        }
        await agentSessionRef.current?.resumeWithHumanInput(answer, stream.onChunk, stream.onEvent);
        stream.finish();
        useAppStore.getState().setHumanInputRequest(null);
        useAppStore.getState().finishStreaming();
      } catch (error) {
        stream.finish();
        const msg = (error as Error).message;
        if (msg.includes('API key') || msg.includes('401') || msg.includes('authentication')) {
          useAppStore.getState().addErrorMessage('Authentication failed. Run again with --reconfigure.');
        } else {
          useAppStore.getState().addErrorMessage(`Error: ${msg}`);
        }
        useAppStore.getState().setHumanInputRequest(null);
        useAppStore.getState().finishStreaming();
      }
      return;
    }

    store.addUserMessage(trimmed);
    store.setInput('');
    store.clearActivity();
    store.startStreaming();

    const stream = createThrottledStream();
    try {
      const result = await agentSessionRef.current?.sendMessage(trimmed, stream.onChunk, stream.onEvent);
      process.stderr.write(`[Shell] sendMessage returned: "${result?.slice(0, 80)}"\n`);
      process.stderr.write(`[Shell] streamingText length before finish: ${useAppStore.getState().streamingText.length}\n`);
      process.stderr.write(`[Shell] messages count before finish: ${useAppStore.getState().messages.length}\n`);
      stream.finish();
      process.stderr.write(`[Shell] streamingText after flush: ${useAppStore.getState().streamingText.length}\n`);
      useAppStore.getState().finishStreaming();
      process.stderr.write(`[Shell] messages count after finishStreaming: ${useAppStore.getState().messages.length}\n`);
    } catch (error) {
      process.stderr.write(`[Shell] sendMessage ERROR: ${(error as Error).message}\n`);
      stream.finish();
      const msg = (error as Error).message;
      if (msg.includes('API key') || msg.includes('401') || msg.includes('authentication')) {
        useAppStore.getState().addErrorMessage('Authentication failed. Run again with --reconfigure.');
      } else {
        useAppStore.getState().addErrorMessage(`Error: ${msg}`);
      }
      useAppStore.getState().finishStreaming();
    }
  }, [agentSessionRef]);
}

// ============================================================================
// Layout sub-components — memoized
// ============================================================================

const CompactLayout = memo<{ layout: LayoutResult }>(({ layout }) => (
  <Box flexDirection="row" height={layout.bodyHeight} width={layout.columns}>
    <Box flexDirection="column" flexGrow={1}>
      <OutputArea compact />
    </Box>
    <Box flexDirection="column" width={16}>
      <MetadataPanel compact />
    </Box>
  </Box>
));
CompactLayout.displayName = 'CompactLayout';

const ExpandedLayout = memo<{ layout: LayoutResult; panelOpen: boolean }>(
  ({ layout, panelOpen }) => (
    <Box flexDirection="row" height={layout.bodyHeight} width={layout.columns}>
      <Box flexDirection="column" width={layout.sidebarWidth}>
        <FiltersPanel />
        <MetadataPanel />
        {panelOpen && <SwarmPanel />}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <OutputArea />
      </Box>
    </Box>
  ),
);
ExpandedLayout.displayName = 'ExpandedLayout';

// ============================================================================
// Main Shell Screen
// ============================================================================

export const ShellScreen: React.FC = () => {
  const panelOpen = useAppStore((s) => s.panelOpen);
  const helpOpen = useAppStore((s) => s.helpOpen);
  const isCompact = useAppStore((s) => s.isCompact);
  const { exit } = useApp();

  const handleSubmit = useHandleSubmit(exit);

  // Keyboard — getState() at call time, no stale closures
  useInput(useCallback((char: string, key: KeyLike) => {
    const state = useAppStore.getState();
    if (state.helpOpen) {
      if (key.escape || char === '?') state.toggleHelp();
      return;
    }
    if (state.searchActive) {
      if (key.escape) state.setSearchActive(false);
      return;
    }
    switch (state.focus) {
      case 'filters': handleFiltersFocusKey(char, key); break;
      case 'output': handleOutputFocusKey(char, key); break;
      case 'panel': handlePanelFocusKey(char, key); break;
      default: handleInputFocusKey(char, key); break;
    }
  }, []));

  // Layout children — memoized with useCallback so Layout only re-invokes
  // children when the deps that affect structure actually change (helpOpen,
  // isCompact, panelOpen, handleSubmit). Internal components (Header,
  // OutputArea, etc.) are independently memoized, so keystroke-driven
  // store changes (e.g. `input`) don't cascade into a full tree repaint.
  const renderLayout = useCallback((layout: LayoutResult) => (
    <Box flexDirection="column" height={layout.rows} width={layout.columns}>
      <Header />
      <Box flexDirection="row" flexGrow={1}>
        {helpOpen ? (
          <Box flexGrow={1}><HelpOverlay /></Box>
        ) : isCompact ? (
          <CompactLayout layout={layout} />
        ) : (
          <ExpandedLayout layout={layout} panelOpen={panelOpen} />
        )}
      </Box>
      <StatusLine />
      <InputArea onSubmit={handleSubmit} />
      <Footer />
    </Box>
  ), [helpOpen, isCompact, panelOpen, handleSubmit]);

  return <Layout>{renderLayout}</Layout>;
};
