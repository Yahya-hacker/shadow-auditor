import * as path from 'node:path';
/**
 * Shadow Auditor — OpenTUI Application Root.
 *
 * Replaces the Ink render tree with OpenTUI's Yoga-based renderer.
 * Screen routing and Zustand store integration remain identical —
 * only the rendering layer has changed.
 */
import React, { useCallback, useEffect, useState } from 'react';

import type { ShadowConfig } from '../utils/config.js';

import { enforceLicenseGate } from '../core/policy/license-guard.js';
import { buildDiffScopeHint, getChangedFiles } from '../core/tools/git-diff.js';
import {
  assertAuditTargetIdentity,
  isAuditTargetChangedError,
} from '../utils/audit-target.js';
import { AgentSessionProvider } from './AgentSessionContext.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { buildEffectiveConfig } from './effective-config.js';
import { useAgentSession } from './hooks/useAgentSession.js';
import { useIncrementalWatch } from './hooks/useIncrementalWatch.js';
import { Box, useKeyHandler } from "./primitives.js";
import { resumeRestoredSession } from './resume-session.js';
import { BootScreen } from './screens/BootScreen.js';
import { HistoryScreen } from './screens/HistoryScreen.js';
import { InitializingScreen } from './screens/InitializingScreen.js';
import { LicensePaywallScreen } from './screens/LicensePaywallScreen.js';
import { SetupScreen } from './screens/SetupScreen.js';
import { ShellScreen } from './screens/ShellScreen.js';
import { TargetSelectionScreen } from './screens/TargetSelectionScreen.js';
import { requestShutdown } from './shutdown.js';
import { useAppStore } from './store/appStore.js';

export interface AppProps {
  ciEnabled?: boolean;
  config: null | ShadowConfig;
  diffEnabled?: boolean;
  expertUnsafe: boolean;
  failOn?: string;
  initialTarget?: string;
  mode?: string;
  needsSetup?: boolean;
  resumeRunId?: string;
  since?: string;
  swarmEnabled?: boolean;
  watchEnabled?: boolean;
}

