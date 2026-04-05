/**
 * Human-in-the-Loop utilities for agentic tool confirmations using React/Ink.
 * Provides secure user prompts for dangerous operations like file edits and command execution.
 */

import React from 'react';
import { render } from 'ink';
import { FileEditPreview, CommandPreview } from '../ui/ConfirmDialog.js';

/**
 * Asks user for confirmation before applying a file edit using React/Ink.
 * Returns true if user approves, false if denied.
 */
export async function confirmFileEdit(filePath: string, targetCode: string, replacementCode: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { waitUntilExit } = render(
      React.createElement(FileEditPreview, {
        filePath,
        targetCode,
        replacementCode,
        onConfirm: (confirmed: boolean) => {
          resolve(confirmed);
          waitUntilExit().then(() => {});
        },
      })
    );
  });
}

/**
 * Asks user for confirmation before executing a command using React/Ink.
 * Returns true if user approves, false if denied.
 */
export async function confirmCommandExecution(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { waitUntilExit } = render(
      React.createElement(CommandPreview, {
        command,
        onConfirm: (confirmed: boolean) => {
          resolve(confirmed);
          waitUntilExit().then(() => {});
        },
      })
    );
  });
}
