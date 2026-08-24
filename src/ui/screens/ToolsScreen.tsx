import React, { useCallback, useEffect, useMemo, useState } from 'react';

import type { ShadowConfig } from '../../utils/config.js';

import { useAgentSessionRef } from '../AgentSessionContext.js';
import { ToastStack } from '../components/ToastStack.js';
import { Box, Text, useKeyHandler } from '../primitives.js';
import { useAppStore } from '../store/appStore.js';
import { colors } from '../theme/chalkTheme.js';

type Snapshot = Awaited<ReturnType<
  NonNullable<ReturnType<typeof useAgentSessionRef>['current']>['getToolPolicySnapshot']
>>;

type AgentToolPolicy = NonNullable<
  NonNullable<ShadowConfig['toolPolicy']>['agents']
>[string];

export function toggleAgentToolPolicy(
  policy: AgentToolPolicy | undefined,
  toolName: string,
  enable: boolean,
  effectiveTools: readonly string[] = [],
): AgentToolPolicy {
  const enabledTools = new Set(policy?.enabledTools ?? effectiveTools);
  const disabledTools = new Set(policy?.disabledTools ?? []);
  if (enable) {
    enabledTools.add(toolName);
    disabledTools.delete(toolName);
  } else {
    enabledTools.delete(toolName);
    disabledTools.add(toolName);
  }

  return {
    ...policy,
    disabledTools: [...disabledTools].sort(),
    enabledTools: [...enabledTools].sort(),
  };
}

