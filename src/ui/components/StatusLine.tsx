import { Box, Text } from 'ink';
import React from 'react';

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

const SwarmStatus: React.FC<{ snapshot: SwarmStateSnapshot }> = ({ snapshot }) => {
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
};

/**
 * Single-line status bar: provider/model/target/mode on the left, live swarm
 * progress (per-status task glyphs, claim & consensus counts) on the right
 * when a swarm snapshot is available.
 */
export const StatusLine: React.FC = () => {
  const config = useAppStore((state) => state.config);
  const targetPath = useAppStore((state) => state.session.targetPath);
  const swarmState = useAppStore((state) => state.swarmState);

  const provider = config?.provider ?? 'unknown';
  const model = config?.model ?? 'unknown';
  const auditMode = config?.auditMode;

  return (
    <Box borderColor={colors.border} borderStyle="single" paddingX={1}>
      <Box flexGrow={1}>
        <Text bold color={colors.brand}>
          Shadow
        </Text>
        <Text color={colors.muted}> │ </Text>
        <Text color={colors.info}>{provider}</Text>
        <Text color={colors.muted}> │ </Text>
        <Text color={colors.bright}>{model}</Text>
        <Text color={colors.muted}> │ </Text>
        <Text color={colors.muted}>{targetPath}</Text>
        {auditMode && (
          <>
            <Text color={colors.muted}> │ </Text>
            <Text color={colors.pending}>{auditMode}</Text>
          </>
        )}
        {config?.expertUnsafe && (
          <>
            <Text color={colors.muted}> │ </Text>
            <Text bold color={colors.error}>
              EXPERT-UNSAFE
            </Text>
          </>
        )}
      </Box>
      {swarmState && <SwarmStatus snapshot={swarmState} />}
    </Box>
  );
};
