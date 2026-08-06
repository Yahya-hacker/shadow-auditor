/**
 * Slash Command Registry — declarative command definitions for the shell.
 *
 * Commands are triggered when the input starts with `/`. The registry
 * provides lookup, alias resolution, and execution dispatch.
 */

import type {
  SuppressionDecision,
  SuppressionListEntry,
} from '../core/memory/false-positive-store.js';

import { requestShutdown } from './shutdown.js';
import { useAppStore } from './store/appStore.js';

export interface CommandContext {
  cancelActiveOperation: () => boolean;
  compactContext: () => Promise<{afterTokens: number; beforeTokens: number}>;
  /** Generate the persisted report artifacts for the active session */
  generateReport: () => Promise<null | {
    jsonPath?: string;
    markdownPath?: string;
    sarifPath?: string;
  }>;
  listSuppressions: () => Promise<SuppressionListEntry[]>;
  /** Add a toast notification */
  notify: (message: string, type?: 'error' | 'info' | 'success' | 'warning') => void;
  revokeSuppression: (suppressionId: string, rationale: string) => Promise<SuppressionDecision>;
  setReasoningEffort: (
    effort: 'high' | 'low' | 'medium' | 'minimal' | 'none' | 'xhigh',
  ) => Promise<void>;
  suppressFinding: (
    findingId: string,
    rationale: string,
    expiresAt?: string,
  ) => Promise<SuppressionDecision>;
}

export interface SlashCommand {
  aliases?: string[];
  description: string;
  execute: (args: string, context: CommandContext) => Promise<void> | void;
  name: string;
}

// ── Command definitions ────────────────────────────────────────────

const helpCommand: SlashCommand = {
  description: 'Toggle the keybinding reference overlay',
  execute() {
    useAppStore.getState().toggleHelp();
  },
  name: '/help',
};

const clearCommand: SlashCommand = {
  aliases: ['/cls'],
  description: 'Clear all message history',
  execute(_args, ctx) {
    useAppStore.getState().clearChat();
    useAppStore.getState().clearActivity();
    ctx.notify('Chat history cleared', 'info');
  },
  name: '/clear',
};

const cancelCommand: SlashCommand = {
  description: 'Cancel the active scan, resume, or compaction operation',
  execute(_args, ctx) {
    if (ctx.cancelActiveOperation()) {
      ctx.notify('Cancelling the active operation...', 'warning');
    } else {
      ctx.notify('There is no active operation to cancel.', 'info');
    }
  },
  name: '/cancel',
};

const reportCommand: SlashCommand = {
  description: 'Export the current findings as Markdown, JSON, and SARIF',
  async execute(_args, ctx) {
    const generated = await ctx.generateReport();
    if (!generated) {
      ctx.notify('The audit session is still initializing; report export is unavailable.', 'warning');
      return;
    }

    const paths = [
      generated.markdownPath,
      generated.jsonPath,
      generated.sarifPath,
    ].filter(Boolean);
    useAppStore.getState().addSystemMessage(
      `Report exported:\n${paths.map((value) => `- ${value}`).join('\n')}`,
    );
    ctx.notify('Report artifacts exported', 'success');
  },
  name: '/report',
};

const compactCommand: SlashCommand = {
  description: 'Summarize and compact the active model context',
  async execute(_args, ctx) {
    const result = await ctx.compactContext();
    const reduction = result.beforeTokens > 0
      ? Math.max(0, Math.round((1 - result.afterTokens / result.beforeTokens) * 100))
      : 0;
    useAppStore.getState().addSystemMessage(
      `Context compacted: ~${result.beforeTokens.toLocaleString()} -> ` +
      `~${result.afterTokens.toLocaleString()} tokens (${reduction}% reduction).`,
    );
    ctx.notify('Context compacted successfully', 'success');
  },
  name: '/compact',
};

