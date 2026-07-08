import { Box, Text, Input } from "../../opentui/components.js";
/**
 * SwarmPanel — live multi-agent swarm visualization.
 *
 * Shows agent status, task progress, claims, and consensus metrics.
 * Hidden in compact mode.
 */

import React, { memo } from 'react';

import { useAppStore } from '../store/appStore.js';
import { colors, layout, spacing } from '../theme/chalkTheme.js';

const statusGlyph: Record<string, { color: string; glyph: string }> = {
  blocked: { color: colors.warning, glyph: '◧' },
  cancelled: { color: colors.dim, glyph: '⊘' },
  claimed: { color: colors.muted, glyph: '◔' },
  completed: { color: colors.success, glyph: '✓' },
  failed: { color: colors.error, glyph: '✖' },
  in_progress: { color: colors.pending, glyph: '⧗' },
  pending: { color: colors.muted, glyph: '◌' },
};

const agentGlyph: Record<string, { color: string; glyph: string }> = {
  active: { color: colors.success, glyph: '●' },
  busy: { color: colors.pending, glyph: '●' },
  idle: { color: colors.muted, glyph: '○' },
  offline: { color: colors.dim, glyph: '◌' },
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
        <Text backgroundColor={lightBg} color={lightFg} bold>
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
      <Text backgroundColor={lightBg} color={lightFg} bold>
        {'Swarm'.padEnd(panelInnerWidth)}
      </Text>

      <Text backgroundColor={lightBg} color={lightFg} bold>
        {'Agents'.padEnd(panelInnerWidth)}
      </Text>
      {swarmState.agents.map((agent) => {
        const g = agentGlyph[agent.status] ?? { color: colors.muted, glyph: '•' };
        const line = `${g.glyph} ${agent.role} ${agent.status}`;
        return (
          <Text backgroundColor={lightBg} color={g.color} key={agent.agentId}>
            {line.padEnd(panelInnerWidth)}
          </Text>
        );
      })}

      <Text backgroundColor={lightBg} color={lightFg} bold>
        {'Tasks'.padEnd(panelInnerWidth)}
      </Text>
      {swarmState.tasks.map((task) => {
        const g = statusGlyph[task.status] ?? { color: colors.muted, glyph: '•' };
        const line = `${g.glyph} ${task.taskType}`;
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
