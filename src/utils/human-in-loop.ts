/**
 * Human-in-the-Loop utilities for agentic tool confirmations.
 * Provides secure user prompts for dangerous operations like file edits and command execution.
 */

import * as p from '@clack/prompts';

// ANSI color codes for terminal output
const colors = {
  dim: '\x1b[38;5;240m',
  yellow: '\x1b[38;5;214m',
  red: '\x1b[38;5;196m',
  green: '\x1b[38;5;46m',
  cyan: '\x1b[38;5;81m',
  magenta: '\x1b[38;5;198m',
  reset: '\x1b[0m',
};

/**
 * Displays a diff-like preview of a proposed file edit.
 */
export function displayEditPreview(filePath: string, targetCode: string, replacementCode: string): void {
  console.log('');
  console.log(`${colors.dim}╭─────────────────────────────────────────────────────────────╮${colors.reset}`);
  console.log(`${colors.dim}│${colors.reset} ${colors.yellow}🔧 PROPOSED FILE EDIT${colors.reset}                                       ${colors.dim}│${colors.reset}`);
  console.log(`${colors.dim}├─────────────────────────────────────────────────────────────┤${colors.reset}`);
  console.log(`${colors.dim}│${colors.reset} ${colors.cyan}File:${colors.reset} ${filePath.padEnd(52)}${colors.dim}│${colors.reset}`);
  console.log(`${colors.dim}├─────────────────────────────────────────────────────────────┤${colors.reset}`);
  console.log(`${colors.dim}│${colors.reset} ${colors.red}─── REMOVE ───${colors.reset}                                             ${colors.dim}│${colors.reset}`);
  console.log(`${colors.dim}╰─────────────────────────────────────────────────────────────╯${colors.reset}`);
  
  // Display target code with red highlighting
  const targetLines = targetCode.split('\n');
  for (const line of targetLines) {
    console.log(`${colors.red}- ${line}${colors.reset}`);
  }
  
  console.log(`${colors.dim}╭─────────────────────────────────────────────────────────────╮${colors.reset}`);
  console.log(`${colors.dim}│${colors.reset} ${colors.green}+++ ADD +++${colors.reset}                                                ${colors.dim}│${colors.reset}`);
  console.log(`${colors.dim}╰─────────────────────────────────────────────────────────────╯${colors.reset}`);
  
  // Display replacement code with green highlighting
  const replacementLines = replacementCode.split('\n');
  for (const line of replacementLines) {
    console.log(`${colors.green}+ ${line}${colors.reset}`);
  }
  
  console.log('');
}

/**
 * Displays a command preview before execution.
 */
export function displayCommandPreview(command: string): void {
  console.log('');
  console.log(`${colors.dim}╭─────────────────────────────────────────────────────────────╮${colors.reset}`);
  console.log(`${colors.dim}│${colors.reset} ${colors.yellow}⚡ PROPOSED COMMAND EXECUTION${colors.reset}                              ${colors.dim}│${colors.reset}`);
  console.log(`${colors.dim}├─────────────────────────────────────────────────────────────┤${colors.reset}`);
  console.log(`${colors.dim}│${colors.reset} ${colors.magenta}$${colors.reset} ${command.slice(0, 58).padEnd(58)}${colors.dim}│${colors.reset}`);
  
  // Handle long commands
  if (command.length > 58) {
    const remaining = command.slice(58);
    const chunks = remaining.match(/.{1,60}/g) || [];
    for (const chunk of chunks) {
      console.log(`${colors.dim}│${colors.reset}   ${chunk.padEnd(58)}${colors.dim}│${colors.reset}`);
    }
  }
  
  console.log(`${colors.dim}╰─────────────────────────────────────────────────────────────╯${colors.reset}`);
  console.log('');
}

/**
 * Asks user for confirmation before applying a file edit.
 * Returns true if user approves, false if denied.
 */
export async function confirmFileEdit(filePath: string, targetCode: string, replacementCode: string): Promise<boolean> {
  displayEditPreview(filePath, targetCode, replacementCode);
  
  const confirmed = await p.confirm({
    message: `Apply this patch to ${filePath}?`,
    initialValue: false,
  });
  
  if (p.isCancel(confirmed)) {
    return false;
  }
  
  return confirmed === true;
}

/**
 * Asks user for confirmation before executing a command.
 * Returns true if user approves, false if denied.
 */
export async function confirmCommandExecution(command: string): Promise<boolean> {
  displayCommandPreview(command);
  
  const confirmed = await p.confirm({
    message: 'Execute this command?',
    initialValue: false,
  });
  
  if (p.isCancel(confirmed)) {
    return false;
  }
  
  return confirmed === true;
}
