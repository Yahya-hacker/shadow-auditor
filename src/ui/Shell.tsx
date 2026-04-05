import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import { AsciiMotionCli } from '../utils/ascii-motion-cli.js';

interface ShellProps {
  onSetupComplete: (config: SetupConfig) => void;
  onTargetSelected: (target: string) => void;
  onCommandSubmit: (command: string) => void;
  onExit: () => void;
}

interface SetupConfig {
  provider: string;
  model: string;
  apiKey: string;
  customBaseUrl?: string;
}

type ViewState = 'boot' | 'setup-provider' | 'setup-model' | 'setup-apikey' | 'setup-baseurl' | 'target-input' | 'repo-mapping' | 'shell';

export const Shell: React.FC<ShellProps> = ({ onSetupComplete, onTargetSelected, onCommandSubmit, onExit }) => {
  const { exit } = useApp();
  const [viewState, setViewState] = useState<ViewState>('boot');
  const [setupData, setSetupData] = useState<Partial<SetupConfig>>({});
  const [textInput, setTextInput] = useState('');
  const [commandHistory, setCommandHistory] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  // Boot animation timeout
  useEffect(() => {
    if (viewState === 'boot') {
      const timer = setTimeout(() => {
        setViewState('setup-provider');
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [viewState]);

  // Global input handler for exit
  useInput((input, key) => {
    if (key.escape || (input === 'c' && key.ctrl)) {
      onExit();
      exit();
    }
  });

  const providerOptions = [
    { label: 'Anthropic (Claude)', value: 'anthropic' },
    { label: 'OpenAI (GPT-4o, o1, o3)', value: 'openai' },
    { label: 'Google (Gemini)', value: 'google' },
    { label: 'Mistral', value: 'mistral' },
    { label: 'Ollama (Local)', value: 'ollama' },
    { label: 'Custom (OpenAI-Compatible)', value: 'custom' },
  ];

  const handleProviderSelect = (item: { value: string }) => {
    setSetupData({ ...setupData, provider: item.value });
    if (item.value === 'custom') {
      setViewState('setup-baseurl');
    } else {
      setViewState('setup-model');
    }
  };

  const handleModelInput = (value: string) => {
    setSetupData({ ...setupData, model: value });
    if (setupData.provider === 'ollama') {
      onSetupComplete({ ...setupData, model: value, apiKey: '' } as SetupConfig);
      setViewState('target-input');
    } else {
      setViewState('setup-apikey');
    }
  };

  const handleApiKeyInput = (value: string) => {
    const config = { ...setupData, apiKey: value } as SetupConfig;
    onSetupComplete(config);
    setViewState('target-input');
  };

  const handleBaseUrlInput = (value: string) => {
    setSetupData({ ...setupData, customBaseUrl: value });
    setViewState('setup-model');
  };

  const handleTargetInput = (value: string) => {
    onTargetSelected(value);
    setViewState('repo-mapping');
    // Simulate repo mapping completion
    setTimeout(() => {
      setViewState('shell');
    }, 2000);
  };

  const handleCommandInput = (value: string) => {
    if (!value.trim()) return;
    if (['exit', 'quit', ':q', ':quit'].includes(value.toLowerCase())) {
      onExit();
      exit();
      return;
    }
    setCommandHistory([...commandHistory, { role: 'user', content: value }]);
    setIsProcessing(true);
    onCommandSubmit(value);
    setTextInput('');
  };

  // Render boot animation
  if (viewState === 'boot') {
    return (
      <Box flexDirection="column">
        <AsciiMotionCli hasDarkBackground={true} autoPlay={true} loop={false} />
      </Box>
    );
  }

  // Render setup: provider selection
  if (viewState === 'setup-provider') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">🔓 SHADOW AUDITOR :: Configuration Wizard</Text>
        </Box>
        <Box marginBottom={1}>
          <Text>Select your LLM provider:</Text>
        </Box>
        <SelectInput items={providerOptions} onSelect={handleProviderSelect} />
      </Box>
    );
  }

  // Render setup: custom base URL
  if (viewState === 'setup-baseurl') {
    return (
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
            value={textInput}
            onChange={setTextInput}
            onSubmit={handleBaseUrlInput}
            placeholder="https://api.your-provider.com/v1"
          />
        </Box>
      </Box>
    );
  }

  // Render setup: model name
  if (viewState === 'setup-model') {
    return (
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
            value={textInput}
            onChange={setTextInput}
            onSubmit={handleModelInput}
            placeholder={getModelPlaceholder(setupData.provider || '')}
          />
        </Box>
      </Box>
    );
  }

  // Render setup: API key
  if (viewState === 'setup-apikey') {
    return (
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
            value={textInput}
            onChange={setTextInput}
            onSubmit={handleApiKeyInput}
            mask="*"
          />
        </Box>
      </Box>
    );
  }

  // Render target input
  if (viewState === 'target-input') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="magenta">🎯 Target Selection</Text>
        </Box>
        <Box marginBottom={1}>
          <Text>Which directory would you like to audit?</Text>
        </Box>
        <Box>
          <Text color="gray">❯ </Text>
          <TextInput
            value={textInput}
            onChange={setTextInput}
            onSubmit={handleTargetInput}
            placeholder="."
          />
        </Box>
      </Box>
    );
  }

  // Render repo mapping
  if (viewState === 'repo-mapping') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box>
          <Text color="yellow">
            <Spinner type="dots" />
          </Text>
          <Text color="yellow"> Parsing AST with tree-sitter...</Text>
        </Box>
      </Box>
    );
  }

  // Render interactive shell
  if (viewState === 'shell') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box borderStyle="double" borderColor="gray" padding={1} marginBottom={1}>
          <Box flexDirection="column">
            <Text bold color="yellow">SHADOW AUDITOR</Text>
            <Text color="gray">Interactive Security Analysis Shell</Text>
            <Box marginTop={1}>
              <Text dimColor>Try: "Analyze authentication flow" | "Find injection vulnerabilities" | "exit"</Text>
            </Box>
          </Box>
        </Box>

        {/* Chat history */}
        <Box flexDirection="column" marginBottom={1}>
          {commandHistory.slice(-5).map((msg, idx) => (
            <Box key={idx} flexDirection="column" marginBottom={1}>
              {msg.role === 'user' ? (
                <Text color="magenta">Shadow Auditor ❯ {msg.content}</Text>
              ) : (
                <Text color="cyan">{msg.content}</Text>
              )}
            </Box>
          ))}
        </Box>

        {/* Processing indicator */}
        {isProcessing && (
          <Box marginBottom={1}>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text color="cyan"> Processing...</Text>
          </Box>
        )}

        {/* Command input */}
        <Box>
          <Text color="magenta">Shadow Auditor ❯ </Text>
          <TextInput
            value={textInput}
            onChange={setTextInput}
            onSubmit={handleCommandInput}
            placeholder="Enter a command..."
          />
        </Box>
      </Box>
    );
  }

  return null;
};

function getModelPlaceholder(provider: string): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-sonnet-4-20250514';
    case 'openai':
      return 'gpt-4o';
    case 'google':
      return 'gemini-2.5-pro-preview-05-06';
    case 'mistral':
      return 'mistral-large-latest';
    case 'ollama':
      return 'llama3';
    case 'custom':
      return 'your-model-name';
    default:
      return 'model-name';
  }
}
