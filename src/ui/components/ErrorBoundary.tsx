/**
 * ErrorBoundary — catch render errors in the OpenTUI component tree.
 *
 * Prevents a single render error from crashing the entire terminal UI.
 */

import React from 'react';

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
        <box
          border={{ color: colors.error, style: 'round' }}
          flexDirection="column"
          padding={1}
        >
          <box marginBottom={1}>
            <text style={{ color: colors.error, fontWeight: 'bold' }}>
              ✖ UI Error — Shadow Auditor encountered a rendering error.
            </text>
          </box>
          <box marginBottom={1}>
            <text style={{ color: colors.muted }}>
              {this.state.error.message}
            </text>
          </box>
          <text style={{ color: colors.muted }}>
            Press Ctrl+C to exit, or restart the application.
          </text>
        </box>
      );
    }

    return this.props.children;
  }
}
