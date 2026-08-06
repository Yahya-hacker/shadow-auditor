import React, { memo, useEffect, useState } from 'react';
/**
 * MetadataPanel — scan stats and session info.
 */

import { Box, Text } from "../primitives.js";
import { useAppStore } from '../store/appStore.js';
import { colors, layout } from '../theme/chalkTheme.js';

interface MetadataPanelProps {
  compact?: boolean;
}

function metadataStatus(streaming: boolean, phase: string): {color: string; label: string} {
  if (streaming) return {color: colors.pending, label: 'Running'};
  if (phase === 'ready') return {color: colors.success, label: 'Ready'};
  if (phase === 'error') return {color: colors.error, label: 'Error'};
  return {color: colors.muted, label: 'Idle'};
}

export const MetadataPanel: React.FC<MetadataPanelProps> = memo(({ compact = false }) => {
  const streaming = useAppStore((s) => s.streaming);
  const config = useAppStore((s) => s.config);
  const sessionPhase = useAppStore((s) => s.session.phase);
  const targetPath = useAppStore((s) => s.session.targetPath);
  const swarmState = useAppStore((s) => s.swarmState);
  const focusScope = useAppStore((s) => s.focusScope);
  const candidateCount = useAppStore((s) => s.currentVulnerabilityIds.length);
  const verifiedCount = useAppStore((s) => s.verifiedFindingIds.length);
  const activeStage = useAppStore((s) => s.activeAuditStage);
  const tokenUsage = useAppStore((s) => s.tokenUsage);
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

  const {color: statusColor, label: statusLabel} = metadataStatus(streaming, sessionPhase);

  const provider = config?.provider ?? '—';
  const model = config?.model ?? '—';
  const auditMode = config?.auditMode ?? '—';
  const targetLabel = targetPath ? targetPath.split('/').at(-1) || targetPath : focusScope;

  const hasTokens = tokenUsage.total > 0;
  const tokenLabel = hasTokens
    ? `Tokens: ${formatTokenCount(tokenUsage.total)}`
    : null;

  if (compact) {
    return (
      <Box
        borderColor={colors.border} borderStyle={'single'}
        flexDirection="column"
        paddingX={1}
      >
        <Text backgroundColor={lightBg} color={lightFg}>
          {'Status:'.padEnd(panelInnerWidth)}
        </Text>
        <Text backgroundColor={lightBg} bold color={statusColor}>
          {statusLabel.padEnd(panelInnerWidth)}
        </Text>
        <Text backgroundColor={lightBg} color={lightFg}>
          {`Current: ${candidateCount}`.padEnd(panelInnerWidth)}
        </Text>
        <Text backgroundColor={lightBg} color={colors.success}>
          {`Verified: ${verifiedCount}`.padEnd(panelInnerWidth)}
        </Text>
        {hasTokens && (
          <>
            <Text backgroundColor={lightBg} color={colors.info}>
              {`In: ${formatTokenCount(tokenUsage.prompt)}`.padEnd(panelInnerWidth)}
            </Text>
          </>
        )}
      </Box>
    );
  }

  return (
    <Box
      borderColor={colors.border} borderStyle={'single'}
      flexDirection="column"
      paddingX={1}
    >
      <Text backgroundColor={lightBg} bold color={lightFg}>Scan</Text>
      <Text backgroundColor={lightBg} color={lightFg}>
        {`${provider}/${model}`.padEnd(panelInnerWidth)}
      </Text>
      <Text backgroundColor={lightBg} color={lightFg}>
        {`Mode: ${auditMode}`.padEnd(panelInnerWidth)}
      </Text>
      <Text backgroundColor={lightBg} color={lightFg}>
        {`Target: ${targetLabel}`.padEnd(panelInnerWidth)}
      </Text>
      <Text backgroundColor={lightBg} color={lightFg}>
        {' '.repeat(panelInnerWidth)}
      </Text>
      <Text backgroundColor={lightBg} bold color={lightFg}>Session</Text>
      <Text backgroundColor={lightBg} color={lightFg}>
        {`Status: ${statusLabel}`.padEnd(panelInnerWidth)}
      </Text>
      <Text backgroundColor={lightBg} color={lightFg}>
        {`Current: ${candidateCount}`.padEnd(panelInnerWidth)}
      </Text>
      <Text backgroundColor={lightBg} color={colors.success}>
        {`Findings: ${verifiedCount}`.padEnd(panelInnerWidth)}
      </Text>
      <Text backgroundColor={lightBg} color={lightFg}>
        {`Stage: ${formatStage(activeStage)}`.slice(0, panelInnerWidth).padEnd(panelInnerWidth)}
      </Text>
      <Text backgroundColor={lightBg} color={lightFg}>
        {`Time: ${elapsed.toFixed(0)}s`.padEnd(panelInnerWidth)}
      </Text>
      <Text backgroundColor={lightBg} color={lightFg}>
        {' '.repeat(panelInnerWidth)}
      </Text>
      {hasTokens && (
        <>
          <Text backgroundColor={lightBg} bold color={lightFg}>Tokens</Text>
          <Text backgroundColor={lightBg} color={lightFg}>
            {`Prompt: ${formatTokenCount(tokenUsage.prompt)}`.padEnd(panelInnerWidth)}
          </Text>
          <Text backgroundColor={lightBg} color={lightFg}>
            {`Completion: ${formatTokenCount(tokenUsage.completion)}`.padEnd(panelInnerWidth)}
          </Text>
          <Text backgroundColor={lightBg} color={colors.info}>
            {`Total: ${tokenLabel!.replace('Tokens: ', '')}`.padEnd(panelInnerWidth)}
          </Text>
          <Text backgroundColor={lightBg} color={lightFg}>
            {' '.repeat(panelInnerWidth)}
          </Text>
        </>
      )}
      {swarmState && (
        <Text backgroundColor={lightBg} color={colors.focusBorder}>
          {`Swarm: ${swarmState.agents?.length ?? 0} agents, ${swarmState.claims ?? 0} claims`
            .slice(0, panelInnerWidth).padEnd(panelInnerWidth)}
        </Text>
      )}
    </Box>
  );
});

MetadataPanel.displayName = 'MetadataPanel';

/** Format token count in compact notation: 1234 → "1.2K", 1234567 → "1.2M". */
function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return String(count);
}

function formatStage(stage: null | string): string {
  if (!stage) return '—';
  return stage.replaceAll('_', ' ');
}
