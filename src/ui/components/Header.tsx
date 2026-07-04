import { Box, Text } from 'ink';
import React, { memo } from 'react';

import { type SwarmStateSnapshot } from '../../core/hivemind/swarm-supervisor.js';
import { useAppStore } from '../store/appStore.js';
import { colors, labels } from '../theme.js';

/** ASCII art logo for the expanded header. Falls back to plain text in compact mode. */
const ASCII_LOGO = '█▀▀ █░█ █▀█ █▀▄ █▀█ █░█░█';
const ASCII_LOGO_LINE2 = '▄▄█ █▀█ █▀█ █▄▀ █▄█ ▀▄▀▄▀';

const statusLabels: Record<string, { color: string; label: string }> = {
  error: { color: colors.error, label: 'Error' },
  idle: { color: colors.success, label: 'Ready' },
  initializing: { color: colors.pending, label: 'Loading' },
  ready: { color: colors.success, label: 'Ready' },
};

function getAgentStatus(swarmState: null | SwarmStateSnapshot): string {
  if (!swarmState) return 'Idle';
  const active = swarmState.agents.filter((a) => a.status === 'active' || a.status === 'busy').length;
  return active > 0 ? `${active} Active` : 'Idle';
}

/**
 * 2-line header with ASCII art logo and right-aligned status indicators.
 *
 * Expanded mode (≥80 cols):
 *   ╔════════════════════════════════════════════════╗
 *   ║ █▀▀ █░█ █▀█ █▀▄ █▀█ █░█░█ ShadowAuditor v1.2.0 [Status: Ready]
 *   ║ ▄▄█ █▀█ █▀█ █▄▀ █▄█ ▀▄▀▄▀ AI-Native SAST      [Agents: Idle ]
 *   ╚════════════════════════════════════════════════╝
 *
 * Compact mode (<80 cols):
 *   ShadowAuditor v1.2.0 [Status: Ready]
 *   AI-Native SAST       [Agents: Idle ]
 */
export const Header: React.FC = memo(() => {
  const sessionPhase = useAppStore((state) => state.session.phase);
  const swarmState = useAppStore((state) => state.swarmState);
  const isCompact = useAppStore((state) => state.isCompact);

  const status = statusLabels[sessionPhase] ?? { color: colors.muted, label: sessionPhase };
  const agentStatus = getAgentStatus(swarmState);

  return (
    <Box
      borderColor={colors.brand}
      borderStyle="double"
      flexDirection="column"
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={colors.brand}>
          {isCompact ? `${labels.appName} ${labels.version}` : `${ASCII_LOGO} ${labels.appName} ${labels.version}`}
        </Text>
        <Text>
          <Text color={colors.muted}>[Status: </Text>
          <Text bold color={status.color}>{status.label}</Text>
          <Text color={colors.muted}>]</Text>
        </Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={colors.muted}>
          {isCompact ? labels.appTagline : `${ASCII_LOGO_LINE2} ${labels.appTagline}`}
        </Text>
        <Text>
          <Text color={colors.muted}>[Agents: </Text>
          <Text bold color={swarmState ? colors.pending : colors.muted}>{agentStatus}</Text>
          <Text color={colors.muted}>]</Text>
        </Text>
      </Box>
    </Box>
  );
});

Header.displayName = 'Header';
