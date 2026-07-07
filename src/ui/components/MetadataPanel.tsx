/**
 * MetadataPanel — scan stats and session info.
 */

import React, { memo, useEffect, useState } from 'react';

import { useAppStore } from '../store/appStore.js';
import { colors, layout } from '../theme/chalkTheme.js';

interface MetadataPanelProps {
  compact?: boolean;
}

export const MetadataPanel: React.FC<MetadataPanelProps> = memo(({ compact = false }) => {
  const streaming = useAppStore((s) => s.streaming);
  const config = useAppStore((s) => s.config);
  const sessionPhase = useAppStore((s) => s.session.phase);
  const targetPath = useAppStore((s) => s.session.targetPath);
  const swarmState = useAppStore((s) => s.swarmState);
  const focusScope = useAppStore((s) => s.focusScope);
  const hitCount = useAppStore((s) => s.hitCount);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!streaming) return;
    setElapsed(0);
    const interval = setInterval(() => { setElapsed((p) => p + 1); }, 1000);
    return () => clearInterval(interval);
  }, [streaming]);

  const lightFg = colors.panelLightFg;
  const lightBg = colors.panelLightBg;
  const panelInnerWidth = compact ? 14 : layout.MIN_SIDEBAR_WIDTH - 2;

  const statusLabel = streaming ? 'Running'
    : sessionPhase === 'ready' ? 'Ready'
    : sessionPhase === 'error' ? 'Error'
    : 'Idle';
  const statusColor = streaming ? colors.pending
    : sessionPhase === 'ready' ? colors.success
    : sessionPhase === 'error' ? colors.error
    : colors.muted;

  const provider = config?.provider ?? '—';
  const model = config?.model ?? '—';
  const auditMode = config?.auditMode ?? '—';
  const targetLabel = targetPath
    ? targetPath.split('/').slice(-1)[0] || targetPath
    : focusScope;

  if (compact) {
    return (
      <box
        border={{ color: colors.border, style: 'single' }}
        flexDirection="column"
        paddingX={1}
      >
        <text style={{ backgroundColor: lightBg, color: lightFg }}>
          {'Status:'.padEnd(panelInnerWidth)}
        </text>
        <text style={{ backgroundColor: lightBg, color: statusColor, fontWeight: 'bold' }}>
          {statusLabel.padEnd(panelInnerWidth)}
        </text>
        <text style={{ backgroundColor: lightBg, color: lightFg }}>
          {`Hits: ${hitCount}`.padEnd(panelInnerWidth)}
        </text>
      </box>
    );
  }

  return (
    <box
      border={{ color: colors.border, style: 'single' }}
      flexDirection="column"
      paddingX={1}
    >
      <text style={{ backgroundColor: lightBg, color: lightFg, fontWeight: 'bold' }}>Scan</text>
      <text style={{ backgroundColor: lightBg, color: lightFg }}>
        {`${provider}/${model}`.padEnd(panelInnerWidth)}
      </text>
      <text style={{ backgroundColor: lightBg, color: lightFg }}>
        {`Mode: ${auditMode}`.padEnd(panelInnerWidth)}
      </text>
      <text style={{ backgroundColor: lightBg, color: lightFg }}>
        {`Target: ${targetLabel}`.padEnd(panelInnerWidth)}
      </text>
      <text style={{ backgroundColor: lightBg, color: lightFg }}>
        {' '.repeat(panelInnerWidth)}
      </text>
      <text style={{ backgroundColor: lightBg, color: lightFg, fontWeight: 'bold' }}>Session</text>
      <text style={{ backgroundColor: lightBg, color: lightFg }}>
        {`Status: ${statusLabel}`.padEnd(panelInnerWidth)}
      </text>
      <text style={{ backgroundColor: lightBg, color: lightFg }}>
        {`Findings: ${hitCount}`.padEnd(panelInnerWidth)}
      </text>
      <text style={{ backgroundColor: lightBg, color: lightFg }}>
        {`Time: ${elapsed.toFixed(0)}s`.padEnd(panelInnerWidth)}
      </text>
      <text style={{ backgroundColor: lightBg, color: lightFg }}>
        {' '.repeat(panelInnerWidth)}
      </text>
      {swarmState && (
        <text style={{ backgroundColor: lightBg, color: colors.focusBorder }}>
          {`Swarm: ${swarmState.agents.length} agents, ${swarmState.claims} claims`
            .slice(0, panelInnerWidth).padEnd(panelInnerWidth)}
        </text>
      )}
    </box>
  );
});

MetadataPanel.displayName = 'MetadataPanel';
