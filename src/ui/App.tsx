import { Box, Static, Text } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import React, { useEffect, useState } from 'react';

import { AgentSession } from '../core/agent.js';
import { AsciiMotionCli } from '../utils/ascii-motion-cli.js';
import { loadConfig, saveConfig, ShadowConfig } from '../utils/config.js';
import { generateRepoMap } from '../utils/repo-map.js';
import { getModelPlaceholder } from '../utils/setup.js';

// Types
type AppState =
  | 'booting'
  | 'initializing'
  | 'setup'
  | 'setup-apikey'
  | 'setup-baseurl'
  | 'setup-model'
  | 'setup-provider'
  | 'shell'
  | 'targetSelection';

type Message = {
  id: string;
  role: 'agent' | 'error' | 'system' | 'user';
  text: string;
};

const providerOptions = [
  { label: 'Anthropic (Claude)', value: 'anthropic' },
  { label: 'OpenAI (GPT-4o, o1, o3)', value: 'openai' },
  { label: 'Google (Gemini)', value: 'google' },
  { label: 'Mistral', value: 'mistral' },
  { label: 'Ollama (Local)', value: 'ollama' },
  { label: 'Custom (OpenAI-Compatible)', value: 'custom' },
];

// ... Setup Wizard Component (to be implemented)
// ... Target Selection Component (to be implemented)
// ... Chat Shell Component (to be implemented)

