import { Box, Text, Input } from "../../opentui/components.js";
/**
 * SetupScreen — provider/model/API key configuration.
 *
 * Replaces Ink's `<SelectInput>` with interactive `<Box>` lists
 * navigated via keyboard. `<TextInput>` replaced with `<Input>`.
 */

import React, { useEffect, useMemo, useState } from 'react';

import type { ShadowConfig } from '../../utils/config.js';

import { loadConfig, saveConfig } from '../../utils/config.js';
import { saveApiKey } from '../../utils/keychain.js';
import {
  fetchApiModels,
  getEmbeddingDefaults,
  getProviderModels,
  isOpenAICompatibleProvider,
  providerHasNativeEmbedding,
} from '../../utils/provider-catalog.js';
import { startRepoMapGeneration } from '../hooks/useAgentSession.js';
import { OptionList } from '../components/OptionList.js';
import { useAppStore } from '../store/appStore.js';
import { colors, spacing } from '../theme/chalkTheme.js';

type Step =
  | 'apiKey' | 'baseUrl' | 'customModel' | 'done' | 'embedding'
  | 'fetching' | 'license' | 'model' | 'provider' | 'trust';

const providerOptions = [
  { label: 'Anthropic (Claude)', value: 'anthropic' },
  { label: 'OpenAI (GPT-4o, o1, o3)', value: 'openai' },
  { label: 'Google (Gemini)', value: 'google' },
  { label: 'Mistral', value: 'mistral' },
  { label: 'DeepSeek', value: 'deepseek' },
  { label: 'Qwen (Alibaba)', value: 'qwen' },
  { label: 'Moonshot AI', value: 'moonshot' },
  { label: 'NVIDIA NIM', value: 'nvidia' },
  { label: 'Perplexity', value: 'perplexity' },
  { label: 'Ollama (Local)', value: 'ollama' },
  { label: 'Custom (OpenAI-Compatible)', value: 'custom' },
];

const trustOptions = [
  { label: 'Yes, I trust this folder and its contents', value: 'yes' },
  { label: 'No, abort setup', value: 'no' },
];

