import React, { memo, useCallback, useEffect } from 'react';
/**
 * Shadow Auditor — Interactive Security Analysis Shell (OpenTUI).
 *
 * Full-screen responsive layout using OpenTUI's Yoga Flexbox engine.
 * Terminal resize is handled natively — no manual column/row calculations.
 *
 * Strict Focus Isolation: when an `<Input>` has text content, ALL keystrokes
 * go to the input. Navigation shortcuts only activate when the input is empty.
 */

import { useAgentSessionRef } from '../AgentSessionContext.js';
import { type CommandContext, executeSlashCommand } from '../commands.js';
import { FiltersPanel } from '../components/FiltersPanel.js';
import { Footer } from '../components/Footer.js';
import { Header } from '../components/Header.js';
import { HelpOverlay } from '../components/HelpOverlay.js';
import { InputArea } from '../components/InputArea.js';
import { MetadataPanel } from '../components/MetadataPanel.js';
import { OutputArea } from '../components/OutputArea.js';
import { StatusLine } from '../components/StatusLine.js';
import { SwarmPanel } from '../components/SwarmPanel.js';
import { ToastStack } from '../components/ToastStack.js';
import { useHandleSubmit } from '../hooks/useAgentSubmit.js';
import { Box, type KeyEvent as InputKeyEvent, useKeyHandler } from "../primitives.js";
import { requestShutdown } from '../shutdown.js';
import { useAppStore } from '../store/appStore.js';

// ============================================================================
// Key handlers — use getState() at call time, zero stale closures
// ============================================================================

interface KeyEvent {
  alt: boolean;
  ctrl: boolean;
  key: string;
  shift: boolean;
}

function handleOutputFocus(evt: KeyEvent): void {
  const s = useAppStore.getState();
  switch (evt.key) {
    case '/': { s.setSearchActive(true); break;
    }

    case '?': { s.toggleHelp(); break;
    }

    case 'ArrowDown': { s.scrollOutput(-1); break;
    }

    case 'ArrowUp': { s.scrollOutput(1); break;
    }

    case 'Escape': { s.setFocus('input'); break;
    }

    case 'H': { if (evt.shift) s.toggleCompactHeader(); break;
    }

 case 'h': { if (!evt.ctrl && !evt.alt) s.setScreen('history'); break;
    }

    case 'i': { s.setFocus('input'); break;
    }

    case 'j': { s.scrollOutput(-1); break;
    }

    case 'k': { s.scrollOutput(1); break;
    }

    case 'P': { if (!evt.shift) s.togglePanel(); break;
    }

    case 'Tab': { s.setFocus('filters'); break;
    }
  }
}

function handlePanelFocus(evt: KeyEvent): void {
  handleOutputFocus(evt); // Same bindings
}

function handleFiltersFocus(evt: KeyEvent): void {
  // FiltersPanel handles its own keyboard navigation (j/k/Space).
  // Only handle global keys here.
  const s = useAppStore.getState();
  switch (evt.key) {
    case 'H': { if (evt.shift) s.toggleCompactHeader(); break;
    }
  }
}

