import { Box, Text, Input } from "../../opentui/components.js";
/**
 * Header — 2-line branded title bar with ASCII art logo and status indicators.
 */

import React, { memo } from 'react';

import { type SwarmStateSnapshot } from '../../core/hivemind/swarm-supervisor.js';
import { useAppStore } from '../store/appStore.js';
import { colors, labels } from '../theme/chalkTheme.js';

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

export const Header: React.FC = memo(() => {
  const sessionPhase = useAppStore((state) => state.session.phase);
  const streaming = useAppStore((state) => state.streaming);
  const swarmState = useAppStore((state) => state.swarmState);
  const isCompact = useAppStore((state) => state.isCompact);
  const config = useAppStore((state) => state.config);
  const findingCount = useAppStore((state) => state.hitCount);

  const effectivePhase = streaming ? 'ready' : sessionPhase;
  const status = statusLabels[effectivePhase] ?? { color: colors.muted, label: effectivePhase };

  const agentStatus = getAgentStatus(swarmState);
  const agentLabel = streaming ? 'Processing...'
    : swarmState ? agentStatus
    : sessionPhase === 'ready' ? 'Ready'
    : sessionPhase === 'error' ? 'Error'
    : 'Idle';
  const agentColor = streaming ? colors.pending
    : swarmState ? colors.pending
    : sessionPhase === 'ready' ? colors.success
    : sessionPhase === 'error' ? colors.error
    : colors.muted;

  return (
    <Box
      borderColor={colors.brand} borderStyle={'double'}
      flexDirection="column"
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text color={colors.brand} bold>
          {isCompact
            ? `${labels.appName} ${labels.version}`
            : `${ASCII_LOGO} ${labels.appName} ${labels.version}`}
        </Text>
        <Text>
          <Text color={colors.muted}>[Status: </Text>
          <Text color={status.color} bold>{status.label}</Text>
          {findingCount > 0 && (
            <Text color={colors.muted}>
              {' '}| {findingCount} finding{findingCount !== 1 ? 's' : ''}
            </Text>
          )}
          <Text color={colors.muted}>]</Text>
        </Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={colors.muted}>
          {isCompact
            ? labels.appTagline
            : config
              ? `${config.provider}/${config.model}${config.auditMode ? ' · ' + config.auditMode : ''}`
              : `${ASCII_LOGO_LINE2} ${labels.appTagline}`}
        </Text>
        <Text>
          <Text color={colors.muted}>[Agents: </Text>
          <Text color={agentColor} bold>{agentLabel}</Text>
          <Text color={colors.muted}>]</Text>
        </Text>
      </Box>
    </Box>
  );
});

Header.displayName = 'Header';