export const App: React.FC<AppProps> = ({
  ciEnabled,
  config: initialConfig,
  diffEnabled,
  expertUnsafe,
  failOn,
  initialTarget,
  mode,
  needsSetup,
  resumeRunId,
  since,
  swarmEnabled,
  watchEnabled,
}) => {
  const setConfig = useAppStore((state) => state.setConfig);
  const screen = useAppStore((state) => state.screen);
  const setScreen = useAppStore((state) => state.setScreen);
  const sessionTarget = useAppStore((state) => state.session.targetPath);
  const targetIdentity = useAppStore((state) => state.session.targetIdentity);
  const setSessionError = useAppStore((state) => state.setSessionError);
  const setSessionPhase = useAppStore((state) => state.setSessionPhase);
  const setLicenseGate = useAppStore((state) => state.setLicenseGate);
  const addErrorMessage = useAppStore((state) => state.addErrorMessage);
  const setFocusScope = useAppStore((state) => state.setFocusScope);
  const setTargetPath = useAppStore((state) => state.setSessionTarget);
  const setHumanInputRequest = useAppStore((state) => state.setHumanInputRequest);
  const userName = useAppStore((state) => state.userName);
  // Dialog state subscriptions — required so App re-renders when
  // a confirmation or human-input request becomes active.
  const confirmationOpen = useAppStore((s) => s.confirmation.open);
  const humanInputRequest = useAppStore((s) => s.humanInputRequest);
  useKeyHandler((event) => {
    if (event.ctrlKey && event.key.toLowerCase() === 'c') {
      requestShutdown(130).catch(() => {
        process.exitCode = 130;
      });
    }
  }, screen !== 'shell' || Boolean(confirmationOpen) || Boolean(humanInputRequest));
  const { agentSessionRef, initSession } = useAgentSession();
  useIncrementalWatch(Boolean(watchEnabled && screen === 'shell'), sessionTarget, agentSessionRef);

  useEffect(() => {
    if (initialConfig) {
      setConfig(initialConfig);
    }
  }, [initialConfig, setConfig]);

  const [_pendingSetup, setPendingSetup] = useState(needsSetup);

  // Track terminal height so the root can be clamped to the viewport. Without a
  // concrete height the flex chain has no bound, the frame grows taller than the
  // terminal, and Ink leaves un-erased "ghost" copies of prior frames on screen.
  const [terminalRows, setTerminalRows] = useState(process.stdout.rows || 24);
  useEffect(() => {
    const onResize = () => setTerminalRows(process.stdout.rows || 24);
    if (process.stdout.isTTY) process.stdout.on('resize', onResize);
    return () => {
      if (process.stdout.isTTY) process.stdout.off('resize', onResize);
    };
  }, []);

  const handleBootComplete = useCallback(() => {
    setPendingSetup(false);
    if (needsSetup) {
      setScreen('setup');
    } else if (initialTarget) {
      setTargetPath(path.resolve(initialTarget));
      setScreen('target');
    } else {
      setScreen('target');
    }
  }, [initialTarget, needsSetup, setScreen, setTargetPath]);

  useEffect(() => {
    const storedConfig = useAppStore.getState().config;
    if (screen !== 'initializing' || !sessionTarget || !targetIdentity || !storedConfig) return;

    let cancelled = false;

    const init = async () => {
      try {
        assertAuditTargetIdentity(targetIdentity);
        const effectiveConfig = buildEffectiveConfig(storedConfig, {
          ciEnabled,
          diffBase: since,
          diffEnabled,
          failOn,
          mode,
          swarmEnabled,
        });

        const gateResult = await enforceLicenseGate(effectiveConfig);
        if (!gateResult.allowed) {
          if (cancelled) return;
          setLicenseGate(gateResult);
          setScreen('license-blocked');
          return;
        }

        let diffScopeHint: string | undefined;
        if (diffEnabled) {
          const changedFiles = await getChangedFiles({
            baseRef: since ?? 'HEAD~1',
            cwd: sessionTarget,
          });
          diffScopeHint = buildDiffScopeHint(changedFiles) || undefined;
        }

        await initSession(effectiveConfig, targetIdentity, {
          diffScopeHint,
          expertUnsafe,
          resumeRunId,
          userName: userName || undefined,
        });
        const restoredHumanInput = resumeRunId
          ? await agentSessionRef.current?.getPendingHumanInput() ?? null
          : null;
        if (resumeRunId && !restoredHumanInput && agentSessionRef.current) {
          await resumeRestoredSession(agentSessionRef.current);
        }

        if (cancelled) return;

        setHumanInputRequest(restoredHumanInput);
        setSessionPhase('ready');
        setFocusScope(path.basename(sessionTarget) || sessionTarget);
        setScreen('shell');
      } catch (error) {
        if (cancelled) return;
        const message = (error as Error).message;
        setSessionError(message);
        setSessionPhase('error');
        addErrorMessage(`Failed to initialize: ${message}`);
        if (isAuditTargetChangedError(error)) {
          setTargetPath(sessionTarget);
          setScreen('target');
          return;
        }

        setScreen('shell');
      }
    };

    init();

    return () => {
      cancelled = true;
    };
  }, [
    screen,
    sessionTarget,
    targetIdentity,
    mode,
    ciEnabled,
    diffEnabled,
    expertUnsafe,
    failOn,
    resumeRunId,
    since,
    swarmEnabled,
    agentSessionRef,
    initSession,
    addErrorMessage,
    setSessionError,
    setLicenseGate,
    setHumanInputRequest,
    setScreen,
  ]);

  // ── Screen routing ────────────────────────────────────────────────────

  const renderScreen = () => {
    switch (screen) {
      case 'boot': {
        return <BootScreen onBootComplete={handleBootComplete} />;
      }

      case 'history': {
        return <HistoryScreen />;
      }

      case 'initializing': {
        return <InitializingScreen />;
      }

      case 'license-blocked': {
        return <LicensePaywallScreen />;
      }

      case 'setup': {
        return <SetupScreen />;
      }

      case 'shell': {
        // When a confirmation dialog or human-input request is active,
        // render ONLY the dialog (modal behavior). Uses subscribed
        // values so the component re-renders when dialog state changes.
        const hasDialog = confirmationOpen || humanInputRequest;
        if (hasDialog) {
          return (
            <AgentSessionProvider agentSessionRef={agentSessionRef}>
              <ConfirmDialog />
            </AgentSessionProvider>
          );
        }

        return (
          <AgentSessionProvider agentSessionRef={agentSessionRef}>
            <ErrorBoundary>
              <ShellScreen />
            </ErrorBoundary>
          </AgentSessionProvider>
        );
      }

      case 'target': {
        return <TargetSelectionScreen initialTarget={sessionTarget ?? undefined} />;
      }

      default: {
        return <BootScreen />;
      }
    }
  };

  // Root: clamp to the terminal height and clip overflow. A concrete height
  // gives the flex chain a definite bound (so OutputArea's viewport can size
  // itself) and keeps Ink from emitting frames taller than the screen.
  return (
    <Box flexDirection="column" height={terminalRows} overflow="hidden" width="100%">
      {renderScreen()}
    </Box>
  );
};

export default App;
