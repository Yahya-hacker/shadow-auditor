import React, { memo } from 'react';
/**
 * SwarmPanel — live multi-agent swarm visualization.
 *
 * Shows agent status, task progress, claims, and consensus metrics.
 * Hidden in compact mode. All indicators include text labels for NO_COLOR
 * accessibility.
 */

import { Box, Text } from "../primitives.js";
import { useAppStore } from '../store/appStore.js';
import { colors, layout, spacing } from '../theme/chalkTheme.js';

const statusGlyph: Record<string, { color: string; glyph: string; textLabel: string }> = {
  blocked: { color: colors.warning, glyph: '◧', textLabel: 'blocked' },
  cancelled: { color: colors.dim, glyph: '⊘', textLabel: 'cancelled' },
  claimed: { color: colors.muted, glyph: '◔', textLabel: 'claimed' },
  completed: { color: colors.success, glyph: '✓', textLabel: 'completed' },
  failed: { color: colors.error, glyph: '✖', textLabel: 'failed' },
  in_progress: { color: colors.pending, glyph: '⧗', textLabel: 'in_progress' },
  pending: { color: colors.muted, glyph: '◌', textLabel: 'pending' },
};

const agentGlyph: Record<string, { color: string; glyph: string; textLabel: string }> = {
  active: { color: colors.success, glyph: '●', textLabel: 'active' },
  busy: { color: colors.pending, glyph: '●', textLabel: 'busy' },
  idle: { color: colors.muted, glyph: '○', textLabel: 'idle' },
  offline: { color: colors.dim, glyph: '◌', textLabel: 'offline' },
};

const lightFg = colors.panelLightFg;
const lightBg = colors.panelLightBg;
const panelInnerWidth = layout.MIN_SIDEBAR_WIDTH - 2;

export const SwarmPanel: React.FC = memo(() => {
  const swarmState = useAppStore((state) => state.swarmState);

  if (!swarmState) {
    return (
      <Box
        borderColor={colors.border} borderStyle={'single'}
        flexDirection="column"
        paddingX={spacing.panelPadX}
        paddingY={spacing.panelPadY}
      >
        <Text backgroundColor={lightBg} bold color={lightFg}>
          {'Swarm'.padEnd(panelInnerWidth)}
        </Text>
        <Text backgroundColor={lightBg} color={lightFg}>
          {'No active swarm run.'.padEnd(panelInnerWidth)}
        </Text>
        <Text backgroundColor={lightBg}>
          {' '.repeat(panelInnerWidth)}
        </Text>
      </Box>
    );
  }

  return (
    <Box
      borderColor={colors.border} borderStyle={'single'}
      flexDirection="column"
      paddingX={spacing.panelPadX}
      paddingY={spacing.panelPadY}
    >
      <Text backgroundColor={lightBg} bold color={lightFg}>
        {'Swarm'.padEnd(panelInnerWidth)}
      </Text>

      <Text backgroundColor={lightBg} bold color={lightFg}>
        {'Agents'.padEnd(panelInnerWidth)}
      </Text>
      {swarmState.agents.map((agent) => {
        const g = agentGlyph[agent.status] ?? { color: colors.muted, glyph: '•', textLabel: agent.status };
        // Always show status text alongside glyph for NO_COLOR accessibility
        const line = `${g.glyph} ${agent.role} ${g.textLabel}`;
        return (
          <Text backgroundColor={lightBg} color={g.color} key={agent.agentId}>
            {line.padEnd(panelInnerWidth)}
          </Text>
        );
      })}

      <Text backgroundColor={lightBg} bold color={lightFg}>
        {'Tasks'.padEnd(panelInnerWidth)}
      </Text>
      {swarmState.tasks.map((task) => {
        const g = statusGlyph[task.status] ?? { color: colors.muted, glyph: '•', textLabel: task.status };
        const line = `${g.glyph} ${task.taskType} ${g.textLabel}`;
        return (
          <Text backgroundColor={lightBg} color={g.color} key={task.taskId}>
            {line.padEnd(panelInnerWidth)}
          </Text>
        );
      })}

      <Text backgroundColor={lightBg} color={colors.dim}>
        {`claims ${swarmState.claims} · consensus ${swarmState.consensus}`
          .padEnd(panelInnerWidth)}
      </Text>
      <Text backgroundColor={lightBg}>
        {' '.repeat(panelInnerWidth)}
      </Text>
    </Box>
  );
});

SwarmPanel.displayName = 'SwarmPanel';
