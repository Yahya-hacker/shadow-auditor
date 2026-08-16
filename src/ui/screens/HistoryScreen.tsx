import * as fs from 'node:fs/promises';
/**
 * HistoryScreen — displays past audit sessions from `.shadow-auditor/runs/`.
 *
 * Reads session metadata to build a list of runs with date, target, model,
 * and duration. Selecting a run shows its report summary if available.
 */
import * as path from 'node:path';
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';

import type { SessionMetadata } from '../../core/run-artifacts.js';

import { recoverAtomicWrite } from '../../utils/fs-atomic.js';
import { OptionList } from '../components/OptionList.js';
import { Box, type KeyEvent, Text, useKeyHandler } from "../primitives.js";
import { useAppStore } from '../store/appStore.js';
import { colors, labels, spacing } from '../theme/chalkTheme.js';

interface RunEntry {
  date: string;
  duration: string;
  findings: number;
  label: string;
  meta: SessionMetadata;
  reportSummary: null | string;
  runId: string;
  value: string;
}

/** Best-effort runtime shape check for a parsed session-meta.json. */
export function isSessionMetadata(value: unknown): value is SessionMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  return (
    typeof meta.runId === 'string' &&
    typeof meta.startedAt === 'string' &&
    typeof meta.targetPath === 'string' &&
    typeof meta.provider === 'string' &&
    typeof meta.model === 'string' &&
    (meta.completedAt === undefined || typeof meta.completedAt === 'string') &&
    Array.isArray(meta.warnings)
  );
}

