import React, { memo } from 'react';
/**
 * Header — branded title bar with ASCII art logo and status indicators.
 *
 * Supports compact mode (single line) toggled via 'H' keybinding.
 * All status indicators include text labels alongside color for accessibility.
 */

import { type SwarmStateSnapshot } from '../../core/hivemind/swarm-supervisor.js';
import { Box, Text } from "../primitives.js";
import { useAppStore } from '../store/appStore.js';
import { colors, colorTier, labels } from '../theme/chalkTheme.js';

const ASCII_LOGO = '█▀▀ █░█ █▀█ █▄▀ █▀█ █░█░█';
const ASCII_LOGO_LINE2 = '▄▄█ █▀█ █▀█ █▄▀ █▄█ ▀▄▀▄▀';

const statusLabels: Record<string, { color: string; label: string; symbol: string }> = {
  error: { color: colors.error, label: 'Error', symbol: '[x]' },
  idle: { color: colors.success, label: 'Ready', symbol: '[ok]' },
  initializing: { color: colors.pending, label: 'Loading', symbol: '[..]' },
  ready: { color: colors.success, label: 'Ready', symbol: '[ok]' },
};

function getAgentStatus(swarmState: null | SwarmStateSnapshot): string {
  if (!swarmState) return 'Idle';
  const active = swarmState.agents.filter((a) => a.status === 'active' || a.status === 'busy').length;
  return active > 0 ? `${active} Active` : 'Idle';
}

/** Format accessibility-friendly status: includes text label when NO_COLOR is active. */
function formatStatus(label: string, symbol: string): string {
  // When colors are disabled, rely on text symbol for status indication
  if (colorTier === 0) return `${symbol} ${label}`;
  return label;
}

export const Header: React.FC = memo(() => {
  const sessionPhase = useAppStore((state) => state.session.phase);
  const streaming = useAppStore((state) => state.streaming);
  const swarmState = useAppStore((state) => state.swarmState);
  const isCompact = useAppStore((state) => state.isCompact);
  const compactHeader = useAppStore((state) => state.compactHeader);
  const config = useAppStore((state) => state.config);
  const findingCount = useAppStore((state) => state.verifiedFindingIds.length);

  const effectivePhase = streaming ? 'initializing' : sessionPhase;
  const status = statusLabels[effectivePhase] ?? { color: colors.muted, label: effectivePhase, symbol: '[--]' };

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

  // Compact header: single-line with just name + status
  if (compactHeader) {
    return (
      <Box
        borderColor={colors.brand} borderStyle={'single'}
        paddingX={1}
      >
        <Box justifyContent="space-between">
          <Text bold color={colors.brand}>
            {labels.appName} {labels.version}
          </Text>
          <Box>
            <Text>
              <Text color={colors.muted}>[Status: </Text>
              <Text bold color={status.color}>
                {formatStatus(status.label, status.symbol)}
              </Text>
              <Text color={colors.muted}> | Agents: </Text>
              <Text bold color={agentColor}>{agentLabel}</Text>
              <Text color={colors.muted}>]</Text>
            </Text>
            {findingCount > 0 && (
              <Text color={colors.muted}>
                {`${findingCount}`} finding{findingCount === 1 ? '' : 's'}
              </Text>
            )}
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      borderColor={colors.brand} borderStyle={'double'}
      flexDirection="column"
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={colors.brand}>
          {isCompact
            ? `${labels.appName} ${labels.version}`
            : `${ASCII_LOGO} ${labels.appName} ${labels.version}`}
        </Text>
        <Box>
          <Text>
            <Text color={colors.muted}>[Status: </Text>
            <Text bold color={status.color}>
              {formatStatus(status.label, status.symbol)}
            </Text>
            <Text color={colors.muted}>]</Text>
          </Text>
          {findingCount > 0 && (
            <Text color={colors.muted}>
              {`${findingCount}`} finding{findingCount === 1 ? '' : 's'}
            </Text>
          )}
        </Box>
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
          <Text bold color={agentColor}>{agentLabel}</Text>
          <Text color={colors.muted}>]</Text>
        </Text>
      </Box>
    </Box>
  );
});

Header.displayName = 'Header';
