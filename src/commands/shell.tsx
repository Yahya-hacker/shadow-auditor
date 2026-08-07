import { Command, Flags } from '@oclif/core';
import { render } from 'ink';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import React from 'react';

import App from '../ui/App.js';
import { loadConfig } from '../utils/config.js';

export default class Shell extends Command {
  static override description = 'Local Shadow Auditor client for a remote private backend';
  static override examples = [
    '<%= config.bin %>',
    '<%= config.bin %> --reconfigure',
    '<%= config.bin %> --mode bounty',
    '<%= config.bin %> --ci --objective "Audit changed authentication code" --fail-on high',
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
      description: 'Permit broader local execution of backend-proposed commands with explicit approval',
    }),
    'fail-on': Flags.option({
      default: 'high' as const,
      description: 'Minimum severity that causes a non-zero exit in CI mode',
      options: ['critical', 'high', 'medium', 'low', 'none'] as const,
    })(),
    mode: Flags.option({
      default: 'audit' as const,
      description: 'Remote audit objective: audit, bounty, or ctf',
      options: ['audit', 'bounty', 'ctf'] as const,
    })(),
    objective: Flags.string({
      description: 'Security audit objective. Required in non-interactive CI mode.',
    }),
    reconfigure: Flags.boolean({
      char: 'r',
      default: false,
      description: 'Enroll with a different backend or device',
    }),
    since: Flags.string({
      description: 'Git ref for incremental scan base (used with --diff). Defaults to HEAD~1.',
    }),
    target: Flags.string({
      description: 'Repository directory. Defaults to the current working directory in CI mode.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Shell);

    if (flags.ci) {
      if (flags.reconfigure) {
        this.error('--reconfigure cannot be used with --ci', { exit: 2 });
      }

      if (!flags.objective?.trim()) {
        this.error('--objective is required with --ci', { exit: 2 });
      }

      if (!(await loadConfig())) {
        this.error('No valid backend configuration found. Run shadow-auditor --reconfigure interactively first.', {
          exit: 2,
        });
      }

      const target = path.resolve(flags.target ?? process.cwd());
      try {
        if (!(await fs.stat(target)).isDirectory()) throw new Error('not a directory');
      } catch {
        this.error(`CI target is not a readable directory: ${target}`, { exit: 2 });
      }
    } else {
      console.clear();
    }

    const { waitUntilExit } = render(
      <App
        ciEnabled={flags.ci}
        diffEnabled={flags.diff}
        expertUnsafe={flags.expertUnsafe}
        failOn={flags['fail-on']}
        forceReconfigure={flags.reconfigure}
        initialObjective={flags.objective}
        initialTarget={flags.target ?? (flags.ci ? process.cwd() : undefined)}
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
