import { Box, Text } from 'ink';
import React from 'react';

import { colors } from '../theme/chalkTheme.js';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * React Error Boundary for Ink-rendered components.
 *
 * Prevents a single render error in the ShellScreen tree from crashing the
 * entire terminal UI. When an error is caught, renders a visible fallback
 * with the error message instead of a blank screen.
 *
 * Ink does not ship with an Error Boundary, so we provide one here.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Log to stderr so it's available for debugging without interfering
    // with Ink's stdout rendering.
    process.stderr.write(`[ErrorBoundary] Caught render error: ${error.message}\n`);
    process.stderr.write(`[ErrorBoundary] Component stack: ${errorInfo.componentStack ?? 'N/A'}\n`);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <Box
          borderColor={colors.error}
          borderStyle="round"
          flexDirection="column"
          padding={1}
        >
          <Box marginBottom={1}>
            <Text bold color={colors.error}>
              ✖ UI Error — Shadow Auditor encountered a rendering error.
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text color={colors.muted}>
              {this.state.error.message}
            </Text>
          </Box>
          <Text color={colors.muted}>
            Press Ctrl+C to exit, or restart the application.
          </Text>
        </Box>
      );
    }

    return this.props.children;
  }
}
