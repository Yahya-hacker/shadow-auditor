import { useStdout } from 'ink';
import React, { useEffect, useRef, useState } from 'react';

import { useAppStore } from '../store/appStore.js';
import { layout } from '../theme/chalkTheme.js';

export interface LayoutResult {
  bodyHeight: number;
  columns: number;
  isCompact: boolean;
  outputWidth: number;
  rows: number;
  sidebarWidth: number;
}

interface LayoutProps {
  children: (result: LayoutResult) => React.ReactNode;
}

/**
 * Ink flexbox-based layout.
 *
 * Computes terminal dimensions and provides a simplified LayoutResult for
 * components to consume. Replaces the previous Yoga-based layout with pure
 * Ink flexbox, which is sufficient for our grid-based TUI.
 *
 * Uses a ref for stdout to avoid re-subscribing on every render — the stdout
 * stream is stable for the lifetime of the Ink app, so we capture it once
 * and avoid the effect re-running when Ink's internal state changes.
 */
export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const { stdout } = useStdout();
  const stdoutRef = useRef(stdout);
  stdoutRef.current = stdout;

  const setIsCompact = useAppStore((state) => state.setIsCompact);
  const [result, setResult] = useState<LayoutResult>(() =>
    computeLayout(stdout.columns || 80, stdout.rows || 24),
  );

  useEffect(() => {
    const stream = stdoutRef.current;
    const handleResize = () => {
      const newResult = computeLayout(stream.columns || 80, stream.rows || 24);
      setResult(newResult);
      // Use getState to avoid needing setIsCompact in deps
      useAppStore.getState().setIsCompact(newResult.isCompact);
    };

    // Set initial layout (may already be set by useState initializer, but
    // stdout dimensions could have changed by the time this effect runs).
    handleResize();
    stream.on('resize', handleResize);
    return () => {
      stream.off('resize', handleResize);
    };
  }, []); // Empty deps — stdout stream is stable for the app lifetime

  return <>{children(result)}</>;
};

function computeLayout(columns: number, rows: number): LayoutResult {
  const isCompact = columns < layout.COMPACT_THRESHOLD;

  // Sidebar takes 25% of width (min 18 cols) when not compact
  const sidebarWidth = isCompact
    ? 0
    : Math.max(layout.MIN_SIDEBAR_WIDTH, Math.floor(columns * layout.SIDEBAR_RATIO));

  // Output area gets remaining width
  const outputWidth = columns - sidebarWidth;

  // Body height = total rows - header - input
  const bodyHeight = rows - layout.HEADER_HEIGHT - layout.INPUT_HEIGHT;

  return {
    bodyHeight: Math.max(0, bodyHeight),
    columns,
    isCompact,
    outputWidth: Math.max(0, outputWidth),
    rows,
    sidebarWidth,
  };
}
