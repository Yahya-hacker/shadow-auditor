import { Box, Text } from 'ink';
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
          <Text key={status}>
            <Text color={color}>{glyph}</Text>
            <Text color={colors.muted}>{count} </Text>
          </Text>
        );
      })}
      <Text color={colors.muted}>│ </Text>
      <Text color={colors.info}>claims {snapshot.claims}</Text>
      <Text color={colors.muted}> │ </Text>
      <Text color={colors.borderSecondary}>◍{snapshot.consensus}</Text>
    </>
  );
});

SwarmStatus.displayName = 'SwarmStatus';

/**
 * Single-line status bar with swarm task glyphs.
 *
 * In expanded mode: renders a full status line with provider/model/mode
 * and swarm progress on the right. In compact mode: renders an abbreviated
 * version with just the essential info.
 */
export const StatusLine: React.FC = memo(() => {
  const config = useAppStore((s) => s.config);
  const targetPath = useAppStore((s) => s.session.targetPath);
  const swarmState = useAppStore((s) => s.swarmState);
  const isCompact = useAppStore((s) => s.isCompact);
  const focusScope = useAppStore((s) => s.focusScope);

  const provider = config?.provider;
  const model = config?.model;
  const auditMode = config?.auditMode;
  const targetLabel = targetPath
    ? targetPath.split('/').slice(-1)[0] || targetPath
    : focusScope;

  return (
    <Box borderColor={colors.border} borderStyle="single" paddingX={1}>
      <Box flexGrow={1}>
        <Text bold color={colors.brand}>Shadow</Text>
        {provider && (
          <>
            <Text color={colors.muted}> │ </Text>
            <Text color={colors.info}>{provider}</Text>
          </>
        )}
        {model && (
          <>
            <Text color={colors.muted}> │ </Text>
            <Text color={colors.bright}>{model}</Text>
          </>
        )}
        {auditMode && (
          <>
            <Text color={colors.muted}> │ </Text>
            <Text color={colors.pending}>{auditMode}</Text>
          </>
        )}
        {targetLabel && targetLabel !== 'Global' && (
          <>
            <Text color={colors.muted}> │ </Text>
            <Text color={colors.muted}>{targetLabel}</Text>
          </>
        )}
        {config?.expertUnsafe && (
          <>
            <Text color={colors.muted}> │ </Text>
            <Text bold color={colors.error}>EXPERT-UNSAFE</Text>
          </>
        )}
      </Box>
      {swarmState && <SwarmStatus snapshot={swarmState} />}
    </Box>
  );
});

StatusLine.displayName = 'StatusLine';