export const SetupScreen: React.FC = () => {
  const setScreen = useAppStore((state) => state.setScreen);
  const targetPath = useAppStore((state) => state.session.targetPath);
  const [step, setStep] = useState<Step>('trust');
  const [provider, setProvider] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<Array<{ label: string; value: string }>>([]);
  const [model, setModel] = useState('');
  const [licenseKey, setLicenseKey] = useState('');
  const [embeddingChoice, setEmbeddingChoice] = useState<string>('cloud');
  const [error, setError] = useState('');
  const [fetching, setFetching] = useState(false);

  useEffect(() => {
    if (targetPath) {
      startRepoMapGeneration(targetPath);
    }
  }, [targetPath]);

  const handleTrustSelect = (value: string) => {
    if (value === 'yes') {
      setStep('provider');
    } else {
      process.exit(0);
    }
  };

  const handleProviderSelect = (value: string) => {
    setProvider(value);
    if (value === 'custom') {
      setStep('baseUrl');
    } else {
      setStep('apiKey');
    }
  };

  const handleBaseUrlSubmit = (value: string) => {
    if (!value.trim()) { setError('Base URL is required'); return; }
    try {
      const url = new URL(value);
      if (!url.hostname) { setError('Please enter a valid URL'); return; }
    } catch { setError('Please enter a valid URL'); return; }
    setCustomBaseUrl(value.trim());
    setError('');
    setStep('apiKey');
  };

  const handleApiKeySubmit = async (value: string) => {
    if (provider !== 'ollama' && !value.trim()) {
      setError('API key is required');
      return;
    }
    setApiKey(value.trim());
    setError('');
    if (value.trim()) await saveApiKey(provider, value.trim());
    if (isOpenAICompatibleProvider(provider) && value.trim()) {
      setFetching(true);
      setStep('fetching');
      const fetched = await fetchApiModels(provider, value.trim(), customBaseUrl || undefined);
      setFetching(false);
      if (fetched && fetched.length > 0) setModels(fetched);
      else setModels(getProviderModels(provider) ?? []);
    } else {
      setModels(getProviderModels(provider) ?? []);
    }
    setStep('model');
  };

  const handleModelSelect = (value: string) => {
    if (value === '__custom__') { setStep('customModel'); return; }
    setModel(value);
    setStep('embedding');
  };

  const handleCustomModelSubmit = (value: string) => {
    if (!value.trim()) { setError('Model name is required'); return; }
    setModel(value.trim());
    setError('');
    setStep('embedding');
  };

  const handleEmbeddingSelect = (value: string) => {
    setEmbeddingChoice(value);
    setStep('license');
  };

  const handleLicenseSubmit = async (value: string) => {
    const trimmed = value.trim();
    const defaults = getEmbeddingDefaults(provider);
    let indexingEnabled = true;
    let embeddingProvider = defaults.embeddingProvider;
    let embeddingModel = defaults.embeddingModel;

    if (providerHasNativeEmbedding(provider)) {
      if (embeddingChoice === 'cloud') { embeddingProvider = 'openai'; embeddingModel = defaults.embeddingModel; }
      else if (embeddingChoice === 'ollama') { embeddingProvider = 'ollama'; embeddingModel = 'nomic-embed-text'; }
      else { indexingEnabled = false; }
    } else if (defaults.requiresOllamaInstallPrompt) { indexingEnabled = false; }

    const config: ShadowConfig = {
      apiKey: '',
      customBaseUrl: customBaseUrl || undefined,
      indexing: {
        embeddingModel,
        embeddingProvider: embeddingProvider as 'ollama' | 'openai',
        enabled: indexingEnabled,
      },
      licenseKey: trimmed || undefined,
      model,
      provider,
    };

    await saveConfig(config);
    const freshCfg = await loadConfig();
    const s = useAppStore.getState();
    if (freshCfg) s.setConfig(freshCfg);
    s.setSessionTarget(process.cwd());
    setStep('done');
    setTimeout(() => s.setScreen('initializing'), 1500);
  };

  const modelOptions = useMemo(() => [
    ...models.map((m) => ({ label: m.label, value: m.value })),
    { label: 'Type a custom model name...', value: '__custom__' },
  ], [models]);

  const embeddingOptions = useMemo(() => [
    { label: `Cloud embeddings via ${provider}`, value: 'cloud' },
    { label: 'Local Ollama embeddings (nomic-embed-text)', value: 'ollama' },
    { label: 'Skip semantic indexing', value: 'skip' },
  ], [provider]);

  return (
    <Box flexDirection="column" paddingX={spacing.panelPadX}>
      <Box
        borderColor={colors.brand} borderStyle={'rounded'}
        paddingX={spacing.panelPadX}
        paddingY={spacing.panelPadY}
      >
        <Text color={colors.brand} bold>
          ◈ Shadow Auditor — Environment Setup
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {step === 'trust' && (
          <>
            <Text color={colors.bright}>
              Shadow requires deep read/write access to:{' '}
              <Text bold>{targetPath}</Text>
            </Text>
            <Box marginBottom={1}>
              <Text color={colors.muted}>
                Do you trust this folder and its contents?
              </Text>
            </Box>
            <OptionList options={trustOptions} onSelect={handleTrustSelect} />
          </>
        )}

        {step === 'provider' && (
          <>
            <Text color={colors.bright}>Select your LLM provider:</Text>
            <OptionList options={providerOptions} onSelect={handleProviderSelect} />
          </>
        )}

        {step === 'baseUrl' && (
          <>
            <Text color={colors.bright}>Enter your custom API base URL:</Text>
            <Input
              value={customBaseUrl}
              onChange={(v: string) => setCustomBaseUrl(v)}
              onSubmit={handleBaseUrlSubmit}
              placeholder="https://api.your-provider.com/v1"
            />
          </>
        )}

        {step === 'apiKey' && (
          <>
            <Text color={colors.bright}>
              Enter your API key (stored securely in OS vault):
            </Text>
            <Input
              value={apiKey}
              onChange={(v: string) => setApiKey(v)}
              onSubmit={handleApiKeySubmit}
              placeholder="••••••••"
              mask="*"
            />
          </>
        )}

        {step === 'fetching' && (
          <Text color={colors.agent}>Fetching live models from API...</Text>
        )}

        {step === 'model' && (
          <>
            <Text color={colors.bright}>
              {fetching ? 'Select a model (live list):' : 'Select a model:'}
            </Text>
            <OptionList options={modelOptions} onSelect={handleModelSelect} />
          </>
        )}

        {step === 'customModel' && (
          <>
            <Text color={colors.bright}>Enter the model name:</Text>
            <Input
              value={model}
              onChange={(v: string) => setModel(v)}
              onSubmit={handleCustomModelSubmit}
            />
          </>
        )}

        {step === 'embedding' && (
          <>
            <Text color={colors.bright}>Choose embedding strategy:</Text>
            <OptionList options={embeddingOptions} onSelect={handleEmbeddingSelect} />
          </>
        )}

        {step === 'license' && (
          <>
            <Text color={colors.bright}>
              Enter your license key (press Enter to skip):
            </Text>
            <Input
              value={licenseKey}
              onChange={(v: string) => setLicenseKey(v)}
              onSubmit={handleLicenseSubmit}
              placeholder="SA-XXXX-XXXX-XXXX-XXXX"
            />
          </>
        )}

        {step === 'done' && (
          <Text color={colors.success}>
            Configuration saved! Entering Shadow Auditor...
          </Text>
        )}

        {error && (
          <Box marginTop={1}>
            <Text color={colors.error}>✖ {error}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};
