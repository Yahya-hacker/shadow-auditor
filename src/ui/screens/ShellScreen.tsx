import { Box, Text, Input } from "../../opentui/components.js";
/**
 * Shadow Auditor — Interactive Security Analysis Shell (OpenTUI).
 *
 * Full-screen responsive layout using OpenTUI's Yoga Flexbox engine.
 * Terminal resize is handled natively — no manual column/row calculations.
 *
 * Strict Focus Isolation: when an `<Input>` has text content, ALL keystrokes
 * go to the input. Vim shortcuts (j/k/g/G/) only activate when the input is
 * empty. This prevents typing "j" in the query box from scrolling the chat.
 */

import React, { memo, useCallback, useEffect, useRef } from 'react';

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
import { type FocusTarget, useAppStore } from '../store/appStore.js';

// ============================================================================
// Key handlers — use getState() at call time, zero stale closures
// ============================================================================

interface KeyEvent {
  key: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

function handleOutputFocus(evt: KeyEvent): void {
  const s = useAppStore.getState();
  switch (evt.key) {
    case 'ArrowUp': case 'k': s.setScrollOffset(s.scrollOffset + 1); break;
    case 'ArrowDown': case 'j': s.setScrollOffset(Math.max(0, s.scrollOffset - 1)); break;
    case 'Tab': s.setFocus('filters'); break;
    case 'Escape': case 'i': s.setFocus('input'); break;
    case '/': s.setSearchActive(true); break;
    case '?': s.toggleHelp(); break;
    case 'G': s.setScrollOffset(0); break;
    case 'g': s.setScrollOffset(Number.MAX_SAFE_INTEGER); break;
    case 'P': if (!evt.shift) s.togglePanel(); break;
  }
}

function handlePanelFocus(evt: KeyEvent): void {
  handleOutputFocus(evt); // Same bindings
}

function handleFiltersFocus(evt: KeyEvent): void {
  const s = useAppStore.getState();
  switch (evt.key) {
    case 'ArrowDown': case 'j': s.setScrollOffset(s.scrollOffset + 1); break; // Moves highlighted filter down
    case 'ArrowUp': case 'k': s.setScrollOffset(Math.max(0, s.scrollOffset - 1)); break; // Moves highlighted filter up
    case ' ': { // Space toggles the currently highlighted filter
      const keys = Object.keys(s.filters);
      const idx = Math.min(s.scrollOffset, keys.length - 1);
      const key = keys[idx];
      if (key) s.toggleFilter(key);
      break;
    }
    case 'Tab': case 'Escape': case 'i': s.setFocus('input'); break;
  }
}

function handleInputFocus(evt: KeyEvent): void {
  const s = useAppStore.getState();
  // CRITICAL: if input has text, ALL keystrokes go to the <Input>.
  // Only empty input allows navigation shortcuts.
  if (s.input.length > 0) return;

  switch (evt.key) {
    case 'ArrowUp': case 'k': s.setScrollOffset(s.scrollOffset + 1); break;
    case 'ArrowDown': case 'j': s.setScrollOffset(Math.max(0, s.scrollOffset - 1)); break;
    case 'Tab': s.setFocus('output'); break;
    case '/': s.setInput(''); s.setSearchActive(true); break;
    case '?': s.toggleHelp(); break;
    case 'G': s.setScrollOffset(0); break;
    case 'g': s.setScrollOffset(Number.MAX_SAFE_INTEGER); break;
    case 'P': if (!evt.shift) s.togglePanel(); break;
  }
}

function dispatchFocusKey(evt: KeyEvent): void {
  const state = useAppStore.getState();

  // Help overlay intercepts everything except close keys
  if (state.helpOpen) {
    if (evt.key === 'Escape' || evt.key === '?') state.toggleHelp();
    return;
  }

  // Search mode only intercepts Escape
  if (state.searchActive) {
    if (evt.key === 'Escape') state.setSearchActive(false);
    return;
  }

  // When a confirmation dialog is active, let ConfirmDialog handle all keys
  if (state.humanInputRequest || state.confirmation.open) {
    return;
  }

  // ── Focus-aware dispatch ──────────────────────────────────────────
  switch (state.focus) {
    case 'filters': handleFiltersFocus(evt); break;
    case 'output': handleOutputFocus(evt); break;
    case 'panel': handlePanelFocus(evt); break;
    default: handleInputFocus(evt); break;
  }
}

// ============================================================================
// Stream throttling — batch chunks at 100ms so React re-renders 10×/sec
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
// Submit handler — connects user input to agent session via throttled stream
// ============================================================================

function useHandleSubmit(): (command: string) => void {
  const agentSessionRef = useAgentSessionRef();

  return useCallback(async (command: string) => {
    const trimmed = command.trim();
    if (!trimmed) return;
    if ([':q', ':quit', 'exit', 'quit'].includes(trimmed.toLowerCase())) {
      process.exit(0);
      return;
    }

    const store = useAppStore.getState();
    store.setSessionPhase('ready');
    const currentRequest = store.humanInputRequest;

    if (currentRequest) {
      store.addUserMessage(trimmed);
      store.setInput('');
      store.startStreaming();
      const stream = createThrottledStream();
      try {
        let answer: boolean | string;
        if (currentRequest.type === 'confirmation') {
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
      await agentSessionRef.current?.sendMessage(trimmed, stream.onChunk, stream.onEvent);
      stream.finish();
      useAppStore.getState().finishStreaming();
    } catch (error) {
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

const CompactLayout = memo(() => (
  <Box flexDirection="row" flexGrow={1}>
    <Box flexDirection="column" flexGrow={1}>
      <OutputArea compact />
    </Box>
    <Box flexDirection="column" width="16">
      <MetadataPanel compact />
    </Box>
  </Box>
));
CompactLayout.displayName = 'CompactLayout';

const ExpandedLayout = memo<{ panelOpen: boolean }>(({ panelOpen }) => (
  <Box flexDirection="row" flexGrow={1}>
    <Box flexDirection="column" width="25%">
      <FiltersPanel />
      <MetadataPanel />
      {panelOpen && <SwarmPanel />}
    </Box>
    <Box flexDirection="column" flexGrow={1}>
      <OutputArea />
    </Box>
  </Box>
));
ExpandedLayout.displayName = 'ExpandedLayout';

// ============================================================================
// Main Shell Screen
// ============================================================================

export const ShellScreen: React.FC = () => {
  const panelOpen = useAppStore((s) => s.panelOpen);
  const helpOpen = useAppStore((s) => s.helpOpen);
  const isCompact = useAppStore((s) => s.isCompact);

  const handleSubmit = useHandleSubmit();

  // ── Terminal resize → compact mode ───────────────────────────────
  // OpenTUI Yoga handles layout automatically, but we still need to
  // toggle the compact sidebars when the terminal is narrow (< 80 cols).
  useEffect(() => {
    const updateCompact = () => {
      const cols = process.stdout.columns || 80;
      const compact = cols < 80; // COMPACT_THRESHOLD
      useAppStore.getState().setIsCompact(compact);
    };
    // Set initial value
    updateCompact();
    // Listen for resize events (emitted by TTY on SIGWINCH)
    process.stdout.on('resize', updateCompact);
    return () => {
      process.stdout.off('resize', updateCompact);
    };
  }, []);

  // ── Global keyboard handler ────────────────────────────────────────
  // Captures key events on the root <Box>. The `tabIndex` makes it
  // focusable so keyDown events bubble here when no <Input> is focused.
  const handleKeyDown = useCallback((evt: React.KeyboardEvent) => {
    dispatchFocusKey({
      key: evt.key,
      shift: evt.shiftKey,
      ctrl: evt.ctrlKey,
      alt: evt.altKey,
    });
  }, []);

  return (
    <Box
      width="100%"
      height="100%"
      flexDirection="column"
      onKeyDown={handleKeyDown}
    >
      <Header />

      <Box flexDirection="row" flexGrow={1}>
        {helpOpen ? (
          <Box flexGrow={1}><HelpOverlay /></Box>
        ) : isCompact ? (
          <CompactLayout />
        ) : (
          <ExpandedLayout panelOpen={panelOpen} />
        )}
      </Box>

      <StatusLine />
      <InputArea onSubmit={handleSubmit} />
      <Footer />
    </Box>
  );
};
