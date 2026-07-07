import { Command, Flags } from '@oclif/core';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import React from 'react';

import App from '../ui/App.js';
import { loadConfig, registerSecretStoreAdapter } from '../utils/config.js';
import { KeychainAdapter } from '../utils/keychain.js';

export default class Shell extends Command {
  static override description = 'Shadow Auditor — Autonomous AI-Powered SAST Interactive Shell';
  static override examples = [
    '<%= config.bin %>',
    '<%= config.bin %> --reconfigure',
    '<%= config.bin %> --mode triage',
    '<%= config.bin %> --ci --fail-on high',
    '<%= config.bin %> --since HEAD~5',
    '<%= config.bin %> --swarm',
  ];
  static override flags = {
    ci: Flags.boolean({
      default: false,
      description: 'Enable CI mode: produce deterministic machine outputs and exit non-zero on severity threshold',
    }),
    diff: Flags.boolean({
      default: false,
      description: 'Incremental scan: scope analysis to files changed since --since ref (default: HEAD~1)',
    }),
    expertUnsafe: Flags.boolean({
      default: false,
      description: 'Permit broader command and MCP tool execution surface with explicit warnings',
    }),
    'fail-on': Flags.option({
      default: 'high' as const,
      description: 'Minimum severity that causes a non-zero exit in CI mode',
      options: ['critical', 'high', 'medium', 'low', 'none'] as const,
    })(),
    mode: Flags.option({
      description: 'Audit mode controlling depth, tool budget, and report style',
      options: ['triage', 'deep-sast', 'full-report', 'patch-only', 'balanced', 'deep', 'quick'] as const,
    })(),
    reconfigure: Flags.boolean({
      char: 'r',
      default: false,
      description: 'Force the configuration wizard to run again',
    }),
    since: Flags.string({
      description: 'Git ref for incremental scan base (used with --diff). Defaults to HEAD~1.',
    }),
    swarm: Flags.boolean({
      default: false,
      description: 'Enable multi-agent swarm mode for parallel security analysis',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Shell);

    // ── Production error handlers ───────────────────────────────────
    process.on('unhandledRejection', (reason) => {
      process.stderr.write(`[ShadowAuditor] FATAL: Unhandled rejection: ${reason}\n`);
      process.exit(1);
    });
    process.on('uncaughtException', (error) => {
      process.stderr.write(`[ShadowAuditor] FATAL: Uncaught exception: ${error.message}\n`);
      if (error.stack) process.stderr.write(`${error.stack}\n`);
      process.exit(1);
    });

    registerSecretStoreAdapter(new KeychainAdapter());

    let config: import('../utils/config.js').ShadowConfig | null = null;
    if (!flags.reconfigure) {
      config = await loadConfig();
    }

    // ── SIGINT handler — ensure clean exit ──────────────────────────
    let exiting = false;
    process.on('SIGINT', () => {
      if (exiting) return;
      exiting = true;
      process.stdout.write('\n');
      process.exit(0);
    });

    // ── OpenTUI renderer replaces Ink's render() ────────────────────
    const renderer = await createCliRenderer();
    const root = createRoot(renderer);
    root.render(
      <App
        ciEnabled={flags.ci}
        config={config}
        diffEnabled={flags.diff}
        expertUnsafe={flags.expertUnsafe}
        failOn={flags['fail-on']}
        mode={flags.mode}
        needsSetup={!config || flags.reconfigure}
        since={flags.since}
      />,
    );

    // Keep the process alive — OpenTUI manages its own event loop.
    // Exit on Ctrl+C is handled natively by the terminal.
    await new Promise<void>(() => {
      // Never resolves — the renderer owns the process lifecycle.
    });
  }
}
