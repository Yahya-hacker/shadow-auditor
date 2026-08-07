/**
 * Human-in-the-Loop utilities for agentic tool confirmations using React/Ink.
 * Provides secure user prompts for dangerous operations like file edits and command execution.
 */

import * as p from '@clack/prompts';

/**
 * Asks user for confirmation before applying a file edit.
 * Returns true if user approves, false if denied.
 */
export async function confirmFileEdit(filePath: string, targetCode: string, replacementCode: string): Promise<boolean> {
  console.log(`\n\u001B[33m⚠️ Agent proposes editing file:\u001B[0m ${filePath}`);
  console.log(`\n\u001B[31m- ${targetCode}\u001B[0m\n\u001B[32m+ ${replacementCode}\u001B[0m\n`);

  const response = await p.confirm({
    initialValue: false,
    message: 'Allow this file edit?',
  });

  return response === true;
}

/**
 * Asks user for confirmation before executing a command.
 * Returns true if user approves, false if denied.
 */
export async function confirmCommandExecution(command: string, warning?: string): Promise<boolean> {
  console.log(`\n\u001B[33m⚠️ Agent proposes executing command:\u001B[0m\n  $ ${command}\n`);
  if (warning) {
    console.log(`\u001B[31m${warning}\u001B[0m\n`);
  }

  const response = await p.confirm({
    initialValue: false,
    message: 'Allow execution of this command?',
  });

  return response === true;
}

export async function confirmMcpToolExecution(
  adapterName: string,
  toolName: string,
  payload: unknown,
  warning?: string,
): Promise<boolean> {
  console.log(`\n\u001B[33m⚠️ MCP tool execution requested:\u001B[0m ${adapterName}.${toolName}`);
  console.log(`\n\u001B[36mInput:\u001B[0m ${JSON.stringify(payload, null, 2)}\n`);

  if (warning) {
    console.log(`\u001B[31m${warning}\u001B[0m\n`);
  }

  const response = await p.confirm({
    initialValue: false,
    message: 'Allow this MCP tool execution?',
  });

  return response === true;
}
