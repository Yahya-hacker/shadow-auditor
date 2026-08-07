import { Box, Static, Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import React, { useEffect, useRef, useState } from 'react';

import { computeCiExitCode, type FailOnSeverity, formatCiSummary } from '../core/output/ci-exit.js';
import { securityReportSchema } from '../core/output/report-schema.js';
import { RemoteApiClient } from '../core/remote/api-client.js';
import {
  type AgentRuntime,
  RemoteAgentSession,
  type StreamActivity,
  type ToolApprovalRequest,
} from '../core/remote/runtime.js';
import { AsciiMotionCli } from '../utils/ascii-motion-cli.js';
import { type AuditMode, loadConfig, saveConfig, type ShadowConfig } from '../utils/config.js';
import { generateRepoMap } from '../utils/repo-map.js';

const CLIENT_VERSION = '1.0.0';
const MAX_ACTIVITY_EVENTS = 40;

type AppState =
  | 'booting'
  | 'enrolling'
  | 'initializing'
  | 'loading'
  | 'setup-backend'
  | 'setup-code'
  | 'setup-device'
  | 'shell'
  | 'target-selection';

interface Message {
  id: string;
  role: 'agent' | 'error' | 'system' | 'user';
  text: string;
}

interface ActivityLine {
  id: number;
  text: string;
  type: StreamActivity['type'];
}

interface PendingApproval extends ToolApprovalRequest {
  resolve: (approved: boolean) => void;
}

function formatActivity(activity: StreamActivity): string {
  const tool = activity.toolName ? ` [${activity.toolName}]` : '';
  const detail = activity.detail ? `: ${activity.detail}` : '';
  return `${activity.content}${tool}${detail}`;
}

function defaultConfig(
  backendUrl: string,
  credentialAccount: string,
  deviceName: string,
  options: {
    ciEnabled?: boolean;
    diffEnabled?: boolean;
    expertUnsafe: boolean;
    failOn?: string;
    mode?: string;
    since?: string;
  },
): ShadowConfig {
  const auditMode: AuditMode =
    options.mode === 'bounty' || options.mode === 'ctf' ? options.mode : 'audit';
  return {
    auditMode,
    backendUrl,
    ci: options.ciEnabled
      ? { failOnSeverity: (options.failOn ?? 'high') as FailOnSeverity }
      : undefined,
    commandPolicy: { expertUnsafe: options.expertUnsafe },
    credentialAccount,
    deviceName,
    diff: options.diffEnabled
      ? { baseRef: options.since ?? 'HEAD~1', enabled: true }
      : undefined,
    indexing: { embeddingProvider: 'none' },
  };
}

const ActivityPanel = ({
  activities,
  processing,
}: {
  activities: ActivityLine[];
  processing: boolean;
}) => (
  <Box borderColor="blue" borderStyle="round" flexDirection="column" paddingX={1}>
    <Text bold color="blue">Remote activity</Text>
    {activities.length === 0 && processing && <Text color="gray">Waiting for a signed event...</Text>}
    {activities.slice(-8).map((activity) => (
      <Text
        color={activity.type === 'error' ? 'red' : activity.type === 'usage' ? 'yellow' : 'gray'}
        key={activity.id}
      >
        {activity.text}
      </Text>
    ))}
  </Box>
);

const App = ({
  ciEnabled,
  diffEnabled,
  expertUnsafe,
  failOn,
  forceReconfigure,
  initialObjective,
  initialTarget,
  mode,
  since,
}: {
  ciEnabled?: boolean;
  diffEnabled?: boolean;
  expertUnsafe: boolean;
  failOn?: string;
  forceReconfigure: boolean;
  initialObjective?: string;
  initialTarget?: string;
  mode?: string;
  since?: string;
}) => {
  const { exit } = useApp();
  const [appState, setAppState] = useState<AppState>(ciEnabled ? 'loading' : 'booting');
  const [config, setConfig] = useState<null | ShadowConfig>(null);
  const [backendUrl, setBackendUrl] = useState('');
  const [deviceName, setDeviceName] = useState(os.hostname());
  const [enrollmentCode, setEnrollmentCode] = useState('');
  const [setupError, setSetupError] = useState('');
  const [targetPath, setTargetPath] = useState('');
  const [targetInput, setTargetInput] = useState(process.cwd());
  const [targetError, setTargetError] = useState('');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeResponse, setActiveResponse] = useState('');
  const [activities, setActivities] = useState<ActivityLine[]>([]);
  const [processing, setProcessing] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<null | PendingApproval>(null);
  const runtimeRef = useRef<AgentRuntime | null>(null);
  const pendingApprovalRef = useRef<null | PendingApproval>(null);
  const activityCounter = useRef(0);
  const ciStartedRef = useRef(false);

  useEffect(() => {
    if (appState !== 'booting') return;
    const timer = setTimeout(() => setAppState('loading'), 900);
    return () => clearTimeout(timer);
  }, [appState]);

  useEffect(() => {
    if (appState !== 'loading') return;
    let cancelled = false;
    (async () => {
      try {
        const existing = forceReconfigure ? null : await loadConfig();
        if (cancelled) return;
        if (existing) {
          setConfig(existing);
          const selectedTarget = initialTarget?.trim();
          if (selectedTarget) {
            const resolved = path.resolve(selectedTarget);
            if (!(await fs.stat(resolved)).isDirectory()) throw new Error('Target is not a directory');
            setTargetPath(resolved);
            setAppState('initializing');
          } else {
            setTargetInput(process.cwd());
            setAppState('target-selection');
          }
        } else {
          setAppState('setup-backend');
        }
      } catch (error) {
        if (cancelled) return;
        if (ciEnabled) {
          process.exitCode = 2;
          exit();
          return;
        }

        setTargetInput(initialTarget ?? process.cwd());
        setTargetError(error instanceof Error ? error.message : String(error));
        setAppState('target-selection');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [appState, ciEnabled, exit, forceReconfigure, initialTarget]);

  useEffect(() => {
    if (appState !== 'initializing' || !config || !targetPath) return;
    let cancelled = false;
    (async () => {
      try {
        const effectiveConfig: ShadowConfig = {
          ...config,
          auditMode: mode === 'bounty' || mode === 'ctf' ? mode : config.auditMode,
          ci: ciEnabled
            ? { ...config.ci, failOnSeverity: (failOn ?? 'high') as FailOnSeverity }
            : config.ci,
          commandPolicy: {
            ...config.commandPolicy,
            expertUnsafe: expertUnsafe || config.commandPolicy?.expertUnsafe,
          },
          diff: diffEnabled
            ? { baseRef: since ?? 'HEAD~1', enabled: true }
            : config.diff,
        };
        const repositoryMap = await generateRepoMap(targetPath);
        const runtime = await RemoteAgentSession.create({
          ciEnabled,
          config: effectiveConfig,
          confirmToolExecution: (request) => new Promise<boolean>((resolve) => {
            pendingApprovalRef.current?.resolve(false);
            const pending = { ...request, resolve };
            pendingApprovalRef.current = pending;
            setPendingApproval(pending);
          }),
          repositoryMap,
          targetPath,
        });
        if (cancelled) {
          await runtime.shutdown();
          return;
        }

        runtimeRef.current = runtime;
        setConfig(effectiveConfig);
        setMessages([{
          id: 'ready',
          role: 'system',
          text: `Connected to ${effectiveConfig.backendUrl}. Type /help for local controls.`,
        }]);
        setAppState('shell');
      } catch (error) {
        if (cancelled) return;
        setMessages([{
          id: 'init-error',
          role: 'error',
          text: `Initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        }]);
        setAppState('shell');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [appState, ciEnabled, config, diffEnabled, expertUnsafe, failOn, mode, since, targetPath]);

  useEffect(
    () => () => {
      pendingApprovalRef.current?.resolve(false);
      pendingApprovalRef.current = null;
      runtimeRef.current?.shutdown();
    },
    [],
  );

  const appendMessage = (role: Message['role'], text: string) => {
    setMessages((current) => [...current, {
      id: `${Date.now()}-${Math.random()}`,
      role,
      text,
    }]);
  };

  const submitBackend = (value: string) => {
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol !== 'https:') throw new Error('HTTPS is required');
      setBackendUrl(parsed.toString().replace(/\/$/, ''));
      setSetupError('');
      setAppState('setup-device');
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : 'Invalid backend URL');
    }
  };

  const submitDevice = (value: string) => {
    if (!value.trim()) {
      setSetupError('Device name is required');
      return;
    }

    setDeviceName(value.trim());
    setSetupError('');
    setAppState('setup-code');
  };

  const submitEnrollmentCode = async (value: string) => {
    if (!value.trim()) {
      setSetupError('Enrollment code is required');
      return;
    }

    setEnrollmentCode(value);
    setSetupError('');
    setAppState('enrolling');
    const credentialAccount = `${new URL(backendUrl).host}:${deviceName}`;
    try {
      await RemoteApiClient.enroll({
        backendUrl,
        clientVersion: CLIENT_VERSION,
        credentialAccount,
        deviceName,
        enrollmentCode: value.trim(),
      });
      const nextConfig = defaultConfig(backendUrl, credentialAccount, deviceName, {
        ciEnabled,
        diffEnabled,
        expertUnsafe,
        failOn,
        mode,
        since,
      });
      await saveConfig(nextConfig);
      setEnrollmentCode('');
      setConfig(nextConfig);
      setTargetInput(process.cwd());
      setAppState('target-selection');
    } catch (error) {
      setEnrollmentCode('');
      setSetupError(error instanceof Error ? error.message : String(error));
      setAppState('setup-code');
    }
  };

  const submitTarget = async (value: string) => {
    try {
      const resolved = path.resolve(value.trim() || process.cwd());
      if (!(await fs.stat(resolved)).isDirectory()) throw new Error('Target is not a directory');
      setTargetPath(resolved);
      setTargetError('');
      setAppState('initializing');
    } catch (error) {
      setTargetError(error instanceof Error ? error.message : String(error));
    }
  };

  const applyCiResult = async (runtime: AgentRuntime) => {
    if (!ciEnabled) return;
    try {
      const reportPath = path.join(runtime.getRunDirectory(), 'report.json');
      const report = securityReportSchema.parse(JSON.parse(await fs.readFile(reportPath, 'utf8')));
      const threshold = (failOn ?? 'high') as FailOnSeverity;
      const result = computeCiExitCode({ failOn: threshold, findings: report.findings });
      process.exitCode = result.code;
      appendMessage(result.code === 0 ? 'system' : 'error', formatCiSummary(result, threshold));
    } catch (error) {
      process.exitCode = 2;
      appendMessage('error', `CI report validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const consume = async (stream: AsyncGenerator<StreamActivity>) => {
    let response = '';
    setProcessing(true);
    setActivities([]);
    setActiveResponse('');
    try {
      for await (const activity of stream) {
        activityCounter.current += 1;
        setActivities((current) => [...current, {
          id: activityCounter.current,
          text: formatActivity(activity),
          type: activity.type,
        }].slice(-MAX_ACTIVITY_EVENTS));
        if (activity.type === 'text') {
          response += `${response ? '\n' : ''}${activity.content}`;
          setActiveResponse(response);
        }
      }

      if (response) appendMessage('agent', response);
      const runtime = runtimeRef.current;
      if (runtime) await applyCiResult(runtime);
    } catch (error) {
      appendMessage('error', error instanceof Error ? error.message : String(error));
      if (ciEnabled) process.exitCode = 2;
    } finally {
      setActiveResponse('');
      setProcessing(false);
    }
  };

  useEffect(() => {
    if (
      appState !== 'shell' ||
      !ciEnabled ||
      !initialObjective?.trim() ||
      ciStartedRef.current
    ) {
      return;
    }

    const runtime = runtimeRef.current;
    if (!runtime) {
      process.exitCode = 2;
      exit();
      return;
    }

    ciStartedRef.current = true;
    appendMessage('user', initialObjective.trim());
    (async () => {
      try {
        await consume(runtime.sendMessage(initialObjective.trim()));
      } finally {
        try {
          await runtime.shutdown();
        } catch {
          process.exitCode = 2;
        }

        exit();
      }
    })();
  }, [appState, ciEnabled, exit, initialObjective]);

  const submitCommand = async (value: string) => {
    const command = value.trim();
    if (!command) return;
    setInput('');
    if ([':q', ':quit', 'exit', 'quit'].includes(command.toLowerCase())) {
      await runtimeRef.current?.shutdown();
      exit();
      return;
    }

    const runtime = runtimeRef.current;
    if (!runtime) {
      appendMessage('error', 'Remote runtime is not initialized');
      return;
    }

    const control = command.toLowerCase();
    if (control === '/cancel' || control === '/pause') {
      try {
        if (control === '/cancel') await runtime.cancel();
        else await runtime.pause();
        appendMessage('system', control === '/cancel' ? 'Cancellation requested' : 'Session paused');
      } catch (error) {
        appendMessage('error', error instanceof Error ? error.message : String(error));
      }

      return;
    }

    if (processing) {
      appendMessage('error', 'A session is streaming. Use /pause or /cancel first.');
      return;
    }

    if (control === '/help') {
      appendMessage('system', '/tools  /usage  /status  /pause  /resume  /cancel  exit');
      return;
    }

    if (control === '/tools') {
      const tools = runtime.getToolDescriptors();
      appendMessage(
        'system',
        tools.length === 0
          ? 'No local tools are enabled.'
          : tools.map((tool) => `${tool.name} [${tool.risk}] - ${tool.description}`).join('\n'),
      );
      return;
    }

    if (control === '/usage') {
      appendMessage('system', JSON.stringify(runtime.getUsage(), null, 2));
      return;
    }

    if (control === '/status') {
      appendMessage(
        'system',
        `Session: ${runtime.getActiveSessionId() ?? 'none'}\nArtifacts: ${runtime.getRunDirectory()}`,
      );
      return;
    }

    if (control === '/resume') {
      await consume(runtime.resume());
      return;
    }

    if (control.startsWith('/')) {
      appendMessage('error', `Unknown command: ${command}`);
      return;
    }

    appendMessage('user', command);
    await consume(runtime.sendMessage(command));
  };

  const submitApproval = async (value: string) => {
    const pending = pendingApprovalRef.current;
    if (!pending) return;
    const answer = value.trim().toLowerCase();
    const control = answer === '/cancel' || answer === '/pause' ? answer : null;
    const approved = answer === 'y' || answer === 'yes';
    pendingApprovalRef.current = null;
    setPendingApproval(null);
    setInput('');
    pending.resolve(approved);
    if (control) {
      try {
        if (control === '/cancel') await runtimeRef.current?.cancel();
        else await runtimeRef.current?.pause();
        appendMessage('system', control === '/cancel' ? 'Cancellation requested' : 'Session paused');
      } catch (error) {
        appendMessage('error', error instanceof Error ? error.message : String(error));
      }
    }
  };

  const rows = process.stdout.rows || 24;
  const columns = process.stdout.columns || 80;

  return (
    <Box flexDirection="column" minHeight={rows} width={columns}>
      {appState === 'booting' && (
        <Box alignItems="center" flexDirection="column" height="100%" justifyContent="center">
          <AsciiMotionCli autoPlay loop={false} />
          <Text color="cyan">Starting local Shadow Auditor client...</Text>
        </Box>
      )}
      {appState === 'loading' && <Text>Loading local client configuration...</Text>}
      {appState === 'setup-backend' && (
        <Box flexDirection="column" padding={1}>
          <Text bold color="cyan">Shadow Auditor backend enrollment</Text>
          <Text>Backend URL (HTTPS):</Text>
          <TextInput
            onChange={setBackendUrl}
            onSubmit={submitBackend}
            placeholder="https://auditor.example.com"
            value={backendUrl}
          />
          {setupError && <Text color="red">{setupError}</Text>}
        </Box>
      )}
      {appState === 'setup-device' && (
        <Box flexDirection="column" padding={1}>
          <Text bold color="cyan">Device identity</Text>
          <Text>Device name:</Text>
          <TextInput onChange={setDeviceName} onSubmit={submitDevice} value={deviceName} />
          {setupError && <Text color="red">{setupError}</Text>}
        </Box>
      )}
      {appState === 'setup-code' && (
        <Box flexDirection="column" padding={1}>
          <Text bold color="cyan">One-time enrollment code</Text>
          <Text>The code is sent only to {backendUrl} and is never saved locally.</Text>
          <TextInput
            mask="*"
            onChange={setEnrollmentCode}
            onSubmit={submitEnrollmentCode}
            value={enrollmentCode}
          />
          {setupError && <Text color="red">{setupError}</Text>}
        </Box>
      )}
      {appState === 'enrolling' && <Text color="cyan"><Spinner type="dots" /> Enrolling device...</Text>}
      {appState === 'target-selection' && (
        <Box flexDirection="column" padding={1}>
          <Text bold color="cyan">Local repository path</Text>
          <TextInput onChange={setTargetInput} onSubmit={submitTarget} value={targetInput} />
          {targetError && <Text color="red">{targetError}</Text>}
        </Box>
      )}
      {appState === 'initializing' && (
        <Text color="cyan"><Spinner type="dots" /> Building local repository map and negotiating capabilities...</Text>
      )}
      {appState === 'shell' && (
        <Box flexDirection="column" height="100%">
          <Box borderColor="magenta" borderStyle="round" flexDirection="column" paddingX={2}>
            <Text bold color="magenta">Shadow Auditor public local client</Text>
            <Text color="gray">
              Backend: {config?.backendUrl ?? 'unavailable'} | Target: {targetPath ? path.basename(targetPath) : 'unavailable'}
            </Text>
          </Box>
          <Static items={messages}>
            {(message) => (
              <Box flexDirection="column" key={message.id} marginBottom={1}>
                <Text color={message.role === 'error' ? 'red' : message.role === 'user' ? 'green' : 'cyan'}>
                  {message.role === 'user' ? '> ' : message.role === 'error' ? '! ' : '* '}
                  {message.text}
                </Text>
              </Box>
            )}
          </Static>
          {(processing || activities.length > 0) && (
            <ActivityPanel activities={activities} processing={processing} />
          )}
          {pendingApproval && (
            <Box borderColor="yellow" borderStyle="round" flexDirection="column" paddingX={1}>
              <Text bold color="yellow">Local tool approval required</Text>
              <Text>{pendingApproval.toolName} [{pendingApproval.risk}]</Text>
              <Text>{pendingApproval.reason}</Text>
              <Text color="gray">{JSON.stringify(pendingApproval.arguments, null, 2)}</Text>
              <Text>Approve this digest-bound proposal? y/N</Text>
            </Box>
          )}
          {activeResponse && <Text color="cyan">{activeResponse}</Text>}
          <Box marginTop={1}>
            <Text bold color="magenta">&gt; </Text>
            <TextInput
              onChange={setInput}
              onSubmit={pendingApproval ? submitApproval : submitCommand}
              placeholder={
                pendingApproval
                  ? 'y/N, /pause, or /cancel'
                  : processing
                    ? '/pause or /cancel'
                    : 'Describe the security audit objective'
              }
              value={input}
            />
            {processing && <Text color="cyan"> <Spinner type="dots" /></Text>}
          </Box>
          <Text color="gray">Local controls: /help</Text>
        </Box>
      )}
    </Box>
  );
};

export default App;
