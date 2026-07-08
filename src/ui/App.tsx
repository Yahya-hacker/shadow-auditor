import { Box, Text, Input } from "../opentui/components.js";
/**
 * Shadow Auditor — OpenTUI Application Root.
 *
 * Replaces the Ink render tree with OpenTUI's Yoga-based renderer.
 * Screen routing and Zustand store integration remain identical —
 * only the rendering layer has changed.
 */

import * as path from 'node:path';
import React, { useCallback, useEffect, useState } from 'react';

import type { ShadowConfig } from '../utils/config.js';

import { enforceLicenseGate } from '../core/policy/license-guard.js';
import { buildDiffScopeHint, getChangedFiles } from '../core/tools/git-diff.js';
import { AgentSessionProvider } from './AgentSessionContext.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { useAgentSession } from './hooks/useAgentSession.js';
import { BootScreen } from './screens/BootScreen.js';
import { InitializingScreen } from './screens/InitializingScreen.js';
import { LicensePaywallScreen } from './screens/LicensePaywallScreen.js';
import { SetupScreen } from './screens/SetupScreen.js';
import { ShellScreen } from './screens/ShellScreen.js';
import { TargetSelectionScreen } from './screens/TargetSelectionScreen.js';
import { useAppStore } from './store/appStore.js';

export interface AppProps {
  ciEnabled?: boolean;
  config: null | ShadowConfig;
  diffEnabled?: boolean;
  expertUnsafe: boolean;
  failOn?: string;
  mode?: string;
  needsSetup?: boolean;
  since?: string;
}

export const App: React.FC<AppProps> = ({
  ciEnabled,
  config: initialConfig,
  diffEnabled,
  expertUnsafe,
  failOn,
  mode,
  needsSetup,
  since,
}) => {
  const setConfig = useAppStore((state) => state.setConfig);
  const screen = useAppStore((state) => state.screen);
  const setScreen = useAppStore((state) => state.setScreen);
  const sessionTarget = useAppStore((state) => state.session.targetPath);
  const setSessionError = useAppStore((state) => state.setSessionError);
  const setSessionPhase = useAppStore((state) => state.setSessionPhase);
  const setLicenseGate = useAppStore((state) => state.setLicenseGate);
  const addErrorMessage = useAppStore((state) => state.addErrorMessage);
  const setFocusScope = useAppStore((state) => state.setFocusScope);
  const userName = useAppStore((state) => state.userName);
  // Dialog state subscriptions — required so App re-renders when
  // a confirmation or human-input request becomes active.
  const confirmationOpen = useAppStore((s) => s.confirmation.open);
  const humanInputRequest = useAppStore((s) => s.humanInputRequest);
  const { agentSessionRef, initSession } = useAgentSession();

  useEffect(() => {
    if (initialConfig) {
      setConfig(initialConfig);
    }
  }, [initialConfig, setConfig]);

  const [pendingSetup, setPendingSetup] = useState(needsSetup);

  const handleBootComplete = useCallback(() => {
    setPendingSetup(false);
    if (needsSetup) {
      setScreen('setup');
    } else {
      setScreen('target');
    }
  }, [needsSetup, setScreen]);

  useEffect(() => {
    const storedConfig = useAppStore.getState().config;
    if (screen !== 'initializing' || !sessionTarget || !storedConfig) return;

    let cancelled = false;

    const init = async () => {
      try {
        const effectiveConfig: ShadowConfig = {
          ...storedConfig,
          ...(mode ? { auditMode: mode as ShadowConfig['auditMode'] } : {}),
          ...(ciEnabled ? { ci: { enabled: true, failOn: (failOn ?? 'high') as 'critical' | 'high' | 'low' | 'medium' | 'none' } } : {}),
          ...(diffEnabled ? { diff: { baseRef: since ?? 'HEAD~1', enabled: true } } : {}),
        };

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

        await initSession(effectiveConfig, sessionTarget, {
          diffScopeHint,
          expertUnsafe,
          userName: userName || undefined,
        });

        if (cancelled) return;

        setSessionPhase('ready');
        setFocusScope(path.basename(sessionTarget) || sessionTarget);
        setScreen('shell');
      } catch (error) {
        if (cancelled) return;
        const message = (error as Error).message;
        setSessionError(message);
        setSessionPhase('error');
        addErrorMessage(`Failed to initialize: ${message}`);
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
    mode,
    ciEnabled,
    diffEnabled,
    expertUnsafe,
    failOn,
    since,
    initSession,
    addErrorMessage,
    setSessionError,
    setLicenseGate,
    setScreen,
  ]);

  // ── Screen routing ────────────────────────────────────────────────────

  const renderScreen = () => {
    switch (screen) {
      case 'boot':
        return <BootScreen onBootComplete={handleBootComplete} />;
      case 'initializing':
        return <InitializingScreen />;
      case 'license-blocked':
        return <LicensePaywallScreen />;
      case 'setup':
        return <SetupScreen />;
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
      case 'target':
        return <TargetSelectionScreen />;
      default:
        return <BootScreen />;
    }
  };

  // OpenTUI root: full-screen flex container. Every screen receives
  // 100% width/height so Yoga can distribute space correctly.
  return (
    <Box width="100%" height="100%" flexDirection="column">
      {renderScreen()}
    </Box>
  );
};

export default App;
