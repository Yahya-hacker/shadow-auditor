import * as path from 'node:path';
import React, { memo } from 'react';
/**
 * StatusLine — single-line status bar with provider/model info and swarm progress.
 * All status indicators include text labels for accessibility (NO_COLOR safe).
 */

import type { SwarmStateSnapshot } from '../../core/hivemind/swarm-supervisor.js';

import { Box, Text } from "../primitives.js";
import { useAppStore } from '../store/appStore.js';
import { colors } from '../theme/chalkTheme.js';

const taskGlyphs: Array<{ color: string; glyph: string; label: string; status: string }> = [
  { color: colors.success, glyph: '✓', label: 'done', status: 'completed' },
  { color: colors.pending, glyph: '⧗', label: 'wip', status: 'in_progress' },
  { color: colors.muted, glyph: '◌', label: 'wait', status: 'pending' },
  { color: colors.warning, glyph: '◧', label: 'block', status: 'blocked' },
  { color: colors.error, glyph: '✖', label: 'fail', status: 'failed' },
];

const SwarmStatus: React.FC<{ snapshot: SwarmStateSnapshot }> = memo(({ snapshot }) => {
  const stats = snapshot.taskStats ?? {};
  return (
    <>
      {taskGlyphs.map(({ color, glyph, label, status }) => {
        const count = stats[status] ?? 0;
        if (count === 0) return null;
        return (
          <Text key={status}>
            <Text color={color}>{glyph}</Text>
            <Text color={colors.muted}>{`${count}`}({label}) </Text>
          </Text>
        );
      })}
      <Text color={colors.muted}>│ </Text>
      <Text color={colors.info}>claims {`${snapshot.claims ?? 0}`}</Text>
      <Text color={colors.muted}> │ </Text>
      <Text color={colors.borderSecondary}>◍{`${snapshot.consensus ?? '—'}`}</Text>
    </>
  );
});
SwarmStatus.displayName = 'SwarmStatus';

export const StatusLine: React.FC = memo(() => {
  const config = useAppStore((s) => s.config);
  const targetPath = useAppStore((s) => s.session.targetPath);
  const swarmState = useAppStore((s) => s.swarmState);
  const focusScope = useAppStore((s) => s.focusScope);
  const tokenUsage = useAppStore((s) => s.tokenUsage);

  const provider = config?.provider;
  const model = config?.model;
  const auditMode = config?.auditMode;
  const targetLabel = targetPath
    ? path.win32.basename(path.posix.basename(targetPath)) || targetPath
    : focusScope;

  const hasTokens = tokenUsage.total > 0;
  const tokenLabel = hasTokens
    ? `Tokens: ${formatTokenCount(tokenUsage.total)}`
    : null;

  return (
    <Box borderColor={colors.border} borderStyle={'single'} paddingX={1}>
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
        {tokenLabel && (
          <>
            <Text color={colors.muted}> │ </Text>
            <Text color={colors.info}>{tokenLabel}</Text>
          </>
        )}
      </Box>
      {swarmState && <SwarmStatus snapshot={swarmState} />}
    </Box>
  );
});

StatusLine.displayName = 'StatusLine';

/** Format token count in compact notation: 1234 → "1.2K", 1234567 → "1.2M". */
function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return String(count);
}
