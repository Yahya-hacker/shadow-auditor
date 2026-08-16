import { Args, Command, Flags } from '@oclif/core';
import { render } from 'ink';
import React from 'react';

import type { ShadowConfig } from '../utils/config.js';

import { runCiAudit } from '../core/ci-runner.js';
import { App } from '../ui/App.js';
import { buildEffectiveConfig } from '../ui/effective-config.js';
import { disposeActiveAgentSessions, getActiveSessionRunId } from '../ui/hooks/useAgentSession.js';
import { configureShutdown, isShuttingDown, requestShutdown } from '../ui/shutdown.js';
import { loadConfig, registerSecretStoreAdapter } from '../utils/config.js';
import { KeychainAdapter } from '../utils/keychain.js';

interface ShellRuntimeFlags {
  ci?: boolean;
  diff?: boolean;
  'expert-unsafe': boolean;
  'fail-on'?: Parameters<typeof runCiAudit>[0]['failOn'];
  since?: string;
  target?: string;
}

function resolveShellRuntime(
  flags: ShellRuntimeFlags,
  config: null | ShadowConfig,
  argumentTarget?: string,
) {
  return {
    ciEnabled: Boolean(flags.ci || config?.ci?.enabled),
    diffBase: flags.since ?? config?.diff?.baseRef,
    diffEnabled: Boolean(flags.diff || config?.diff?.enabled),
    expertUnsafe: Boolean(flags['expert-unsafe'] || config?.expertUnsafe),
    failOn: flags['fail-on'] ?? config?.ci?.failOn ?? 'high',
    targetPath: argumentTarget ?? flags.target ?? '.',
  };
}

export default class Shell extends Command {
  static override args = {
    target: Args.string({
      description: 'Repository directory to audit (equivalent to --target)',
      required: false,
    }),
  };
  static override description = 'Shadow Auditor — Autonomous AI-Powered SAST Interactive Shell';
  static override examples = [
    '<%= config.bin %>',
    '<%= config.bin %> --reconfigure',
    '<%= config.bin %> --mode triage',
    '<%= config.bin %> --ci --fail-on high',
    '<%= config.bin %> --since HEAD~5',
    '<%= config.bin %> --swarm',
    '<%= config.bin %> --watch',
  ];
  static override flags = {
    ci: Flags.boolean({
      description: 'Enable CI mode: produce deterministic machine outputs and exit non-zero on severity threshold',
    }),
    diff: Flags.boolean({
      description: 'Incremental scan: scope analysis to files changed since --since ref (default: HEAD~1)',
    }),
    'expert-unsafe': Flags.boolean({
      default: false,
      description: 'Permit broader command and MCP tool execution surface with explicit warnings',
    }),
    'fail-on': Flags.option({
      description: 'Minimum severity that causes a non-zero exit in CI mode',
      options: ['critical', 'high', 'medium', 'low', 'info', 'none'] as const,
    })(),
    mode: Flags.option({
      description: 'Audit mode controlling depth, tool budget, and report style',
      options: ['triage', 'deep-sast', 'full-report', 'patch-only', 'balanced', 'deep', 'quick'] as const,
    })(),
    prompt: Flags.string({
      description: 'CI audit mission, or the answer to pending human input when used with --resume-run',
    }),
    reconfigure: Flags.boolean({
      char: 'r',
      default: false,
      description: 'Force the configuration wizard to run again',
    }),
    'resume-run': Flags.string({
      description: 'Reopen an existing run ID and resume its persisted LangGraph checkpoints',
    }),
    since: Flags.string({
      description: 'Git ref for incremental scan base (used with --diff). Defaults to HEAD~1.',
    }),
    swarm: Flags.boolean({
      description: 'Enable multi-agent swarm mode for parallel security analysis',
    }),
    target: Flags.string({
      description: 'Target repository path (defaults to the current directory in CI mode)',
    }),
    watch: Flags.boolean({
      description: 'Monitor source changes and run debounced incremental security audits',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Shell);

    // ── Production error handlers ───────────────────────────────────
    process.on('unhandledRejection', (reason) => {
      process.stderr.write(`[ShadowAuditor] FATAL: Unhandled rejection: ${reason}\n`);
      requestShutdown(1).catch((error: unknown) => {
        process.stderr.write(`[ShadowAuditor] Shutdown failed: ${String(error)}\n`);
      });
    });
    process.on('uncaughtException', (error) => {
      process.stderr.write(`[ShadowAuditor] FATAL: Uncaught exception: ${error.message}\n`);
      if (error.stack) process.stderr.write(`${error.stack}\n`);
      requestShutdown(1).catch((shutdownError: unknown) => {
        process.stderr.write(`[ShadowAuditor] Shutdown failed: ${String(shutdownError)}\n`);
      });
    });

    registerSecretStoreAdapter(new KeychainAdapter());

    let config: null | ShadowConfig = null;
    if (!flags.reconfigure) {
      config = await loadConfig();
    }

    const {
      ciEnabled,
      diffBase,
      diffEnabled,
      expertUnsafe,
      failOn,
      targetPath,
    } = resolveShellRuntime(flags, config, args.target);

    if (ciEnabled) {
      if (!config) {
        this.log(JSON.stringify({
          error: 'CI mode requires an existing configuration. Run the interactive setup first.',
          exit: { code: 2 },
        }));
        process.exitCode = 2;
        return;
      }

      const effectiveConfig = buildEffectiveConfig(config, {
        ciEnabled: true,
        diffBase,
        diffEnabled,
        failOn,
        mode: flags.mode,
        swarmEnabled: flags.swarm,
      });
      try {
        const result = await runCiAudit({
          config: effectiveConfig,
          diffBase,
          diffEnabled,
          expertUnsafe,
          failOn,
          prompt: flags.prompt,
          resumeRunId: flags['resume-run'],
          targetPath,
        });
        this.log(JSON.stringify(result));
        process.exitCode = result.exit.code;
      } catch (error) {
        this.log(JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          exit: { code: 2 },
        }));
        process.exitCode = 2;
      }

      return;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      this.error(
        'Interactive mode requires a TTY. Re-run with --ci for non-interactive execution.',
        { exit: 2 },
      );
    }