const reasoningCommand: SlashCommand = {
  description: 'Set reasoning effort: /reasoning none|minimal|low|medium|high|xhigh',
  async execute(args, ctx) {
    const effort = args.trim().toLowerCase();
    const allowed = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
    if (!allowed.includes(effort as typeof allowed[number])) {
      throw new Error(`Usage: /reasoning ${allowed.join('|')}`);
    }

    await ctx.setReasoningEffort(effort as typeof allowed[number]);
    const state = useAppStore.getState();
    if (state.config) {
      state.setConfig({...state.config, reasoningEffort: effort as typeof allowed[number]});
    }

    state.addSystemMessage(`Reasoning effort is now ${effort}.`);
    ctx.notify(`Reasoning effort set to ${effort}`, 'success');
  },
  name: '/reasoning',
};

const suppressCommand: SlashCommand = {
  description: 'Approve a false positive: /suppress <finding-id> <rationale>',
  async execute(args, ctx) {
    const [findingId, ...reasonParts] = args.trim().split(/\s+/);
    const rationale = reasonParts.join(' ').trim();
    if (!findingId || !rationale) {
      throw new Error('Usage: /suppress <finding-id> <rationale>');
    }

    const decision = await ctx.suppressFinding(findingId, rationale);
    ctx.notify(`Suppression ${decision.id} approved by the current user.`, 'success');
  },
  name: '/suppress',
};

const suppressUntilCommand: SlashCommand = {
  description: 'Approve until expiry: /suppress-until <finding-id> <ISO-date> <rationale>',
  async execute(args, ctx) {
    const [findingId, expiresAt, ...reasonParts] = args.trim().split(/\s+/);
    const rationale = reasonParts.join(' ').trim();
    if (!findingId || !expiresAt || !rationale) {
      throw new Error('Usage: /suppress-until <finding-id> <ISO-date> <rationale>');
    }

    const decision = await ctx.suppressFinding(findingId, rationale, expiresAt);
    ctx.notify(`Suppression ${decision.id} approved until ${decision.expiresAt}.`, 'success');
  },
  name: '/suppress-until',
};

const suppressionsCommand: SlashCommand = {
  description: 'List active, stale, expired, and revoked false-positive decisions',
  async execute(_args, ctx) {
    const entries = await ctx.listSuppressions();
    if (entries.length === 0) {
      ctx.notify('No false-positive decisions are stored.', 'info');
      return;
    }

    useAppStore.getState().addSystemMessage(
      `False-positive memory:\n${entries.map((entry) =>
        `- [${entry.state}] ${entry.id} ${entry.findingId} ${entry.cwe} — ${entry.title}`,
      ).join('\n')}`,
    );
    ctx.notify(
      `${entries.length} false-positive decision(s) loaded.`,
      entries.some((entry) => entry.state === 'stale') ? 'warning' : 'info',
    );
  },
  name: '/suppressions',
};

const unsuppressCommand: SlashCommand = {
  description: 'Revoke a decision: /unsuppress <suppression-id> <rationale>',
  async execute(args, ctx) {
    const [suppressionId, ...reasonParts] = args.trim().split(/\s+/);
    const rationale = reasonParts.join(' ').trim();
    if (!suppressionId || !rationale) {
      throw new Error('Usage: /unsuppress <suppression-id> <rationale>');
    }

    await ctx.revokeSuppression(suppressionId, rationale);
    ctx.notify(`Suppression ${suppressionId} revoked.`, 'success');
  },
  name: '/unsuppress',
};

