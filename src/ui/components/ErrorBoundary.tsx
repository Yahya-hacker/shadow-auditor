import React from 'react';
/**
 * ErrorBoundary — catch render errors in the OpenTUI component tree.
 *
 * Prevents a single render error from crashing the entire terminal UI.
 */

import { Box, Text } from "../primitives.js";
import { colors } from '../theme/chalkTheme.js';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    process.stderr.write(`[ErrorBoundary] Caught render error: ${error.message}\n`);
    process.stderr.write(`[ErrorBoundary] Component stack: ${errorInfo.componentStack ?? 'N/A'}\n`);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <Box
          borderColor={colors.error} borderStyle={'rounded'}
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
