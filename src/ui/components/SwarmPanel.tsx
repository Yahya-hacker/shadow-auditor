/**
 * SwarmPanel — live multi-agent swarm visualization.
 *
 * Shows agent status, task progress, claims, and consensus metrics.
 * Hidden in compact mode.
 */

import React, { memo } from 'react';

import { useAppStore } from '../store/appStore.js';
import { colors, layout, spacing } from '../theme/chalkTheme.js';

const statusGlyph: Record<string, { color: string; glyph: string }> = {
  blocked: { color: colors.warning, glyph: '◧' },
  cancelled: { color: colors.dim, glyph: '⊘' },
  claimed: { color: colors.muted, glyph: '◔' },
  completed: { color: colors.success, glyph: '✓' },
  failed: { color: colors.error, glyph: '✖' },
  in_progress: { color: colors.pending, glyph: '⧗' },
  pending: { color: colors.muted, glyph: '◌' },
};

const agentGlyph: Record<string, { color: string; glyph: string }> = {
  active: { color: colors.success, glyph: '●' },
  busy: { color: colors.pending, glyph: '●' },
  idle: { color: colors.muted, glyph: '○' },
  offline: { color: colors.dim, glyph: '◌' },
};

const lightFg = colors.panelLightFg;
const lightBg = colors.panelLightBg;
const panelInnerWidth = layout.MIN_SIDEBAR_WIDTH - 2;

export const SwarmPanel: React.FC = memo(() => {
  const swarmState = useAppStore((state) => state.swarmState);

  if (!swarmState) {
    return (
      <box
        border={{ color: colors.border, style: 'single' }}
        flexDirection="column"
        paddingX={spacing.panelPadX}
        paddingY={spacing.panelPadY}
      >
        <text style={{ backgroundColor: lightBg, color: lightFg, fontWeight: 'bold' }}>
          {'Swarm'.padEnd(panelInnerWidth)}
        </text>
        <text style={{ backgroundColor: lightBg, color: lightFg }}>
          {'No active swarm run.'.padEnd(panelInnerWidth)}
        </text>
        <text style={{ backgroundColor: lightBg }}>
          {' '.repeat(panelInnerWidth)}
        </text>
      </box>
    );
  }

  return (
    <box
      border={{ color: colors.border, style: 'single' }}
      flexDirection="column"
      paddingX={spacing.panelPadX}
      paddingY={spacing.panelPadY}
    >
      <text style={{ backgroundColor: lightBg, color: lightFg, fontWeight: 'bold' }}>
        {'Swarm'.padEnd(panelInnerWidth)}
      </text>

      <text style={{ backgroundColor: lightBg, color: lightFg, fontWeight: 'bold' }}>
        {'Agents'.padEnd(panelInnerWidth)}
      </text>
      {swarmState.agents.map((agent) => {
        const g = agentGlyph[agent.status] ?? { color: colors.muted, glyph: '•' };
        const line = `${g.glyph} ${agent.role} ${agent.status}`;
        return (
          <text style={{ backgroundColor: lightBg, color: g.color }} key={agent.agentId}>
            {line.padEnd(panelInnerWidth)}
          </text>
        );
      })}

      <text style={{ backgroundColor: lightBg, color: lightFg, fontWeight: 'bold' }}>
        {'Tasks'.padEnd(panelInnerWidth)}
      </text>
      {swarmState.tasks.map((task) => {
        const g = statusGlyph[task.status] ?? { color: colors.muted, glyph: '•' };
        const line = `${g.glyph} ${task.taskType}`;
        return (
          <text style={{ backgroundColor: lightBg, color: g.color }} key={task.taskId}>
            {line.padEnd(panelInnerWidth)}
          </text>
        );
      })}

      <text style={{ backgroundColor: lightBg, color: colors.dim }}>
        {`claims ${swarmState.claims} · consensus ${swarmState.consensus}`
          .padEnd(panelInnerWidth)}
      </text>
      <text style={{ backgroundColor: lightBg }}>
        {' '.repeat(panelInnerWidth)}
      </text>
    </box>
  );
});

SwarmPanel.displayName = 'SwarmPanel';
