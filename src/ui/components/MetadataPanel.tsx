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
  const hitCount = useAppStore((state) => state.hitCount);
  const focusScope = useAppStore((state) => state.focusScope);
  const streaming = useAppStore((state) => state.streaming);
  const sessionPhase = useAppStore((state) => state.session.phase);
  const config = useAppStore((state) => state.config);
  const swarmState = useAppStore((state) => state.swarmState);
  const [elapsed, setElapsed] = useState(0);

  // Increment elapsed time while streaming
  useEffect(() => {
    if (!streaming) return;
    const interval = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [streaming]);

  // Reset elapsed when streaming starts
  useEffect(() => {
    if (streaming) setElapsed(0);
  }, [streaming]);

  const lightFg = colors.panelLightFg;
  const lightBg = colors.panelLightBg;
  const panelInnerWidth = compact ? 14 : layout.MIN_SIDEBAR_WIDTH - 2;

  const statusLabel = streaming ? 'Running' : sessionPhase === 'idle' ? 'Ready' : 'Loading';
  const statusColor = streaming ? colors.pending : sessionPhase === 'idle' ? colors.success : colors.pending;

  const provider = config?.provider ?? 'unknown';
  const model = config?.model ?? 'unknown';

  if (compact) {
    return (
      <Box
        borderColor={colors.border}
        borderStyle="single"
        flexDirection="column"
        paddingX={1}
      >
        <Text backgroundColor={lightBg} color={lightFg}>
          {'Status: '.padEnd(panelInnerWidth)}
        </Text>
        <Text backgroundColor={lightBg} bold color={statusColor}>
          {statusLabel.padEnd(panelInnerWidth)}
        </Text>
        <Text backgroundColor={lightBg} color={lightFg}>
          {`Hits: ${hitCount}`.padEnd(panelInnerWidth)}
        </Text>
      </Box>
    );
  }

  return (
    <Box
      borderColor={colors.border}
      borderStyle="single"
      flexDirection="column"
      paddingX={1}
    >
      <Text backgroundColor={lightBg} bold color={lightFg}>
        {'Metadata'.padEnd(panelInnerWidth)}
      </Text>
      <Text backgroundColor={lightBg} color={lightFg}>
        {`Hits: ${hitCount}`.padEnd(panelInnerWidth)}
      </Text>
      <Text backgroundColor={lightBg} color={lightFg}>
        {`Time: ${elapsed.toFixed(1)}s`.padEnd(panelInnerWidth)}
      </Text>
      <Text backgroundColor={lightBg} color={lightFg}>
        {`Focus: ${focusScope}`.padEnd(panelInnerWidth)}
      </Text>
      <Text backgroundColor={lightBg} color={lightFg}>
        {`${provider}/${model}`.padEnd(panelInnerWidth)}
      </Text>
      {swarmState && (
        <Text backgroundColor={lightBg} color={colors.focusBorder}>
          {`Tasks: ${swarmState.taskStats.completed ?? 0}/${Object.values(swarmState.taskStats).reduce((a, b) => a + b, 0)}`.padEnd(panelInnerWidth)}
        </Text>
      )}
      {/* Fill remaining space */}
      <Text backgroundColor={lightBg}>
        {' '.repeat(panelInnerWidth)}
      </Text>
    </Box>
  );
});

MetadataPanel.displayName = 'MetadataPanel';
