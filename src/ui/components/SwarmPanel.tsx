import { Box, Text } from 'ink';
import React from 'react';

import { useAppStore } from '../store/appStore.js';
import { colors, spacing } from '../theme/chalkTheme.js';

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

/**
 * Live swarm panel: agent roster, per-task progress, and claim/consensus
 * totals. Bound to the `swarmState` slice streamed from the supervisor's
 * evaluateConsensus node. Shown in the right column when toggled open (`P`).
 */
export const SwarmPanel: React.FC = () => {
  const swarmState = useAppStore((state) => state.swarmState);
  const focused = useAppStore((state) => state.focus) === 'panel';

  if (!swarmState) {
    return (
      <Box
        borderColor={colors.border}
        borderStyle="round"
        flexDirection="column"
        paddingX={spacing.panelPadX}
        paddingY={spacing.panelPadY}
      >
        <Text bold color={colors.brand}>
          ◈ Swarm
        </Text>
        <Text color={colors.muted}>No active swarm run.</Text>
      </Box>
    );
  }

  return (
    <Box
      borderColor={focused ? colors.borderSecondary : colors.border}
      borderStyle="round"
      flexDirection="column"
      paddingX={spacing.panelPadX}
      paddingY={spacing.panelPadY}
    >
      <Text bold color={colors.brand}>
        ◈ Swarm
      </Text>

      <Text bold color={colors.bright}>
        Agents
      </Text>
      {swarmState.agents.map((agent) => {
        const g = agentGlyph[agent.status] ?? { color: colors.muted, glyph: '•' };
        return (
          <Box gap={1} key={agent.agentId}>
            <Text color={g.color}>{g.glyph}</Text>
            <Text color={colors.info}>{agent.role}</Text>
            <Text color={colors.muted}> {agent.status}</Text>
          </Box>
        );
      })}

      <Text bold color={colors.bright}>
        Tasks
      </Text>
      {swarmState.tasks.map((task) => {
        const g = statusGlyph[task.status] ?? { color: colors.muted, glyph: '•' };
        return (
          <Box gap={1} key={task.taskId}>
            <Text color={g.color}>{g.glyph}</Text>
            <Text color={colors.muted}>{task.taskType}</Text>
            {task.requiredRole ? (
              <Text color={colors.dim}> {task.requiredRole}</Text>
            ) : null}
          </Box>
        );
      })}

      <Text color={colors.dim}>
        claims {swarmState.claims} · consensus {swarmState.consensus}
      </Text>
    </Box>
  );
};