const App = ({ forceReconfigure }: { forceReconfigure: boolean }) => {
  const [appState, setAppState] = useState<AppState>('booting');
  const [config, setConfig] = useState<null | ShadowConfig>(null);
  const [targetPath, setTargetPath] = useState<string>('');

  // Setup Wizard State
  const [setupData, setSetupData] = useState<Partial<ShadowConfig>>({});
  const [setupInput, setSetupInput] = useState<string>('');

  // Custom Path Input
  const [useCurrentDir, setUseCurrentDir] = useState<boolean>(true);
  const [customPathInput, setCustomPathInput] = useState<string>('');
  const [pathError, setPathError] = useState<string>('');

  // Shell State
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeMessage, setActiveMessage] = useState<Message | null>(null);
  const [input, setInput] = useState<string>('');
  const [agentSession, setAgentSession] = useState<AgentSession | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  useEffect(() => {
    // Config Load Effect
    const checkConfig = async () => {
      const cfg = forceReconfigure ? null : await loadConfig();
      if (cfg) {
        setConfig(cfg);
        setAppState('targetSelection');
      } else {
        setAppState('setup-provider');
      }
    };

    if (appState === 'setup') {
      checkConfig();
    }
  }, [appState, forceReconfigure]);

  const handleProviderSelect = (item: { value: string }) => {
    setSetupData({ ...setupData, provider: item.value });
    if (item.value === 'custom') {
      setAppState('setup-baseurl');
    } else {
      setAppState('setup-model');
    }
  };

  const handleBaseUrlInput = (value: string) => {
    setSetupData({ ...setupData, customBaseUrl: value });
    setSetupInput('');
    setAppState('setup-model');
  };

  const handleModelInput = async (value: string) => {
    const updated = { ...setupData, model: value };
    setSetupData(updated);
    setSetupInput('');

    if (updated.provider === 'ollama') {
      const finalConfig = { ...updated, apiKey: '' } as ShadowConfig;
      await saveConfig(finalConfig);
      setConfig(finalConfig);
      setAppState('targetSelection');
    } else {
      setAppState('setup-apikey');
    }
  };

  const handleApiKeyInput = async (value: string) => {
    const finalConfig = { ...setupData, apiKey: value } as ShadowConfig;
    await saveConfig(finalConfig);
    setConfig(finalConfig);
    setSetupInput('');
    setAppState('targetSelection');
  };

  useEffect(() => {
    if (appState === 'booting') {
      // The animation has ~1 frame taking 83.3ms, we loop false
      // Give it 1.5s then jump to next state
      const timer = setTimeout(() => {
        setAppState('setup');
      }, 1500);
      return () => clearTimeout(timer);
    }

    if (appState === 'initializing' && targetPath && config) {
      const initSession = async () => {
        try {
          const map = await generateRepoMap(targetPath);

          const session = new AgentSession(config, map, targetPath);
          setAgentSession(session);

          setAppState('shell');
        } catch (error) {
          setMessages([{
            id: 'init-error',
            role: 'error',
            text: `Failed to initialize: ${(error as Error).message}`
          }]);
          setAppState('shell'); // Go to shell to show error
        }
      };

      initSession();
    }
  }, [appState, targetPath, config]);

  const handlePathSubmit = async (p: string) => {
    try {
      const resolved = path.resolve(p);
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        setPathError('Target path is not a directory.');
        return;
      }

      setTargetPath(resolved);
      setAppState('initializing');
    } catch {
      setPathError('Target path does not exist.');
    }
  };

  const handleUseCurrentDirSubmit = (value: string) => {
    if (value.toLowerCase() === 'y' || value.toLowerCase() === 'yes' || value === '') {
      handlePathSubmit(process.cwd());
    } else {
      setUseCurrentDir(false);
      setCustomPathInput(''); // clear the "n" typed
    }
  };

  const handleCommandSubmit = async (command: string) => {
    if (!command.trim() || isProcessing) return;

    if ([':q', ':quit', 'exit', 'quit'].includes(command.trim().toLowerCase())) {
      process.exit(0);
    }

    const newMsgId = Date.now().toString();
    const userMsg: Message = { id: `u-${newMsgId}`, role: 'user', text: command };
    setMessages(prev => [...prev, userMsg]);
    setInput('');

    if (!agentSession) {
       setMessages(prev => [...prev, { id: `e-${newMsgId}`, role: 'error', text: 'Agent session not initialized.' }]);
       return;
    }

    setIsProcessing(true);
    const agentMsgId = `a-${newMsgId}`;
    setActiveMessage({ id: agentMsgId, role: 'agent', text: '' });

    try {
      let finalResponse = '';
      await agentSession.sendMessage(command, (chunk: string) => {
        finalResponse += chunk;
        setActiveMessage({ id: agentMsgId, role: 'agent', text: finalResponse });
      });
      setMessages(prev => [...prev, { id: agentMsgId, role: 'agent', text: finalResponse }]);
      setActiveMessage(null);
    } catch (error) {
      const errMsg = (error as Error).message;
      if (errMsg.includes('API key') || errMsg.includes('401') || errMsg.includes('authentication')) {
        setMessages(prev => [...prev, { id: `e-${Date.now()}`, role: 'error', text: 'Authentication failed. Run again with --reconfigure.' }]);
      } else {
        setMessages(prev => [...prev, { id: `e-${Date.now()}`, role: 'error', text: `Error: ${errMsg}` }]);
      }

      setActiveMessage(null);
    } finally {
      setIsProcessing(false);
    }
  };

  const rows = process.stdout.rows || 24;
  const columns = process.stdout.columns || 80;

  return (
    <Box flexDirection="column" minHeight={rows} width={columns}>
      {appState === 'booting' && (
        <Box alignItems="center" flexDirection="column" height="100%" justifyContent="center">
          <AsciiMotionCli autoPlay loop={false} />
          <Box marginTop={1}>
            <Text color="cyan">Booting Shadow Auditor...</Text>
          </Box>
        </Box>
      )}
      {appState === 'setup' && (
        <Text>Loading configuration...</Text>
      )}
      {appState === 'setup-provider' && (
        <Box flexDirection="column" padding={1}>
          <Box marginBottom={1}>
            <Text bold color="cyan">🔓 SHADOW AUDITOR :: Configuration Wizard</Text>
          </Box>
          <Box marginBottom={1}>
            <Text>Select your LLM provider:</Text>
          </Box>
          <SelectInput items={providerOptions} onSelect={handleProviderSelect} />
        </Box>
      )}
      {appState === 'setup-baseurl' && (
        <Box flexDirection="column" padding={1}>
          <Box marginBottom={1}>
            <Text bold color="cyan">🔓 SHADOW AUDITOR :: Configuration Wizard</Text>
          </Box>
          <Box marginBottom={1}>
            <Text>Enter your custom API base URL:</Text>
          </Box>
          <Box>
            <Text color="gray">❯ </Text>
            <TextInput
              onChange={setSetupInput}
              onSubmit={handleBaseUrlInput}
              placeholder="https://api.your-provider.com/v1"
              value={setupInput}
            />
          </Box>
        </Box>
      )}
      {appState === 'setup-model' && (
        <Box flexDirection="column" padding={1}>
          <Box marginBottom={1}>
            <Text bold color="cyan">🔓 SHADOW AUDITOR :: Configuration Wizard</Text>
          </Box>
          <Box marginBottom={1}>
            <Text>Enter the model name:</Text>
          </Box>
          <Box>
            <Text color="gray">❯ </Text>
            <TextInput
              onChange={setSetupInput}
              onSubmit={handleModelInput}
              placeholder={getModelPlaceholder(setupData.provider || '')}
              value={setupInput}
            />
          </Box>
        </Box>
      )}
      {appState === 'setup-apikey' && (
        <Box flexDirection="column" padding={1}>
          <Box marginBottom={1}>
            <Text bold color="cyan">🔓 SHADOW AUDITOR :: Configuration Wizard</Text>
          </Box>
          <Box marginBottom={1}>
            <Text>Enter your API key:</Text>
          </Box>
          <Box>
            <Text color="gray">❯ </Text>
            <TextInput
              mask="*"
              onChange={setSetupInput}
              onSubmit={handleApiKeyInput}
              value={setupInput}
            />
          </Box>
        </Box>
      )}
      {appState === 'targetSelection' && (
        <Box flexDirection="column">
          <Box borderColor="cyan" borderStyle="round" paddingX={2} paddingY={1}>
            <Text bold color="cyan">Shadow Auditor Target Selection</Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            {useCurrentDir ? (
              <Box>
                <Text color="yellow">Use current directory (</Text>
                <Text bold>{process.cwd()}</Text>
                <Text color="yellow">) for the audit? [Y/n] </Text>
                <TextInput
                  onChange={setCustomPathInput}
                  onSubmit={handleUseCurrentDirSubmit}
                  value={customPathInput}
                />
              </Box>
            ) : (
              <Box flexDirection="column">
                <Box>
                  <Text color="yellow">Enter target directory: </Text>
                  <TextInput
                    onChange={setCustomPathInput}
                    onSubmit={handlePathSubmit}
                    value={customPathInput}
                  />
                </Box>
                {pathError && <Text color="red">{pathError}</Text>}
              </Box>
            )}
          </Box>
        </Box>
      )}
      {appState === 'initializing' && (
        <Box flexDirection="column" padding={1}>
          <Text color="cyan"><Spinner type="dots" /> Parsing AST with tree-sitter & initializing agent...</Text>
        </Box>
      )}
      {appState === 'shell' && (
        <Box flexDirection="column" height="100%">
          {/* Header */}
          <Box borderColor="magenta" borderStyle="round" flexDirection="column" paddingX={2} paddingY={1}>
            <Text bold color="magenta">Shadow Auditor</Text>
            <Text color="gray">Interactive Security Analysis Shell</Text>
            <Text color="yellow">Tip: Type a command to start investigating the codebase.</Text>
          </Box>

          {/* Status Bar */}
          <Box marginBottom={1} paddingX={1}>
            <Text color="blue">● Environment loaded: </Text>
            <Text color="white">Provider: {config?.provider} | Model: {config?.model} | Target: {path.basename(targetPath)}</Text>
          </Box>

          {/* Chat History */}
          <Static items={messages}>
            {(msg) => (
              <Box flexDirection="column" key={msg.id} marginBottom={1}>
                <Text color={msg.role === 'user' ? 'green' : msg.role === 'error' ? 'red' : 'cyan'}>
                  {msg.role === 'user' ? '❯ ' : msg.role === 'error' ? '✖ ' : '● '}
                  {msg.text}
                </Text>
              </Box>
            )}
          </Static>

          {/* Input Area */}
          <Box flexDirection="column" marginTop={1}>
            {activeMessage && (
               <Box flexDirection="column" marginBottom={1}>
                 <Text color="cyan">● {activeMessage.text}</Text>
               </Box>
            )}
            <Box>
              <Text color="green">{targetPath} [✓] </Text>
            </Box>
            <Box>
              <Text bold color="magenta">❯ </Text>
              {isProcessing ? (
                 <Text color="cyan"><Spinner type="dots" /> Agent is thinking...</Text>
              ) : (
                <TextInput
                  onChange={setInput}
                  onSubmit={handleCommandSubmit}
                  placeholder="Describe a task or ask a question to get started..."
                  value={input}
                />
              )}
            </Box>
            <Box marginTop={1}>
              <Text color="gray" dimColor>Type 'exit' or Ctrl+C to leave the shell.</Text>
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  );
};

export default App;
