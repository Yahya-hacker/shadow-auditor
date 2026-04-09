import { Command, Flags } from '@oclif/core';
import { render } from 'ink';
import React from 'react';

import App from '../ui/App.js';

export default class Shell extends Command {
  static override description = 'Shadow Auditor — Autonomous AI-Powered SAST Interactive Shell';
static override examples = [
    '<%= config.bin %>',
    '<%= config.bin %> --reconfigure',
    '<%= config.bin %> --mode triage',
    '<%= config.bin %> --ci --fail-on high',
    '<%= config.bin %> --since HEAD~5',
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
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Shell);

    console.clear();

    const { waitUntilExit } = render(
      <App
        ciEnabled={flags.ci}
        diffEnabled={flags.diff}
        expertUnsafe={flags.expertUnsafe}
        failOn={flags['fail-on']}
        forceReconfigure={flags.reconfigure}
        mode={flags.mode}
        since={flags.since}
      />,
      {
      exitOnCtrlC: true,
      },
    );

    await waitUntilExit();
  }
}
