import { exec, spawn } from 'node:child_process';
import { constants as fsConstants, realpathSync } from 'node:fs';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

import type { HumanInteractionService } from '../../utils/human-in-loop.js';

import {
  type CommandPolicyConfig,
  evaluateCommandPolicy,
  hardenAllowedCommand,
} from '../policy/command-policy.js';

const execAsync = promisify(exec);
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

interface CommandResult {
  stderr: string;
  stdout: string;
}

function parsePipeline(command: string): string[][] {
  const pipeline: string[][] = [];
  let args: string[] = [];
  let token = '';
  let tokenStarted = false;
  let quote: "'" | '"' | null = null;

  const pushToken = () => {
    if (tokenStarted) {
      args.push(token);
      token = '';
      tokenStarted = false;
    }
  };

  const pushStage = () => {
    pushToken();
    if (args.length === 0) throw new Error('Command contains an empty pipeline stage.');
    pipeline.push(args);
    args = [];
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (character === '\\' && quote !== "'") {
      const next = command[index + 1];
      if (next === undefined) throw new Error('Command contains a dangling escape.');
      token += next;
      tokenStarted = true;
      index++;

      continue;
    }

    if (character === "'" || character === '"') {
      if (quote === character) quote = null;
      else if (quote === null) {
        quote = character;
        tokenStarted = true;
      }
      else token += character;
      continue;
    }

    if (quote === null && character === '|') {
      pushStage();
      continue;
    }

    if (quote === null && /\s/.test(character)) {
      pushToken();
      continue;
    }

    token += character;
    tokenStarted = true;
  }

  if (quote !== null) throw new Error('Command contains an unterminated quote.');
  pushStage();
  return pipeline;
}

function hardenPipelineStage(stage: string[]): string[] {
  if (
    stage[0]?.toLowerCase() === 'git' &&
    ['diff', 'log'].includes(stage[1]?.toLowerCase() ?? '')
  ) {
    const arguments_ = stage.slice(2);
    if (arguments_.some((argument) => /^--(?:ext|textc)/i.test(argument))) {
      throw new Error('External Git diff and text-conversion options are not accepted in safe command mode.');
    }

    if (arguments_.some((argument) => /^--ou/i.test(argument))) {
      throw new Error('Git output-file options are not accepted in safe command mode.');
    }

    if (arguments_.some((argument) => /^--show-s/i.test(argument) || argument.includes('%G'))) {
      throw new Error('Git signature-verification options are not accepted in safe command mode.');
    }

    const separatorIndex = arguments_.indexOf('--');
    const insertionIndex = separatorIndex === -1 ? arguments_.length : separatorIndex;
    const hardeningArguments = stage[1]!.toLowerCase() === 'log'
      ? ['--no-ext-diff', '--no-textconv', '--no-show-signature', '--no-use-mailmap']
      : ['--no-ext-diff', '--no-textconv'];
    return [
      stage[0],
      stage[1]!,
      ...arguments_.slice(0, insertionIndex),
      ...hardeningArguments,
      ...arguments_.slice(insertionIndex),
    ];
  }

  return stage;
}

function serializeParsedPipeline(stages: string[][]): string {
  return stages.map((stage) => [
    stage[0],
    ...stage.slice(1).map((argument) =>
      /^[\w./:=+@%,-]+$/u.test(argument) ? argument : JSON.stringify(argument)
    ),
  ].join(' ')).join(' | ');
}

function validateParsedStages(stages: string[][]): string | undefined {
  for (const [executable = '', ...args] of stages) {
    const normalizedExecutable = executable.toLowerCase();
    if (
      normalizedExecutable === 'find' &&
      args.some((argument) =>
        /^-(?:exec|execdir|ok|okdir|delete|files0-from|fls|fprint|fprint0|fprintf)(?:=|$)/i.test(argument) ||
        /^-[HLP]$/.test(argument)
      )
    ) {
      return '[POLICY_DENIED] find executable, mutating, file-writing, and link-following actions are not allowed.';
    }

    if (
      normalizedExecutable === 'rg' &&
      args.some((argument) => /^(?:-L|--follow|--pre(?:-glob)?)(?:=|$)/i.test(argument))
    ) {
      return '[POLICY_DENIED] Ripgrep preprocessors and link-following options are not allowed.';
    }

    if (process.platform === 'win32' && ['find', 'printf'].includes(normalizedExecutable)) {
      return `[POLICY_DENIED] ${executable} is not supported by safe command mode on Windows.`;
    }
  }
}

function safePathEntries(workingDirectory: string): string[] {
  const resolvedWorkingDirectory = canonicalPath(workingDirectory);
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (!entry || !path.isAbsolute(entry)) return false;
      try {
        return !isPathWithin(canonicalPath(entry), resolvedWorkingDirectory);
      } catch {
        return false;
      }
    });
}

