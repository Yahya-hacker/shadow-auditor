import { Box, useStdout } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';
import Yoga from 'yoga-layout-prebuilt';

export interface PanelRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface LayoutResult {
  body: PanelRect;
  header: PanelRect;
  input: PanelRect;
  status: PanelRect;
}

interface LayoutProps {
  children: (result: LayoutResult) => React.ReactNode;
}

export const HEADER_HEIGHT = 3;
export const STATUS_HEIGHT = 1;
export const INPUT_HEIGHT = 3;

/**
 * Yoga-based deterministic layout.
 *
 * Computes exact panel rectangles so Ink only reconciles what actually
 * changed. This removes the ambiguity of percentage-based sizing and avoids
 * the full-terminal re-renders that cause blinking.
 */
export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const { stdout } = useStdout();
  const [result, setResult] = useState<LayoutResult>(() =>
    computeLayout(stdout.columns || 80, stdout.rows || 24),
  );

  useEffect(() => {
    const handleResize = () => {
      setResult(computeLayout(stdout.columns || 80, stdout.rows || 24));
    };

    stdout.on('resize', handleResize);
    return () => {
      stdout.off('resize', handleResize);
    };
  }, [stdout]);

  return <>{children(result)}</>;
};

function computeLayout(columns: number, rows: number): LayoutResult {
  const root = Yoga.Node.create();
  root.setWidth(columns);
  root.setHeight(rows);
  root.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN);

  const header = Yoga.Node.create();
  header.setHeight(HEADER_HEIGHT);
  root.insertChild(header, 0);

  const body = Yoga.Node.create();
  body.setFlex(1);
  root.insertChild(body, 1);

  const status = Yoga.Node.create();
  status.setHeight(STATUS_HEIGHT);
  root.insertChild(status, 2);

  const input = Yoga.Node.create();
  input.setHeight(INPUT_HEIGHT);
  root.insertChild(input, 3);

  root.calculateLayout(columns, rows, Yoga.DIRECTION_LTR);

  const headerLayout = header.getComputedLayout();
  const bodyLayout = body.getComputedLayout();
  const statusLayout = status.getComputedLayout();
  const inputLayout = input.getComputedLayout();

  const result: LayoutResult = {
    body: {
      height: Math.max(0, Math.floor(bodyLayout.height)),
      width: Math.max(0, Math.floor(bodyLayout.width)),
      x: Math.floor(bodyLayout.left),
      y: Math.floor(bodyLayout.top),
    },
    header: {
      height: Math.max(0, Math.floor(headerLayout.height)),
      width: Math.max(0, Math.floor(headerLayout.width)),
      x: Math.floor(headerLayout.left),
      y: Math.floor(headerLayout.top),
    },
    input: {
      height: Math.max(0, Math.floor(inputLayout.height)),
      width: Math.max(0, Math.floor(inputLayout.width)),
      x: Math.floor(inputLayout.left),
      y: Math.floor(inputLayout.top),
    },
    status: {
      height: Math.max(0, Math.floor(statusLayout.height)),
      width: Math.max(0, Math.floor(statusLayout.width)),
      x: Math.floor(statusLayout.left),
      y: Math.floor(statusLayout.top),
    },
  };

  root.freeRecursive();
  return result;
}

/**
 * Convenience wrapper that renders a panel at a fixed rectangle.
 * Avoids re-rendering the whole screen when only one panel changes.
 */
export const Panel: React.FC<{
  children: React.ReactNode;
  rect: PanelRect;
}> = ({ children, rect }) => (
  <Box flexDirection="column" height={rect.height} width={rect.width}>
    {children}
  </Box>
);