/** Parse a session-meta.json file. Returns null on failure or invalid shape. */
async function readMeta(dirPath: string): Promise<null | SessionMetadata> {
  try {
    const metaPath = path.join(dirPath, 'session-meta.json');
    await recoverAtomicWrite(metaPath);
    const content = await fs.readFile(metaPath, 'utf8');
    const parsed: unknown = JSON.parse(content);
    if (!isSessionMetadata(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Try to read report.md for a summary. Returns null if not found. */
async function readReportSummary(dirPath: string): Promise<null | string> {
  try {
    const reportPath = path.join(dirPath, 'report.md');
    await recoverAtomicWrite(reportPath);
    const content = await fs.readFile(reportPath, 'utf8');
    // Return first 500 chars as a summary
    return content.slice(0, 500);
  } catch {
    return null;
  }
}

/** Format duration from ISO timestamps. */
function formatDuration(start: string, end?: string): string {
  if (!end) return 'in progress';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Scan runs directory and load entries. */
async function loadRuns(targetPath: string): Promise<RunEntry[]> {
  const runsDir = path.join(targetPath, '.shadow-auditor', 'runs');

  try {
    const entries = await fs.readdir(runsDir);
    const results: RunEntry[] = [];

    for (const entry of entries) {
      const entryPath = path.join(runsDir, entry);
      const stat = await fs.stat(entryPath).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const meta = await readMeta(entryPath);
      if (!meta) continue;

      const reportSummary = await readReportSummary(entryPath);
      const date = new Date(meta.startedAt).toLocaleString();
      const duration = formatDuration(meta.startedAt, meta.completedAt);
      const targetName = path.basename(meta.targetPath) || meta.targetPath;

      results.push({
        date,
        duration,
        findings: 0, // Findings count not stored in meta; report.md presence indicates analysis ran
        label: `${date} | ${targetName} | ${meta.provider}/${meta.model} | ${duration}`,
        meta,
        reportSummary,
        runId: meta.runId,
        value: meta.runId,
      });
    }

    // Sort by date descending (most recent first)
    results.sort((a, b) =>
      new Date(b.meta.startedAt).getTime() - new Date(a.meta.startedAt).getTime(),
    );

    return results;
  } catch {
    // Directory doesn't exist or isn't readable
    return [];
  }
}

const RunDetail: React.FC<{ entry: RunEntry }> = memo(({ entry }) => (
  <Box
    borderColor={colors.border} borderStyle={'single'}
    flexDirection="column"
    marginTop={1}
    paddingX={spacing.panelPadX}
    paddingY={spacing.panelPadY}
  >
    <Text bold color={colors.brand}>Run Details</Text>
    <Text color={colors.muted}>Run ID: <Text color={colors.bright}>{entry.runId}</Text></Text>
    <Text color={colors.muted}>Target: <Text color={colors.bright}>{entry.meta.targetPath}</Text></Text>
    <Text color={colors.muted}>Model: <Text color={colors.info}>{entry.meta.provider}/{entry.meta.model}</Text></Text>
    <Text color={colors.muted}>Started: <Text color={colors.bright}>{entry.date}</Text></Text>
    <Text color={colors.muted}>Duration: <Text color={colors.success}>{entry.duration}</Text></Text>
    {entry.meta.completedAt && (
      <Text color={colors.muted}>Completed: <Text color={colors.bright}>{new Date(entry.meta.completedAt).toLocaleString()}</Text></Text>
    )}
    {entry.meta.warnings.length > 0 && (
      <Text color={colors.warning}>Warnings: {entry.meta.warnings.join(', ')}</Text>
    )}
    {entry.reportSummary && (
      <>
        <Text bold color={colors.brand}>Report Summary</Text>
        <Text color={colors.bright}>{entry.reportSummary}</Text>
      </>
    )}
    {!entry.reportSummary && (
      <Text color={colors.dim}>No report summary available for this run.</Text>
    )}
  </Box>
));
RunDetail.displayName = 'RunDetail';

export const HistoryScreen: React.FC = memo(() => {
  const setScreen = useAppStore((s) => s.setScreen);
  const targetPath = useAppStore((s) => s.session.targetPath);
  const [runs, setRuns] = useState<RunEntry[]>([]);
  const [selectedRun, setSelectedRun] = useState<null | RunEntry>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadRuns(targetPath ?? process.cwd()).then((results) => {
      setRuns(results);
      setLoading(false);
    });
  }, [targetPath]);

  const options = useMemo(
    () => runs.map((r) => ({ label: r.label, value: r.value })),
    [runs],
  );

  const handleSelect = useCallback(
    (value: string) => {
      const entry = runs.find((r) => r.value === value);
      if (entry) setSelectedRun(entry);
    },
    [runs],
  );

  const handleKeyDown = useCallback(
    (evt: KeyEvent) => {
      if (evt.key === 'Escape') {
        if (selectedRun) {
          setSelectedRun(null);
        } else {
          setScreen('shell');
        }
      }
    },
    [selectedRun, setScreen],
  );

  useKeyHandler(handleKeyDown);

  return (
    <Box
      flexDirection="column"
      height="100%"
      paddingX={spacing.panelPadX}
      width="100%"
    >
      <Box
        borderColor={colors.brand} borderStyle={'double'}
        flexDirection="column"
        paddingX={spacing.panelPadX}
        paddingY={spacing.panelPadY}
      >
        <Box justifyContent="space-between">
          <Text bold color={colors.brand}>
            {labels.appName} — Session History
          </Text>
          <Text color={colors.muted}>[Esc] back</Text>
        </Box>
      </Box>

      {loading && (
        <Text color={colors.agent}>Scanning run history...</Text>
      )}

      {!loading && runs.length === 0 && (
        <Text color={colors.muted}>
          No past audit sessions found. Run an analysis to create session history.
        </Text>
      )}

      {!loading && runs.length > 0 && !selectedRun && (
        <>
          <Text color={colors.bright}>
            {`${runs.length}`} session{runs.length === 1 ? '' : 's'} found:
          </Text>
          <OptionList
            onCancel={() => setScreen('shell')}
            onSelect={handleSelect}
            options={options}
          />
        </>
      )}

      {selectedRun && (
        <>
          <RunDetail entry={selectedRun} />
          <Text color={colors.dim}>Press Esc to return to the list.</Text>
        </>
      )}
    </Box>
  );
});

HistoryScreen.displayName = 'HistoryScreen';