export const ToolsScreen: React.FC = () => {
  const agentSessionRef = useAgentSessionRef();
  const config = useAppStore((state) => state.config);
  const setConfig = useAppStore((state) => state.setConfig);
  const setScreen = useAppStore((state) => state.setScreen);
  const addToast = useAppStore((state) => state.addToast);
  const [snapshot, setSnapshot] = useState<null | Snapshot>(null);
  const [agentIndex, setAgentIndex] = useState(0);
  const [toolIndex, setToolIndex] = useState(0);
  const [draft, setDraft] = useState<ShadowConfig['toolPolicy']>(config?.toolPolicy);
  const [loadError, setLoadError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
      // Retry until the agent session becomes available. The ref identity is
      // stable across renders, so a mount-before-init session would otherwise
      // leave a permanent "unavailable" error with no retry.
      let disposed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const load = () => {
        const session = agentSessionRef.current;
        if (!session) {
          return false;
        }

        session.getToolPolicySnapshot()
          .then((s) => {
            if (!disposed) {
              setSnapshot(s);
              setLoadError(undefined);
            }
          })
          .catch((error: unknown) => {
            if (disposed) return;
            // A snapshot that fails after the session exists is a real error —
            // surface it, but only once; don't retry a failing session forever.
            setLoadError((error as Error).message);
          });
        return true;
      };

      if (!load()) {
        // No session yet: poll until it initializes.
        const poll = () => {
          if (disposed) return;
          if (load() && timer) clearInterval(timer);
        };

        timer = setInterval(poll, 1500);
      }

      return () => {
        disposed = true;
        if (timer) clearInterval(timer);
      };
    }, [agentSessionRef]);

  const agent = snapshot?.agents[agentIndex];
  const selectedTool = agent?.tools[toolIndex];
  const policy = agent ? draft?.agents?.[agent.id] : undefined;
  const enabledTools = useMemo(
    () => new Set(policy?.enabledTools ?? agent?.tools.filter((tool) => tool.enabled).map((tool) => tool.name) ?? []),
    [agent, policy?.enabledTools],
  );
  const maxToolSteps = policy?.maxToolSteps ?? agent?.maxToolSteps ?? 128;

  const updateAgentPolicy = useCallback((
    update: NonNullable<NonNullable<ShadowConfig['toolPolicy']>['agents']>[string],
  ) => {
    if (!agent) return;
    setDraft((current) => ({
      ...current,
      agents: {
        ...current?.agents,
        [agent.id]: {...current?.agents?.[agent.id], ...update},
      },
    }));
  }, [agent]);

  const save = useCallback(async () => {
    const session = agentSessionRef.current;
    if (!session || !config || saving) return;
    setSaving(true);
    try {
      await session.setToolPolicy(draft);
      setConfig({...config, toolPolicy: draft});
      addToast({message: 'Tool policy saved and applied to future agent turns.', type: 'success'});
      setScreen('shell');
    } catch (error) {
      addToast({message: (error as Error).message, type: 'error'});
    } finally {
      setSaving(false);
    }
  }, [addToast, agentSessionRef, config, draft, saving, setConfig, setScreen]);

  const toggleSelectedTool = useCallback(() => {
    if (!selectedTool) return;

    const enable = !enabledTools.has(selectedTool.name);
    if (enable && draft?.disabledTools?.includes(selectedTool.name)) {
      addToast({
        message: `${selectedTool.name} is disabled by the global tool policy.`,
        type: 'warning',
      });
      return;
    }

    updateAgentPolicy(toggleAgentToolPolicy(
      policy,
      selectedTool.name,
      enable,
      agent?.tools.filter((tool) => tool.enabled).map((tool) => tool.name),
    ));
  }, [
    addToast,
    agent?.tools,
    draft?.disabledTools,
    enabledTools,
    policy,
    selectedTool,
    updateAgentPolicy,
  ]);

  useKeyHandler((event) => {
    if (event.key === 'Escape') {
      setScreen('shell');
      return;
    }

    if (!snapshot || saving) return;
    switch (event.key) {
      case ' ': {
        toggleSelectedTool();
        break;
      }

      case '+':
      case '=': {
        updateAgentPolicy({maxToolSteps: Math.min(1024, maxToolSteps + 16)});
        break;
      }

      case '-':
      case '_': {
        updateAgentPolicy({maxToolSteps: Math.max(8, maxToolSteps - 16)});
        break;
      }

      case 'ArrowDown': {
        if (agent) {
          setToolIndex((index) => Math.min(agent.tools.length - 1, index + 1));
        }

        break;
      }

      case 'ArrowLeft': {
        setAgentIndex((index) => (index - 1 + snapshot.agents.length) % snapshot.agents.length);
        setToolIndex(0);
        break;
      }

      case 'ArrowRight': {
        setAgentIndex((index) => (index + 1) % snapshot.agents.length);
        setToolIndex(0);
        break;
      }

      case 'ArrowUp': {
        setToolIndex((index) => Math.max(0, index - 1));
        break;
      }

      default: {
        if (event.key.toLowerCase() === 's') save().catch(() => {});
      }
    }
  });

  if (!snapshot || !agent) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={loadError ? colors.error : colors.muted}>
          {loadError ?? 'Loading tool policy...'}
        </Text>
        <Text color={colors.muted}>Press Esc to return to the agent.</Text>
        <ToastStack />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color={colors.brand}>Agent tools and autonomy</Text>
      <Text color={colors.muted}>
        Left/Right agent · Up/Down tool · Space toggle · +/- budget · S save · Esc cancel
      </Text>
      <Text>
        Agent: <Text bold color={colors.info}>{agent.id}</Text>
        <Text color={colors.muted}> · budget </Text>
        <Text color={colors.pending}>{maxToolSteps} model/tool steps</Text>
      </Text>
      <Box borderColor={colors.border} borderStyle="single" flexDirection="column" marginTop={1} paddingX={1}>
        {agent.tools.map((tool, index) => (
          <Text
            bold={index === toolIndex}
            color={enabledTools.has(tool.name) ? colors.success : colors.muted}
            key={tool.name}
          >
            {index === toolIndex ? '› ' : '  '}
            {enabledTools.has(tool.name) ? '[on]  ' : '[off] '}
            {tool.name}
          </Text>
        ))}
      </Box>
      <Text color={colors.warning}>
        Host role allowlists, sandbox policy, approvals, and mandatory completion tools cannot be bypassed.
      </Text>
      <ToastStack />
    </Box>
  );
};
