/**
 * Human-in-the-Loop utilities for agentic tool confirmations.
 *
 * These functions resolve through the Zustand store's confirmation overlay,
 * avoiding any use of @clack/prompts while the Ink TUI is active.
 */

import { useAppStore } from '../ui/store/appStore.js';

function requestConfirmation(params: {
  details?: string;
  message: string;
  title: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    useAppStore.getState().requestConfirmation({
      ...params,
      onConfirm: (confirmed: boolean) => resolve(confirmed),
    });
  });
}

/**
 * Asks user for confirmation before applying a file edit.
 * Returns true if user approves, false if denied.
 */
export async function confirmFileEdit(
  filePath: string,
  targetCode: string,
  replacementCode: string,
): Promise<boolean> {
  return requestConfirmation({
    details: `Remove:\n${targetCode}\n\nAdd:\n${replacementCode}`,
    message: `Allow editing file: ${filePath}?`,
    title: 'PROPOSED FILE EDIT',
  });
}

/**
 * Asks user for confirmation before executing a command.
 * Returns true if user approves, false if denied.
 */
export async function confirmCommandExecution(command: string, warning?: string): Promise<boolean> {
  return requestConfirmation({
    details: warning ? `Warning: ${warning}` : undefined,
    message: `Allow execution of command: ${command}?`,
    title: 'PROPOSED COMMAND EXECUTION',
  });
}

/**
 * Asks user for confirmation before executing an MCP tool.
 * Returns true if user approves, false if denied.
 */
export async function confirmMcpToolExecution(
  adapterName: string,
  toolName: string,
  payload: unknown,
  warning?: string,
): Promise<boolean> {
  return requestConfirmation({
    details: warning ? `Warning: ${warning}\n\nInput: ${JSON.stringify(payload, null, 2)}` : `Input: ${JSON.stringify(payload, null, 2)}`,
    message: `Allow MCP tool execution: ${adapterName}.${toolName}?`,
    title: 'MCP TOOL EXECUTION',
  });
}
