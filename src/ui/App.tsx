import * as path from 'node:path';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import type { ShadowConfig } from '../utils/config.js';

import { AgentSession } from '../core/agent.js';
import { enforceLicenseGate } from '../core/policy/license-guard.js';
import { buildDiffScopeHint, getChangedFiles } from '../core/tools/git-diff.js';
import { AgentSessionProvider } from './AgentSessionContext.js';
import { ConfirmDialog } from './ConfirmDialog.js';
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
  const setLicenseGate = useAppStore((state) => state.setLicenseGate);
  const addErrorMessage = useAppStore((state) => state.addErrorMessage);
  const setSessionTarget = useAppStore((state) => state.setSessionTarget);
  const { agentSessionRef, initSession } = useAgentSession();

  useEffect(() => {
    if (initialConfig) {
      setConfig(initialConfig);
    }
  }, [initialConfig, setConfig]);

  // Track if we should show setup after boot completes
  const [pendingSetup, setPendingSetup] = useState(needsSetup);

  // Handle boot sequence completion - transition to setup or target selection
  const handleBootComplete = useCallback(() => {
    setPendingSetup(false);
    if (needsSetup) {
      setScreen('setup');
    } else {
      setScreen('target');
    }
  }, [needsSetup, setScreen]);

  // Initialize session once target is selected
  useEffect(() => {
    if (screen !== 'initializing' || !sessionTarget || !initialConfig) return;

    let cancelled = false;

    const init = async () => {
      try {
        const effectiveConfig: ShadowConfig = {
          ...initialConfig,
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
        });

        if (cancelled) return;

        setScreen('shell');
      } catch (error) {
        if (cancelled) return;
        const message = (error as Error).message;
        setSessionError(message);
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
    initialConfig,
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

  // Screen rendering
  switch (screen) {
    case 'boot': {
      return <BootScreen onBootComplete={handleBootComplete} />;
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
      return (
        <AgentSessionProvider agentSessionRef={agentSessionRef}>
          <ShellScreen />
          <ConfirmDialog />
        </AgentSessionProvider>
      );
    }

    case 'target': {
      return <TargetSelectionScreen />;
    }

    default: {
      return <BootScreen />;
    }
  }
};

export default App;