const settingsCommand: SlashCommand = {
  aliases: ['/config'],
  description: 'Show current configuration settings',
  execute(_args, ctx) {
    const state = useAppStore.getState();
    const cfg = state.config;
    if (!cfg) {
      ctx.notify('No configuration loaded', 'warning');
      return;
    }

    const lines = [
      `Provider: ${cfg.provider}`,
      `Model: ${cfg.model}`,
      `Audit Mode: ${cfg.auditMode ?? 'default'}`,
      `Reasoning: ${cfg.reasoningEffort ?? cfg.azure?.reasoningEffort ?? 'provider default'}`,
      `Auto Compact: ${cfg.contextManagement?.enabled === false ? 'disabled' : `at ${Math.round((cfg.contextManagement?.compactAt ?? 0.7) * 100)}%`}`,
      `Indexing: ${cfg.indexing?.enabled ? 'enabled' : 'disabled'}`,
      cfg.auditMode ? `Expert Unsafe: ${cfg.expertUnsafe ? 'yes' : 'no'}` : null,
    ].filter(Boolean);
    state.addSystemMessage(`Current settings:\n${lines.join('\n')}`);
  },
  name: '/settings',
};

const findingsCommand: SlashCommand = {
  description: 'Filter output to show only vulnerability findings',
  execute(_args, ctx) {
    const state = useAppStore.getState();
    // Disable all filters except findings-related ones
    const newFilters: Record<string, boolean> = {
      'agent': true,
      'all': false,
      'errors': false,
      'findings': true,
      'system': false,
      'user': false,
    };
    for (const [key, val] of Object.entries(newFilters)) {
      state.setFilter(key, val);
    }

    ctx.notify('Showing findings only', 'info');
  },
  name: '/findings',
};

const historyCommand: SlashCommand = {
  description: 'Switch to the session history screen',
  execute() {
    useAppStore.getState().setScreen('history');
  },
  name: '/history',
};

const toolsCommand: SlashCommand = {
  description: 'Configure agent tools and safety budgets',
  execute() {
    useAppStore.getState().setScreen('tools');
  },
  name: '/tools',
};

const quitCommand: SlashCommand = {
  aliases: ['/exit', '/q'],
  description: 'Gracefully exit Shadow Auditor',
  async execute(_args, ctx) {
    ctx.notify('Exiting Shadow Auditor...', 'info');
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
    await requestShutdown();
  },
  name: '/quit',
};

// ── Registry ───────────────────────────────────────────────────────

export const slashCommands: SlashCommand[] = [
  helpCommand,
  cancelCommand,
  clearCommand,
  compactCommand,
  reportCommand,
  reasoningCommand,
  suppressCommand,
  suppressUntilCommand,
  suppressionsCommand,
  unsuppressCommand,
  settingsCommand,
  findingsCommand,
  historyCommand,
  toolsCommand,
  quitCommand,
];

/**
 * Look up a command by name or alias. Returns undefined if no match.
 */
export function findCommand(input: string): SlashCommand | undefined {
  const trimmed = input.trim().toLowerCase();
  return slashCommands.find(
    (cmd) => cmd.name === trimmed || cmd.aliases?.includes(trimmed),
  );
}

/**
 * Get command suggestions matching a partial input (for autocomplete).
 * Returns commands whose name or aliases start with the given prefix.
 */
export function getCommandSuggestions(prefix: string): SlashCommand[] {
  const lower = prefix.trim().toLowerCase();
  if (!lower.startsWith('/')) return [];
  return slashCommands.filter(
    (cmd) =>
      cmd.name.startsWith(lower) ||
      cmd.aliases?.some((alias) => alias.startsWith(lower)),
  );
}

/**
 * Execute a slash command string (e.g. "/help" or "/report --full").
 * Returns true if a command was matched and executed.
 */
export async function executeSlashCommand(input: string, context: CommandContext): Promise<boolean> {
  const trimmed = input.trim();
  const parts = trimmed.split(/\s+/);
  const cmdName = parts[0]?.toLowerCase() ?? '';
  const args = parts.slice(1).join(' ');

  const cmd = slashCommands.find(
    (c) => c.name === cmdName || c.aliases?.includes(cmdName),
  );
  if (!cmd) return false;

  await cmd.execute(args, context);
  return true;
}
