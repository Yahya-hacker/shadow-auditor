import { Command, Flags } from '@oclif/core';
import { render } from 'ink';
import React from 'react';

import App from '../ui/App.js';

export default class Shell extends Command {
  static override description = 'Shadow Auditor — Autonomous AI-Powered SAST Interactive Shell';
static override examples = [
    '<%= config.bin %>',
    '<%= config.bin %> --reconfigure',
  ];
static override flags = {
    reconfigure: Flags.boolean({
      char: 'r',
      default: false,
      description: 'Force the configuration wizard to run again',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Shell);

    console.clear();

    const { waitUntilExit } = render(<App forceReconfigure={flags.reconfigure} />, {
      exitOnCtrlC: true,
    });

    await waitUntilExit();
  }
}