    // ── Graceful shutdown handlers ──────────────────────────────────
    // ── Ink render ──────────────────────────────────────────────────
    // Clear the screen so Ink's first frame anchors at the top row; combined
    // with the terminal-height root clamp this prevents ghost/duplicate frames.
    if (process.stdout.isTTY) process.stdout.write('\u001B[2J\u001B[H');
    const instance = render(
      <App
        ciEnabled={flags.ci}
        config={config}
        diffEnabled={diffEnabled}
        expertUnsafe={expertUnsafe}
        failOn={failOn}
        initialTarget={args.target ?? flags.target}
        mode={flags.mode}
        needsSetup={!config || flags.reconfigure}
        resumeRunId={flags['resume-run']}
        since={flags.since}
        swarmEnabled={flags.swarm}
        watchEnabled={flags.watch}
      />,
      {
        // ShellScreen owns Ctrl+C so the first press can cancel an active
        // operation without Ink unmounting App and disposing the session.
        exitOnCtrlC: false,
      },
    );

    // SIGINT (Ctrl-C) is conventionally 128+2 = 130; SIGTERM is 128+15 = 143.
    // Reporting 0 here would mask the abort and make CI think the run succeeded.
    const signalExitCode = (signal: string) => (signal === 'SIGTERM' ? 143 : 130);

    configureShutdown(async (exitCode) => {
      try {
        await disposeActiveAgentSessions();
      } finally {
        instance.unmount();
        process.exitCode = exitCode;
      }
    });

    // First signal starts a graceful shutdown. A *second* signal while the
    // dispose is still in flight forces an immediate hard exit with the signal
    // exit code, so the process can never hang after the user aborts twice.
    let forceExitStarted = false;
    const gracefulShutdown = (signal: string) => {
      const code = signalExitCode(signal);
      if (isShuttingDown()) {
        if (!forceExitStarted) {
          forceExitStarted = true;
          process.stderr.write(`\n[ShadowAuditor] Second ${signal}, forcing exit.\n`);
          process.exit(code);
        }
        return;
      }
      const runId = getActiveSessionRunId();
      process.stderr.write(`\n[ShadowAuditor] Received ${signal}, shutting down...\n`);
      if (runId) {
        process.stderr.write(`[ShadowAuditor] To resume this session, run: shadow-auditor --resume ${runId}\n`);
      }
      void requestShutdown(code).catch(() => undefined);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    // Keep the process alive until Ink unmounts (quit, Ctrl-C, or the app
    // calling exit). waitUntilExit resolves once the tree is unmounted.
    await instance.waitUntilExit();
  }
}