function handleInputFocus(evt: KeyEvent): void {
  // In input focus the text input owns all printable keys (Ink routes them to
  // the focused <Input>). Only Tab/Escape navigate away, so typed characters
  // are never swallowed as shortcuts.
  const s = useAppStore.getState();
  switch (evt.key) {
    case 'ArrowDown': { s.scrollOutput(-1); break;
    }

    case 'ArrowUp': { s.scrollOutput(1); break;
    }

    case 'Escape': { s.setFocus('output'); break;
    }

    case 'Tab': { s.setFocus('output'); break;
    }
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
    if (evt.key === 'Escape') {
      state.setSearchActive(false);
      state.setSearchQuery('');
    }
    return;
  }

  // When a confirmation dialog is active, let ConfirmDialog handle all keys
  if (state.humanInputRequest || state.confirmation.open) {
    return;
  }

  // Dismiss oldest toast with 'x' when toasts are visible
  if (evt.key === 'x' && state.toasts.length > 0 && state.focus !== 'input') {
    state.dismissToast(state.toasts[0]!.id);
    return;
  }

  // Global transcript scrolling — works in any focus (these keys are unused elsewhere).
  switch (evt.key) {
    case 'End': { state.setOutputScroll(0); return;
    }

    case 'Home': { state.scrollOutput(Number.MAX_SAFE_INTEGER); return;
    }

    case 'PageDown': { state.scrollOutput(-10); return;
    }

    case 'PageUp': { state.scrollOutput(10); return;
    }
  }

  // Ctrl+R — expand/collapse the most recent reasoning block from any focus.
  if (evt.ctrl && evt.key.toLowerCase() === 'r') {
    state.expandLatestReasoning();
    return;
  }

  // ── Focus-aware dispatch ──────────────────────────────────────────
  switch (state.focus) {
    case 'filters': { handleFiltersFocus(evt); break;
    }

    case 'output': { handleOutputFocus(evt); break;
    }

    case 'panel': { handlePanelFocus(evt); break;
    }

    default: { handleInputFocus(evt); break;
    }
  }
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
  const agentSessionRef = useAgentSessionRef();

  // ── Terminal resize → compact mode ───────────────────────────────
  useEffect(() => {
    const updateCompact = () => {
      const cols = process.stdout.columns;
      const compact = typeof cols === 'number' && cols > 0 ? cols < 80 : false;
      useAppStore.getState().setIsCompact(compact);
    };

    updateCompact();
    if (process.stdout.isTTY) {
      process.stdout.on('resize', updateCompact);
    }

    return () => {
      if (process.stdout.isTTY) {
        process.stdout.off('resize', updateCompact);
      }
    };
  }, []);

  // ── Submit handler with slash command routing ─────────────────────
  const onSubmit = useCallback(async (command: string) => {
    const trimmed = command.trim();
    if (trimmed.startsWith('/')) {
      const ctx: CommandContext = {
        cancelActiveOperation() {
          return agentSessionRef.current?.cancelActiveOperation() ?? false;
        },
        async compactContext() {
          if (!agentSessionRef.current) throw new Error('Agent session is not ready.');
          return agentSessionRef.current.compactContext();
        },
        async generateReport() {
          return agentSessionRef.current?.generateReport() ?? null;
        },
        async listSuppressions() {
          if (!agentSessionRef.current) throw new Error('Agent session is not ready.');
          return agentSessionRef.current.listSuppressions();
        },
        notify(message, type = 'info') {
          useAppStore.getState().addToast({ message, type });
        },
        async revokeSuppression(suppressionId, rationale) {
          if (!agentSessionRef.current) throw new Error('Agent session is not ready.');
          return agentSessionRef.current.revokeSuppression(suppressionId, rationale);
        },
        async setReasoningEffort(effort) {
          if (!agentSessionRef.current) throw new Error('Agent session is not ready.');
          return agentSessionRef.current.setReasoningEffort(effort);
        },
        async suppressFinding(findingId, rationale, expiresAt) {
          if (!agentSessionRef.current) throw new Error('Agent session is not ready.');
          return agentSessionRef.current.suppressFinding(findingId, rationale, expiresAt);
        },
      };
      try {
        const executed = await executeSlashCommand(trimmed, ctx);
        if (executed) {
          useAppStore.getState().setInput('');
          return;
        }
      } catch (error) {
        ctx.notify(
          `Command failed: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
        return;
      }
    }

    handleSubmit(command);
  }, [agentSessionRef, handleSubmit]);

  // ── Global keyboard handler ────────────────────────────────────────
  const handleKeyDown = useCallback((evt: InputKeyEvent) => {
    if (evt.ctrlKey && evt.key.toLowerCase() === 'c') {
      if (agentSessionRef.current?.cancelActiveOperation()) {
        useAppStore.getState().addToast({
          message: 'Cancelling the active operation...',
          type: 'warning',
        });
      } else {
        requestShutdown(130).catch(() => {
          process.exitCode = 130;
        });
      }

      return;
    }

    dispatchFocusKey({
      alt: evt.altKey,
      ctrl: evt.ctrlKey,
      key: evt.key,
      shift: evt.shiftKey,
    });
  }, [agentSessionRef]);

  useKeyHandler(handleKeyDown);

  return (
    <Box
      flexDirection="column"
      height="100%"
      width="100%"
    >
      <Header />
      <ToastStack />

      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        {helpOpen ? (
          <Box flexGrow={1}><HelpOverlay /></Box>
        ) : isCompact ? (
          <CompactLayout />
        ) : (
          <ExpandedLayout panelOpen={panelOpen} />
        )}
      </Box>

      <StatusLine />
      <InputArea onSubmit={onSubmit} />
      <Footer />
    </Box>
  );
};
