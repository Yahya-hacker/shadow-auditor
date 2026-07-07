/**
 * SetupScreen — provider/model/API key configuration.
 *
 * Replaces Ink's `<SelectInput>` with interactive `<box>` lists
 * navigated via keyboard. `<TextInput>` replaced with `<input>`.
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
    <box flexDirection="column" paddingX={spacing.panelPadX}>
      <box
        border={{ color: colors.brand, style: 'round' }}
        paddingX={spacing.panelPadX}
        paddingY={spacing.panelPadY}
      >
        <text style={{ color: colors.brand, fontWeight: 'bold' }}>
          ◈ Shadow Auditor — Environment Setup
        </text>
      </box>

      <box flexDirection="column" marginTop={1}>
        {step === 'trust' && (
          <>
            <text style={{ color: colors.bright }}>
              Shadow requires deep read/write access to:{' '}
              <text style={{ fontWeight: 'bold' }}>{targetPath}</text>
            </text>
            <box marginBottom={1}>
              <text style={{ color: colors.muted }}>
                Do you trust this folder and its contents?
              </text>
            </box>
            <OptionList options={trustOptions} onSelect={handleTrustSelect} />
          </>
        )}

        {step === 'provider' && (
          <>
            <text style={{ color: colors.bright }}>Select your LLM provider:</text>
            <OptionList options={providerOptions} onSelect={handleProviderSelect} />
          </>
        )}

        {step === 'baseUrl' && (
          <>
            <text style={{ color: colors.bright }}>Enter your custom API base URL:</text>
            <input
              value={customBaseUrl}
              onChange={(v: string) => setCustomBaseUrl(v)}
              onSubmit={handleBaseUrlSubmit}
              placeholder="https://api.your-provider.com/v1"
            />
          </>
        )}

        {step === 'apiKey' && (
          <>
            <text style={{ color: colors.bright }}>
              Enter your API key (stored securely in OS vault):
            </text>
            <input
              value={apiKey}
              onChange={(v: string) => setApiKey(v)}
              onSubmit={handleApiKeySubmit}
              placeholder="••••••••"
              mask="*"
            />
          </>
        )}

        {step === 'fetching' && (
          <text style={{ color: colors.agent }}>Fetching live models from API...</text>
        )}

        {step === 'model' && (
          <>
            <text style={{ color: colors.bright }}>
              {fetching ? 'Select a model (live list):' : 'Select a model:'}
            </text>
            <OptionList options={modelOptions} onSelect={handleModelSelect} />
          </>
        )}

        {step === 'customModel' && (
          <>
            <text style={{ color: colors.bright }}>Enter the model name:</text>
            <input
              value={model}
              onChange={(v: string) => setModel(v)}
              onSubmit={handleCustomModelSubmit}
            />
          </>
        )}

        {step === 'embedding' && (
          <>
            <text style={{ color: colors.bright }}>Choose embedding strategy:</text>
            <OptionList options={embeddingOptions} onSelect={handleEmbeddingSelect} />
          </>
        )}

        {step === 'license' && (
          <>
            <text style={{ color: colors.bright }}>
              Enter your license key (press Enter to skip):
            </text>
            <input
              value={licenseKey}
              onChange={(v: string) => setLicenseKey(v)}
              onSubmit={handleLicenseSubmit}
              placeholder="SA-XXXX-XXXX-XXXX-XXXX"
            />
          </>
        )}

        {step === 'done' && (
          <text style={{ color: colors.success }}>
            Configuration saved! Entering Shadow Auditor...
          </text>
        )}

        {error && (
          <box marginTop={1}>
            <text style={{ color: colors.error }}>✖ {error}</text>
          </box>
        )}
      </box>
    </box>
  );
};
