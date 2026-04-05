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
export async function confirmCommandExecution(command: string): Promise<boolean> {
  console.log(`\n\u001B[33m⚠️ Agent proposes executing command:\u001B[0m\n  $ ${command}\n`);

  const response = await p.confirm({
    initialValue: false,
    message: 'Allow execution of this command?',
  });

  return response === true;
}
