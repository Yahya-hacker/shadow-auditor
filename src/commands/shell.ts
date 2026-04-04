import { Command, Flags } from '@oclif/core';
import * as p from '@clack/prompts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AgentSession } from '../core/agent.js';
import { animateBootUp, bootSequence } from '../utils/boot.js';
import { loadConfig } from '../utils/config.js';
import { generateRepoMap } from '../utils/repo-map.js';
import { runSetupWizard } from '../utils/setup.js';

// Graceful shutdown message
function printGoodbye(): void {
  console.log('');
  console.log('  \x1b[38;5;240m─────────────────────────────────────────────────────────────\x1b[0m');
  console.log('  \x1b[38;5;214m🏴 Shadow Auditor\x1b[0m \x1b[38;5;245m— Session terminated. Stay dangerous.\x1b[0m');
  console.log('  \x1b[38;5;240m─────────────────────────────────────────────────────────────\x1b[0m');
  console.log('');
}

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

    // ─── Graceful SIGINT Handling ─────────────────────────────────────────
    let isShuttingDown = false;
    
    const handleSigint = (): void => {
      if (isShuttingDown) {
        // Force exit on second Ctrl+C
        process.exit(0);
      }
      isShuttingDown = true;
      printGoodbye();
      process.exit(0);
    };
    
    process.on('SIGINT', handleSigint);
    process.on('SIGTERM', handleSigint);

    // ─── Theatrical Boot Animation ────────────────────────────────────────
    await animateBootUp(bootSequence);

    // ─── Configuration Check & Onboarding ─────────────────────────────────
    let config = flags.reconfigure ? null : await loadConfig();

    if (!config) {
      config = await runSetupWizard(flags.reconfigure);
      console.log('');
    } else {
      console.log(`  \x1b[38;5;245m🔑 Config loaded from ~/.shadow-auditor.json\x1b[0m`);
    }

    console.log(`  \x1b[38;5;81m🤖 Provider:\x1b[0m ${config.provider}`);
    console.log(`  \x1b[38;5;81m🧠 Model:\x1b[0m    ${config.model}`);
    console.log('');

    // ─── Interactive Target Selection ─────────────────────────────────────
    const targetInput = await p.text({
      message: 'Which directory would you like to audit?',
      placeholder: '.',
      defaultValue: '.',
      validate: (value: string | undefined) => {
        if (!value || !value.trim()) return 'Please enter a directory path.';
      },
    });

    if (p.isCancel(targetInput)) {
      console.log('\n  \x1b[38;5;245m👋 Goodbye.\x1b[0m\n');
      process.exit(0);
    }

    const targetPath = path.resolve(targetInput as string);

    // Validate target path
    try {
      const stat = await fs.stat(targetPath);
      if (!stat.isDirectory()) {
        this.error(`Target path is not a directory: ${targetPath}`);
      }
    } catch {
      this.error(`Target path does not exist: ${targetPath}`);
    }

    console.log(`  \x1b[38;5;81m🎯 Target:\x1b[0m   ${targetPath}`);
    console.log('');

    // ─── Generate Repo Map (with spinner) ─────────────────────────────────
    const s = p.spinner();
    s.start('\x1b[38;5;214m🔬 Parsing AST with tree-sitter...\x1b[0m');

    let repoMap: string;
    try {
      repoMap = await generateRepoMap(targetPath);
    } catch (error) {
      s.stop('\x1b[38;5;196m❌ AST parsing failed\x1b[0m');
      this.error(`Failed to generate repo map: ${(error as Error).message}`);
      return;
    }

    const fileCount = (repoMap.match(/^\/\/ ─── /gm) || []).length - 1;
    s.stop(`\x1b[38;5;46m✅ Repo Map generated — ${fileCount > 0 ? fileCount : 0} files indexed\x1b[0m`);
    console.log('');

    // ─── Initialize Agent Session ─────────────────────────────────────────
    s.start('\x1b[38;5;214m🧠 Initializing agent session...\x1b[0m');

    let session: AgentSession;
    try {
      session = new AgentSession(config, repoMap, targetPath);
    } catch (error) {
      s.stop('\x1b[38;5;196m❌ Agent initialization failed\x1b[0m');
      this.error(`Failed to initialize agent: ${(error as Error).message}`);
      return;
    }

    s.stop('\x1b[38;5;46m✅ Agent ready — entering interactive shell\x1b[0m');
    console.log('');
    console.log('  \x1b[38;5;240m╔══════════════════════════════════════════════════════════════╗\x1b[0m');
    console.log('  \x1b[38;5;240m║\x1b[0m  \x1b[38;5;214mSHADOW AUDITOR\x1b[0m :: \x1b[38;5;245mInteractive Security Analysis Shell\x1b[0m       \x1b[38;5;240m║\x1b[0m');
    console.log('  \x1b[38;5;240m║\x1b[0m                                                            \x1b[38;5;240m║\x1b[0m');
    console.log('  \x1b[38;5;240m║\x1b[0m  \x1b[38;5;245mTry:\x1b[0m "Analyze the authentication flow"                    \x1b[38;5;240m║\x1b[0m');
    console.log('  \x1b[38;5;240m║\x1b[0m       "Find all injection vulnerabilities"                \x1b[38;5;240m║\x1b[0m');
    console.log('  \x1b[38;5;240m║\x1b[0m       "Full audit" — for comprehensive SAST scan          \x1b[38;5;240m║\x1b[0m');
    console.log('  \x1b[38;5;240m║\x1b[0m       "exit" or Ctrl+C — to leave the shell               \x1b[38;5;240m║\x1b[0m');
    console.log('  \x1b[38;5;240m╚══════════════════════════════════════════════════════════════╝\x1b[0m');
    console.log('');

    // ─── Interactive REPL ─────────────────────────────────────────────────
    while (true) {
      const input = await p.text({
        message: '\x1b[38;5;198mShadow Auditor ❯\x1b[0m',
        placeholder: 'Enter a command...',
      });

      // Handle Cancel / Ctrl+C
      if (p.isCancel(input)) {
        printGoodbye();
        process.exit(0);
      }

      const trimmed = (input as string).trim();

      // Skip empty inputs
      if (!trimmed) continue;

      // Exit commands
      if (['exit', 'quit', ':q', ':quit'].includes(trimmed.toLowerCase())) {
        printGoodbye();
        break;
      }

      // Stream the agent's response
      console.log('');
      process.stdout.write('  \x1b[38;5;81m');

      try {
        await session.sendMessage(trimmed, (chunk: string) => {
          process.stdout.write(chunk);
        });
      } catch (error) {
        const errMsg = (error as Error).message;
        console.log('');
        if (errMsg.includes('API key') || errMsg.includes('401') || errMsg.includes('authentication')) {
          console.log(`  \x1b[38;5;196m❌ Authentication failed.\x1b[0m Run again with \x1b[38;5;214m--reconfigure\x1b[0m to update your API key.`);
        } else {
          console.log(`  \x1b[38;5;196m❌ Error:\x1b[0m ${errMsg}`);
        }
      }

      process.stdout.write('\x1b[0m\n\n');
    }
  }
}
