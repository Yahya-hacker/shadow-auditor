import { Box, Text } from 'ink';
import React, { memo, useEffect, useState } from 'react';

import { useAppStore } from '../store/appStore.js';
import { colors, layout } from '../theme.js';

interface MetadataPanelProps {
  /** Compact mode: shows abbreviated status + hits instead of full metadata. */
  compact?: boolean;
}

/**
 * Metadata panel showing hit count, elapsed time, and focus scope.
 *
 * Expanded:
 * ├─ Metadata ───────┤
 * │ Hits: 0          │
 * │ Time: 0.0s       │
 * │ Focus: Global    │
 * └──────────────────┘
 *
 * Compact:
 * Status: Running │ Hits: 5
 *
 * Light panel styling for visual contrast against the dark output area.
 */
export const MetadataPanel: React.FC<MetadataPanelProps> = memo(({ compact = false }) => {
  const streaming = useAppStore((s) => s.streaming);
  const config = useAppStore((s) => s.config);
  const sessionPhase = useAppStore((s) => s.session.phase);
  const targetPath = useAppStore((s) => s.session.targetPath);
  const swarmState = useAppStore((s) => s.swarmState);
  const focusScope = useAppStore((s) => s.focusScope);
  // Use the store's hitCount instead of scanning the messages array on every
  // render, avoiding a re-render cascade whenever a new message arrives.
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

  const statusLabel = streaming ? 'Running' : sessionPhase === 'ready' ? 'Ready' : sessionPhase === 'error' ? 'Error' : 'Idle';
  const statusColor = streaming ? colors.pending : sessionPhase === 'ready' ? colors.success : sessionPhase === 'error' ? colors.error : colors.muted;

  const provider = config?.provider ?? '—';
  const model = config?.model ?? '—';
  const auditMode = config?.auditMode ?? '—';
  const targetLabel = targetPath
    ? targetPath.split('/').slice(-1)[0] || targetPath
    : focusScope;

  if (compact) {
    return (
      <Box borderColor={colors.border} borderStyle="single" flexDirection="column" paddingX={1}>
        <Text backgroundColor={lightBg} color={lightFg}>{'Status:'.padEnd(panelInnerWidth)}</Text>
        <Text backgroundColor={lightBg} bold color={statusColor}>{statusLabel.padEnd(panelInnerWidth)}</Text>
        <Text backgroundColor={lightBg} color={lightFg}>{`Hits: ${hitCount}`.padEnd(panelInnerWidth)}</Text>
      </Box>
    );
  }

  return (
    <Box borderColor={colors.border} borderStyle="single" flexDirection="column" paddingX={1}>
      <Text backgroundColor={lightBg} bold color={lightFg}>Scan</Text>
      <Text backgroundColor={lightBg} color={lightFg}>{`${provider}/${model}`.padEnd(panelInnerWidth)}</Text>
      <Text backgroundColor={lightBg} color={lightFg}>{`Mode: ${auditMode}`.padEnd(panelInnerWidth)}</Text>
      <Text backgroundColor={lightBg} color={lightFg}>{`Target: ${targetLabel}`.padEnd(panelInnerWidth)}</Text>
      <Text backgroundColor={lightBg} color={lightFg}>{' '.repeat(panelInnerWidth)}</Text>
      <Text backgroundColor={lightBg} bold color={lightFg}>Session</Text>
      <Text backgroundColor={lightBg} color={lightFg}>{`Status: ${statusLabel}`.padEnd(panelInnerWidth)}</Text>
      <Text backgroundColor={lightBg} color={lightFg}>{`Findings: ${hitCount}`.padEnd(panelInnerWidth)}</Text>
      <Text backgroundColor={lightBg} color={lightFg}>{`Time: ${elapsed.toFixed(0)}s`.padEnd(panelInnerWidth)}</Text>
      <Text backgroundColor={lightBg} color={lightFg}>{' '.repeat(panelInnerWidth)}</Text>
      {swarmState && (
        <Text backgroundColor={lightBg} color={colors.focusBorder}>
          {`Swarm: ${swarmState.agents.length} agents, ${swarmState.claims} claims`.slice(0, panelInnerWidth).padEnd(panelInnerWidth)}
        </Text>
      )}
    </Box>
  );
});

MetadataPanel.displayName = 'MetadataPanel';
