/**
 * StatusLine — single-line status bar with provider/model info and swarm progress.
 */

import React, { memo } from 'react';

import type { SwarmStateSnapshot } from '../../core/hivemind/swarm-supervisor.js';

import { useAppStore } from '../store/appStore.js';
import { colors } from '../theme/chalkTheme.js';

const taskGlyphs: Array<{ color: string; glyph: string; status: string }> = [
  { color: colors.success, glyph: '✓', status: 'completed' },
  { color: colors.pending, glyph: '⧗', status: 'in_progress' },
  { color: colors.muted, glyph: '◌', status: 'pending' },
  { color: colors.warning, glyph: '◧', status: 'blocked' },
  { color: colors.error, glyph: '✖', status: 'failed' },
];

const SwarmStatus: React.FC<{ snapshot: SwarmStateSnapshot }> = memo(({ snapshot }) => {
  const stats = snapshot.taskStats;
  return (
    <>
      {taskGlyphs.map(({ color, glyph, status }) => {
        const count = stats[status] ?? 0;
        if (count === 0) return null;
        return (
          <text key={status}>
            <text style={{ color }}>{glyph}</text>
            <text style={{ color: colors.muted }}>{count} </text>
          </text>
        );
      })}
      <text style={{ color: colors.muted }}>│ </text>
      <text style={{ color: colors.info }}>claims {snapshot.claims}</text>
      <text style={{ color: colors.muted }}> │ </text>
      <text style={{ color: colors.borderSecondary }}>◍{snapshot.consensus}</text>
    </>
  );
});
SwarmStatus.displayName = 'SwarmStatus';

export const StatusLine: React.FC = memo(() => {
  const config = useAppStore((s) => s.config);
  const targetPath = useAppStore((s) => s.session.targetPath);
  const swarmState = useAppStore((s) => s.swarmState);
  const focusScope = useAppStore((s) => s.focusScope);

  const provider = config?.provider;
  const model = config?.model;
  const auditMode = config?.auditMode;
  const targetLabel = targetPath
    ? targetPath.split('/').slice(-1)[0] || targetPath
    : focusScope;

  return (
    <box border={{ color: colors.border, style: 'single' }} paddingX={1}>
      <box flexGrow={1}>
        <text style={{ color: colors.brand, fontWeight: 'bold' }}>Shadow</text>
        {provider && (
          <>
            <text style={{ color: colors.muted }}> │ </text>
            <text style={{ color: colors.info }}>{provider}</text>
          </>
        )}
        {model && (
          <>
            <text style={{ color: colors.muted }}> │ </text>
            <text style={{ color: colors.bright }}>{model}</text>
          </>
        )}
        {auditMode && (
          <>
            <text style={{ color: colors.muted }}> │ </text>
            <text style={{ color: colors.pending }}>{auditMode}</text>
          </>
        )}
        {targetLabel && targetLabel !== 'Global' && (
          <>
            <text style={{ color: colors.muted }}> │ </text>
            <text style={{ color: colors.muted }}>{targetLabel}</text>
          </>
        )}
        {config?.expertUnsafe && (
          <>
            <text style={{ color: colors.muted }}> │ </text>
            <text style={{ color: colors.error, fontWeight: 'bold' }}>EXPERT-UNSAFE</text>
          </>
        )}
      </box>
      {swarmState && <SwarmStatus snapshot={swarmState} />}
    </box>
  );
});

StatusLine.displayName = 'StatusLine';
