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
    <box
      border={{ color: colors.brand, style: 'double' }}
      flexDirection="column"
      paddingX={1}
    >
      <box justifyContent="space-between">
        <text style={{ color: colors.brand, fontWeight: 'bold' }}>
          {isCompact
            ? `${labels.appName} ${labels.version}`
            : `${ASCII_LOGO} ${labels.appName} ${labels.version}`}
        </text>
        <text>
          <text style={{ color: colors.muted }}>[Status: </text>
          <text style={{ color: status.color, fontWeight: 'bold' }}>{status.label}</text>
          {findingCount > 0 && (
            <text style={{ color: colors.muted }}>
              {' '}| {findingCount} finding{findingCount !== 1 ? 's' : ''}
            </text>
          )}
          <text style={{ color: colors.muted }}>]</text>
        </text>
      </box>
      <box justifyContent="space-between">
        <text style={{ color: colors.muted }}>
          {isCompact
            ? labels.appTagline
            : config
              ? `${config.provider}/${config.model}${config.auditMode ? ' · ' + config.auditMode : ''}`
              : `${ASCII_LOGO_LINE2} ${labels.appTagline}`}
        </text>
        <text>
          <text style={{ color: colors.muted }}>[Agents: </text>
          <text style={{ color: agentColor, fontWeight: 'bold' }}>{agentLabel}</text>
          <text style={{ color: colors.muted }}>]</text>
        </text>
      </box>
    </box>
  );
});

Header.displayName = 'Header';