function canonicalPath(candidate: string): string {
  const resolved = realpathSync.native(candidate);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathWithin(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

async function resolveTrustedExecutable(
  executable: string,
  workingDirectory: string,
): Promise<string> {
  if (path.basename(executable) !== executable) {
    throw new Error('Executable paths are not accepted in safe command mode.');
  }

  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.COM').split(';')
    : [''];
  for (const directory of safePathEntries(workingDirectory)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${executable}${extension}`);
      try {
        await access(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
        if (process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(candidate)) continue;
        const canonicalCandidate = canonicalPath(candidate);
        if (isPathWithin(canonicalCandidate, canonicalPath(workingDirectory))) continue;
        return canonicalCandidate;
      } catch {
        // Continue searching trusted PATH entries.
      }
    }
  }

  throw new Error(`Executable "${executable}" was not found in trusted PATH entries.`);
}

function collectStream(
  stream: NodeJS.ReadableStream,
  onLimit: () => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_OUTPUT_BYTES) {
        onLimit();
        reject(new Error(`Command output exceeded ${MAX_OUTPUT_BYTES} bytes.`));
        return;
      }

      chunks.push(buffer);
    });
    stream.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.once('error', reject);
  });
}

async function executeSafePipeline(
  parsedStages: string[][],
  options: {
    abortSignal?: AbortSignal;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    workingDirectory: string;
  },
): Promise<CommandResult> {
  const stages = parsedStages.map((stage) => hardenPipelineStage(stage));
  const resolvedStages = await Promise.all(stages.map(async ([executable, ...args]) => {
    if (process.platform === 'win32' && executable!.toLowerCase() === 'echo') {
      return {
        args: [
          '-e',
          'process.stdout.write(process.argv.slice(1).join(" ")+String.fromCharCode(10))',
          ...args,
        ],
        executable: process.execPath,
      };
    }

    return {
      args,
      executable: await resolveTrustedExecutable(executable!, options.workingDirectory),
    };
  }));
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => timeoutController.abort(new Error(`Command timed out after ${options.timeoutMs}ms.`)),
    options.timeoutMs,
  );
  timeout.unref?.();
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, timeoutController.signal])
    : timeoutController.signal;
  const children = resolvedStages.map((stage) => spawn(stage.executable, stage.args, {
    cwd: options.workingDirectory,
    env: options.env,
    shell: false,
    signal,
    stdio: ['pipe', 'pipe', 'pipe'],
  }));
  const expectedPipeTerminations = new Set<number>();
  const pipeErrors: Error[] = [];

  try {
    for (let index = 0; index < children.length - 1; index++) {
      const destination = children[index + 1]!.stdin;
      destination.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EPIPE') {
          expectedPipeTerminations.add(index);
          children[index]!.kill();
          return;
        }

        pipeErrors.push(error);
        children[index]!.kill();
      });
      children[index]!.stdout.pipe(destination);
    }

    children[0]!.stdin.end();
    const terminate = () => {
      for (const child of children) child.kill();
    };

    const stdoutPromise = collectStream(children.at(-1)!.stdout, terminate);
    const stderrPromises = children.map((child) => collectStream(child.stderr, terminate));
    const statusesPromise = Promise.all(children.map((child) => new Promise<{
      code: null | number;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, childSignal) => resolve({code, signal: childSignal}));
    })));
    const [[stdout, stderrParts], statuses] = await Promise.all([
      Promise.all([stdoutPromise, Promise.all(stderrPromises)]),
      statusesPromise,
    ]);
    const stderr = stderrParts.filter(Boolean).join('\n');
    if (pipeErrors[0]) {
      throw pipeErrors[0];
    }

    const unexpectedFailedStage = statuses.findIndex(
      (status, index) => {
        if (status.code === 0) return false;
        const expectedTermination = expectedPipeTerminations.has(index) &&
          status.signal === 'SIGTERM' &&
          stderrParts[index]!.trim().length === 0;
        return !expectedTermination;
      },
    );
    if (unexpectedFailedStage !== -1) {
      const status = statuses[unexpectedFailedStage]!;
      const statusDescription = status.code === null ?
        `signal ${status.signal ?? 'unknown'}` :
        `code ${status.code}`;
      const error = new Error(
        `Pipeline stage ${unexpectedFailedStage + 1} exited with ${statusDescription}.`,
      ) as CommandResult & Error;
      error.stdout = stdout;
      error.stderr = stderr;
      throw error;
    }

    return {stderr, stdout};
  } finally {
    clearTimeout(timeout);
  }
}

function executionEnvironment(workingDirectory: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '7',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_KEY_1: 'core.hooksPath',
    GIT_CONFIG_KEY_2: 'log.showSignature',
    GIT_CONFIG_KEY_3: 'gpg.format',
    GIT_CONFIG_KEY_4: 'gpg.program',
    GIT_CONFIG_KEY_5: 'gpg.openpgp.program',
    GIT_CONFIG_KEY_6: 'mailmap.file',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_VALUE_1: os.devNull,
    GIT_CONFIG_VALUE_2: 'false',
    GIT_CONFIG_VALUE_3: 'openpgp',
    GIT_CONFIG_VALUE_4: os.devNull,
    GIT_CONFIG_VALUE_5: os.devNull,
    GIT_CONFIG_VALUE_6: os.devNull,
    GIT_PAGER: 'cat',
    NoDefaultCurrentDirectoryInExePath: '1',
    PAGER: 'cat',
    PATH: safePathEntries(workingDirectory).join(path.delimiter),
    RIPGREP_CONFIG_PATH: os.devNull,
  };
}

export interface ExecuteCommandToolOptions {
  commandPolicy: CommandPolicyConfig;
  humanInteraction: HumanInteractionService;
  workingDirectory: string;
}

export function createExecuteCommandTool(options: ExecuteCommandToolOptions) {
  return {
    description:
      'Run a confirmed, policy-gated repository discovery command with rg, find, or read-only Git. ' +
      'Commands execute on the host. Direct shell file reads, lifecycle scripts, programmable processors, ' +
      'host paths, parent traversal, and link-following options are denied unless expert unsafe mode is enabled. ' +
      'Prefer PathGuard-backed list_directory, search_codebase, and read_file_content.',
    async execute(
      { command, timeout = 30 }: { command: string; timeout?: number },
      executionOptions?: { abortSignal?: AbortSignal },
    ) {
      executionOptions?.abortSignal?.throwIfAborted();
      const policyDecision = evaluateCommandPolicy(command, options.commandPolicy);
      if (!policyDecision.allowed) {
        return policyDecision.reason;
      }

      let parsedStages: string[][] | undefined;
      if (!options.commandPolicy.expertUnsafe) {
        try {
          parsedStages = parsePipeline(command);
        } catch (error) {
          return `[DENIED] ${(error as Error).message}`;
        }

        const parsedDecision = evaluateCommandPolicy(
          serializeParsedPipeline(parsedStages),
          options.commandPolicy,
        );
        if (!parsedDecision.allowed) {
          return parsedDecision.reason;
        }

        const parsedStageDenial = validateParsedStages(parsedStages);
        if (parsedStageDenial) {
          return parsedStageDenial;
        }
      }

      // Request human confirmation. In LangGraph context this throws a Command
      // (interrupting the graph at HumanIntervention). On resume, the tool is
      // called again and this returns true. In non-LangGraph context (Vercel AI
      // SDK swarm mode), returns the blocking confirmation result.
      const confirmed = await options.humanInteraction.confirmCommandExecution(command, policyDecision.warning);
      if (!confirmed) {
        return `[DENIED] User denied command execution: "${command}".`;
      }

      try {
        const env = executionEnvironment(options.workingDirectory);
        const {stderr, stdout} = options.commandPolicy.expertUnsafe
          ? await execAsync(hardenAllowedCommand(command), {
              cwd: options.workingDirectory,
              env,
              maxBuffer: MAX_OUTPUT_BYTES,
              signal: executionOptions?.abortSignal,
              timeout: timeout * 1000,
            })
          : await executeSafePipeline(parsedStages!, {
              abortSignal: executionOptions?.abortSignal,
              env,
              timeoutMs: timeout * 1000,
              workingDirectory: options.workingDirectory,
            });

        const sections: string[] = [];
        if (stdout.trim()) {
          sections.push(stdout.trim());
        }

        if (stderr.trim()) {
          sections.push(`[STDERR]\n${stderr.trim()}`);
        }

        if (!stdout.trim() && !stderr.trim()) {
          sections.push('[INFO] Command completed with no output.');
        }

        return sections.join('\n\n');
      } catch (error: unknown) {
        executionOptions?.abortSignal?.throwIfAborted();
        const execError = error as { message: string; stderr?: string; stdout?: string };
        let output = `[ERROR] Command failed: ${execError.message}`;
        const stdoutTrimmed = execError.stdout?.trim() ?? '';
        if (stdoutTrimmed) {
          output += `\n\n[STDOUT]\n${stdoutTrimmed}`;
        }

        const stderrTrimmed = execError.stderr?.trim() ?? '';
        if (stderrTrimmed) {
          output += `\n\n[STDERR]\n${stderrTrimmed}`;
        }

        return output;
      }
    },
    inputSchema: z.object({
      command: z
        .string()
        .min(1, 'Command cannot be empty.')
        .max(2000, 'Command exceeds maximum length of 2000 characters.')
        .describe('Policy-gated repository discovery command.'),
      timeout: z.number().int().positive().max(120).optional(),
    }),
  };
}
