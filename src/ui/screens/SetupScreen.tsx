import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
/**
 * SetupScreen — provider/model/API key configuration.
 *
 * Replaces Ink's `<SelectInput>` with interactive `<Box>` lists
 * navigated via keyboard. `<TextInput>` replaced with `<Input>`.
 */

import type {
  AzureApiMode,
  AzureAuthMode,
  AzureCredentialMode,
  AzureEndpointType,
  AzureProviderConfig,
} from '../../utils/azure-provider.js';
import type { ShadowConfig } from '../../utils/config.js';

import {detectAzureEndpointType, normalizeAzureEndpoint} from '../../utils/azure-provider.js';
import { loadConfig, saveConfig, validateConfig } from '../../utils/config.js';
import {
  fetchApiModels,
  getEmbeddingDefaults,
  getProviderBaseUrl,
  getProviderModels,
  isOpenAICompatibleProvider,
  providerHasNativeEmbedding,
  providerRequiresApiKey,
} from '../../utils/provider-catalog.js';
import { OptionList } from '../components/OptionList.js';
import { Box, Input, type KeyEvent, Text, useKeyHandler } from "../primitives.js";
import { useAppStore } from '../store/appStore.js';
import { colors, spacing } from '../theme/chalkTheme.js';

type Step =
  | 'apiKey' | 'azureApiMode' | 'azureApiVersion' | 'azureAuth' | 'azureClientId'
  | 'azureCredential' | 'azureDeployment' | 'azureEmbeddingDeployment' | 'azureEmbeddingDimension' | 'azureEndpoint'
  | 'azureEndpointType' | 'azureReasoning' | 'azureVerbosity' | 'baseUrl'
  | 'customModel' | 'done' | 'embedding'
  | 'fetching' | 'license' | 'model'
  | 'provider';

const providerOptions = [
  { label: 'Anthropic (Claude)', value: 'anthropic' },
  { label: 'Azure OpenAI / Microsoft Foundry', value: 'azure' },
  { label: 'OpenAI (GPT-4o, o1, o3)', value: 'openai' },
  { label: 'OpenRouter', value: 'openrouter' },
  { label: 'Google (Gemini)', value: 'google' },
  { label: 'Mistral', value: 'mistral' },
  { label: 'DeepSeek', value: 'deepseek' },
  { label: 'Qwen (Alibaba)', value: 'qwen' },
  { label: 'Moonshot AI', value: 'moonshot' },
  { label: 'NVIDIA NIM', value: 'nvidia' },
  { label: 'Ollama (Local)', value: 'ollama' },
  { label: 'Custom (OpenAI-Compatible)', value: 'custom' },
];

const azureEndpointOptions = [
  {label: 'Azure OpenAI v1 (recommended)', value: 'azure-openai-v1'},
  {label: 'Foundry resource v1', value: 'foundry-resource'},
  {label: 'Foundry project v1', value: 'foundry-project'},
  {label: 'Azure OpenAI legacy deployment API', value: 'azure-openai-legacy'},
  {label: 'Foundry Model Inference / deployment target URI', value: 'model-inference'},
];

const azureAuthOptions = [
  {label: 'Microsoft Entra ID (recommended)', value: 'entra-id'},
  {label: 'API key', value: 'api-key'},
];

const azureCredentialOptions = [
  {label: 'DefaultAzureCredential (local development)', value: 'default'},
  {label: 'Managed identity (production)', value: 'managed-identity'},
];

const azureApiModeOptions = [
  {label: 'Responses API (recommended)', value: 'responses'},
  {label: 'Automatic API selection', value: 'auto'},
  {label: 'Chat Completions compatibility mode', value: 'chat-completions'},
];

const azureReasoningOptions = [
  {label: 'Provider default (recommended)', value: '__default__'},
  {label: 'Medium reasoning (recommended)', value: 'medium'},
  {label: 'High reasoning', value: 'high'},
  {label: 'Extra-high reasoning', value: 'xhigh'},
  {label: 'Low reasoning', value: 'low'},
  {label: 'Minimal reasoning', value: 'minimal'},
  {label: 'No reasoning', value: 'none'},
];

const azureVerbosityOptions = [
  {label: 'Provider default (recommended)', value: '__default__'},
  {label: 'Medium verbosity (recommended)', value: 'medium'},
  {label: 'Low verbosity', value: 'low'},
  {label: 'High verbosity', value: 'high'},
];

export const SetupScreen: React.FC = () => {
  const _setScreen = useAppStore((state) => state.setScreen);
  const [step, setStep] = useState<Step>('provider');
  // Holds the one-shot "advance to target selection" timer so it can be
  // cancelled if the component unmounts before it fires — prevents a stale
  // timer from forcing a screen change during shutdown/unmount.
  const navigateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (navigateTimer.current) clearTimeout(navigateTimer.current); }, []);
  const [provider, setProvider] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<Array<{ label: string; value: string }>>([]);
  const [model, setModel] = useState('');
  const [licenseKey, setLicenseKey] = useState('');
  const [embeddingChoice, setEmbeddingChoice] = useState<string>('cloud');
  const [azureApiMode, setAzureApiMode] = useState<AzureApiMode>('responses');
  const [azureApiVersion, setAzureApiVersion] = useState('');
  const [azureAuthMode, setAzureAuthMode] = useState<AzureAuthMode>('entra-id');
  const [azureClientId, setAzureClientId] = useState('');
  const [azureCredentialMode, setAzureCredentialMode] =
    useState<AzureCredentialMode>('default');
  const [azureDeployment, setAzureDeployment] = useState('');
  const [azureEmbeddingDeployment, setAzureEmbeddingDeployment] = useState('');
  const [azureEmbeddingDimension, setAzureEmbeddingDimension] = useState('');
  const [azureEndpoint, setAzureEndpoint] = useState('');
  const [azureEndpointType, setAzureEndpointType] =
    useState<AzureEndpointType>('azure-openai-v1');
  const [azureReasoningEffort, setAzureReasoningEffort] =
    useState<AzureProviderConfig['reasoningEffort']>();
  const [azureVerbosity, setAzureVerbosity] =
    useState<AzureProviderConfig['verbosity']>();
  const [error, setError] = useState('');
  const [fetching, setFetching] = useState(false);
  const [optIndex, setOptIndex] = useState(0);

  useEffect(() => { setOptIndex(0); }, [step]);

  const handleProviderSelect = (value: string) => {
    setProvider(value);
    if (value === 'azure') {
      setStep('azureEndpointType');
    } else if (value === 'custom' || value === 'qwen') {
      setStep('baseUrl');
    } else {
      setStep('apiKey');
    }
  };

  const handleAzureEndpointTypeSelect = (value: string) => {
    setAzureEndpointType(value as AzureEndpointType);
    setStep('azureEndpoint');
  };

  const handleAzureEndpointSubmit = (value: string) => {
    const endpoint = value.trim();
    const effectiveEndpointType = detectAzureEndpointType(endpoint) ?? azureEndpointType;
    try {
      normalizeAzureEndpoint({
        apiMode: azureApiMode,
        apiVersion: 'setup-validation',
        authMode: azureAuthMode,
        deployment: 'setup-validation',
        endpoint,
        endpointType: effectiveEndpointType,
      });
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : String(error_));
      return;
    }

    setAzureEndpoint(endpoint);
    setAzureEndpointType(effectiveEndpointType);
    setError('');
    setStep(
      effectiveEndpointType === 'azure-openai-legacy' ||
      effectiveEndpointType === 'model-inference'
        ? 'azureApiVersion'
        : 'azureAuth',
    );
  };

  const handleAzureApiVersionSubmit = (value: string) => {
    if (!value.trim()) {
      setError('The API version is required for this endpoint surface.');
      return;
    }

    setAzureApiVersion(value.trim());
    setError('');
    setStep('azureAuth');
  };

  const handleAzureAuthSelect = (value: string) => {
    const authMode = value as AzureAuthMode;
    setAzureAuthMode(authMode);
    setStep(authMode === 'api-key' ? 'apiKey' : 'azureCredential');
  };

  const handleAzureCredentialSelect = (value: string) => {
    const credentialMode = value as AzureCredentialMode;
    setAzureCredentialMode(credentialMode);
    setStep(credentialMode === 'managed-identity' ? 'azureClientId' : 'azureDeployment');
  };

  const handleAzureClientIdSubmit = (value: string) => {
    setAzureClientId(value.trim());
    setError('');
    setStep('azureDeployment');
  };

  const handleAzureDeploymentSubmit = (value: string) => {
    if (!value.trim()) {
      setError('The Azure deployment name is required.');
      return;
    }

    setAzureDeployment(value.trim());
    setModels(getProviderModels('azure') ?? []);
    setError('');
    setStep('model');
  };

  const handleBaseUrlSubmit = (value: string) => {
    const submittedBaseUrl = value.trim() || (provider === 'qwen'
      ? getProviderBaseUrl('qwen')
      : undefined);
    if (!submittedBaseUrl) { setError('Base URL is required'); return; }
    try {
      const url = new URL(submittedBaseUrl);
      if (!url.hostname) { setError('Please enter a valid URL'); return; }
      const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        setError('Remote provider endpoints must use HTTPS. HTTP is allowed only for loopback services.');
        return;
      }
    } catch { setError('Please enter a valid URL'); return; }

    setCustomBaseUrl(submittedBaseUrl);
    setError('');
    setStep('apiKey');
  };

  const handleApiKeySubmit = async (value: string) => {
    if (providerRequiresApiKey(provider) && !value.trim()) {
      setError('API key is required');
      return;
    }

    setApiKey(value.trim());
    setError('');
    if (provider === 'azure') {
      setStep('azureDeployment');
      return;
    }

    if (isOpenAICompatibleProvider(provider)) {
      setFetching(true);
      setStep('fetching');
      try {
        const fetched = await fetchApiModels(provider, value.trim(), customBaseUrl || undefined);
        setFetching(false);
        if (fetched && fetched.length > 0) setModels(fetched);
        else setModels(getProviderModels(provider) ?? []);
      } catch (error_) {
        setFetching(false);
        setError(`Failed to fetch models: ${(error_ as Error).message}`);
        setStep('apiKey');
        return;
      }
    } else {
      setModels(getProviderModels(provider) ?? []);
    }

    setStep('model');
  };

  const handleModelSelect = (value: string) => {
    if (value === '__custom__') { setStep('customModel'); return; }
    setModel(value);
    setStep(provider === 'azure' ? 'azureApiMode' : 'embedding');
  };

  const handleCustomModelSubmit = (value: string) => {
    if (!value.trim()) { setError('Model name is required'); return; }
    setModel(value.trim());
    setError('');
    setStep(provider === 'azure' ? 'azureApiMode' : 'embedding');
  };

  const handleAzureApiModeSelect = (value: string) => {
    const apiMode = value as AzureApiMode;
    if (azureEndpointType === 'model-inference' && apiMode === 'responses') {
      setError('The legacy Model Inference surface does not support the Responses API.');
      return;
    }

    setAzureApiMode(apiMode);
    setError('');
    setStep('azureReasoning');
  };

  const handleAzureReasoningSelect = (value: string) => {
    setAzureReasoningEffort(
      value === '__default__' ? undefined : value as AzureProviderConfig['reasoningEffort'],
    );
    setStep('azureVerbosity');
  };

  const handleAzureVerbositySelect = (value: string) => {
    setAzureVerbosity(
      value === '__default__' ? undefined : value as AzureProviderConfig['verbosity'],
    );
    setStep('embedding');
  };

  const handleEmbeddingSelect = (value: string) => {
    setEmbeddingChoice(value);
    setStep(provider === 'azure' && value === 'cloud'
      ? 'azureEmbeddingDeployment'
      : 'license');
  };

  const handleAzureEmbeddingDeploymentSubmit = (value: string) => {
    if (!value.trim()) {
      setError('The Azure embedding deployment name is required.');
      return;
    }

    setAzureEmbeddingDeployment(value.trim());
    setError('');
    setStep('azureEmbeddingDimension');
  };

  const handleAzureEmbeddingDimensionSubmit = (value: string) => {
    const dimension = Number(value);
    if (!Number.isInteger(dimension) || dimension <= 0) {
      setError('Embedding dimension must be a positive integer.');
      return;
    }

    setAzureEmbeddingDimension(String(dimension));
    setError('');
    setStep('license');
  };

  const handleLicenseSubmit = async (value: string) => {
    const trimmed = value.trim();
    const defaults = getEmbeddingDefaults(provider);
    let indexingEnabled = true;
    let embeddingProvider = defaults.embeddingProvider;
    let embeddingModel = defaults.embeddingModel;

    switch (embeddingChoice) {
      case 'cloud': {
        if (provider === 'azure') {
          embeddingProvider = 'openai';
          embeddingModel = azureEmbeddingDeployment;
        } else if (providerHasNativeEmbedding(provider)) {
          embeddingProvider = 'openai';
          embeddingModel = defaults.embeddingModel;
        } else {
          setError('This provider has no supported cloud embedding endpoint. Choose Ollama or skip indexing.');
          setStep('embedding');
          return;
        }

        break;
      }

      case 'ollama': {
        embeddingProvider = 'ollama';
        embeddingModel = 'nomic-embed-text';
        break;
      }

      case 'skip': {
        indexingEnabled = false;
        break;
      }
    }

    const config: ShadowConfig = {
      apiKey,
      azure: provider === 'azure' ? {
        apiMode: azureApiMode,
        apiVersion: azureApiVersion || undefined,
        authMode: azureAuthMode,
        credentialMode: azureCredentialMode,
        deployment: azureDeployment,
        embeddingDeployment: embeddingChoice === 'cloud'
          ? azureEmbeddingDeployment
          : undefined,
        embeddingDimension: embeddingChoice === 'cloud'
          ? Number(azureEmbeddingDimension)
          : undefined,
        endpoint: azureEndpoint,
        endpointType: azureEndpointType,
        managedIdentityClientId: azureClientId || undefined,
        model,
        reasoningEffort: azureReasoningEffort,
        verbosity: azureVerbosity,
      } : undefined,
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

    const validated = validateConfig(config);
    if (!validated) {
      setError('The selected provider, model, endpoint, or reasoning settings are incompatible.');
      return;
    }

    try {
      await saveConfig(validated);
      const freshCfg = await loadConfig();
      if (!freshCfg) {
        throw new Error('The saved configuration could not be loaded. Check credential storage and provider settings.');
      }

      const s = useAppStore.getState();
      s.setConfig(freshCfg);
      setStep('done');
            navigateTimer.current = setTimeout(() => s.setScreen('target'), 1500);
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : String(error_));
    }
  };

  const modelOptions = useMemo(() => [
    ...models.map((m) => ({ label: m.label, value: m.value })),
    { label: 'Type a custom model name...', value: '__custom__' },
  ], [models]);

  const embeddingOptions = useMemo(() => [
    ...((provider === 'azure' || providerHasNativeEmbedding(provider))
      ? [{ label: `Cloud embeddings via ${provider || 'provider'}`, value: 'cloud' }]
      : []),
    { label: 'Local Ollama embeddings (nomic-embed-text)', value: 'ollama' },
    { label: 'Skip semantic indexing', value: 'skip' },
  ], [provider]);

  // Keyboard handler for OptionList-style steps (provider, model, embedding).
  // Input steps (baseUrl, apiKey, customModel, license) handle their own keys.
  const optionSteps = new Set<Step>([
    'azureApiMode',
    'azureAuth',
    'azureCredential',
    'azureEndpointType',
    'azureReasoning',
    'azureVerbosity',
    'embedding',
    'model',
    'provider',
  ]);

  const getOptionsForStep = useCallback((): Array<{ label: string; value: string }> => {
    if (step === 'provider') return providerOptions;
    if (step === 'model') return modelOptions;
    if (step === 'embedding') return embeddingOptions;
    if (step === 'azureEndpointType') return azureEndpointOptions;
    if (step === 'azureAuth') return azureAuthOptions;
    if (step === 'azureCredential') return azureCredentialOptions;
    if (step === 'azureApiMode') return azureApiModeOptions;
    if (step === 'azureReasoning') return azureReasoningOptions;
    if (step === 'azureVerbosity') return azureVerbosityOptions;
    return [];
  }, [step, modelOptions, embeddingOptions]);

  const handleKeyDown = useCallback(
    (evt: KeyEvent) => {
      if (!optionSteps.has(step)) return;
      const opts = getOptionsForStep();
      if (opts.length === 0) return;
      switch (evt.key) {
        case 'ArrowDown':
        case 'j': {
          evt.preventDefault();
          setOptIndex((p) => Math.min(p + 1, opts.length - 1));
          break;
        }

        case 'ArrowUp':
        case 'k': {
          evt.preventDefault();
          setOptIndex((p) => Math.max(p - 1, 0));
          break;
        }

        case 'Enter': {
          evt.preventDefault();
          switch (step) {
            case 'azureApiMode': {
              handleAzureApiModeSelect(opts[optIndex]!.value);
              break;
            }

            case 'azureAuth': {
              handleAzureAuthSelect(opts[optIndex]!.value);
              break;
            }

            case 'azureCredential': {
              handleAzureCredentialSelect(opts[optIndex]!.value);
              break;
            }

            case 'azureEndpointType': {
              handleAzureEndpointTypeSelect(opts[optIndex]!.value);
              break;
            }

            case 'azureReasoning': {
              handleAzureReasoningSelect(opts[optIndex]!.value);
              break;
            }

            case 'azureVerbosity': {
              handleAzureVerbositySelect(opts[optIndex]!.value);
              break;
            }

            case 'embedding': {
              handleEmbeddingSelect(opts[optIndex]!.value);
              break;
            }

            case 'model': {
              handleModelSelect(opts[optIndex]!.value);
              break;
            }

            case 'provider': {
              handleProviderSelect(opts[optIndex]!.value);
              break;
            }

          }

          break;
        }

      }
    },
    [step, optIndex, getOptionsForStep],
  );

  useKeyHandler(handleKeyDown);

  const renderAzureStep = () => {
    switch (step) {
      case 'azureApiMode': {
        return (
          <>
            <Text color={colors.bright}>Select the Azure model API mode:</Text>
            <OptionList
              highlightedIndex={optIndex}
              onSelect={handleAzureApiModeSelect}
              options={azureApiModeOptions}
            />
          </>
        );
      }

      case 'azureApiVersion': {
        return (
          <>
            <Text color={colors.bright}>Enter the API version required by this deployment:</Text>
            <Input
              onChange={setAzureApiVersion}
              onSubmit={handleAzureApiVersionSubmit}
              placeholder="2024-10-21"
              value={azureApiVersion}
            />
          </>
        );
      }

      case 'azureAuth': {
        return (
          <>
            <Text color={colors.bright}>Select Azure authentication:</Text>
            <OptionList
              highlightedIndex={optIndex}
              onSelect={handleAzureAuthSelect}
              options={azureAuthOptions}
            />
          </>
        );
      }

      case 'azureClientId': {
        return (
          <>
            <Text color={colors.bright}>
              Enter a user-assigned managed identity client ID (Enter for system-assigned):
            </Text>
            <Input
              onChange={setAzureClientId}
              onSubmit={handleAzureClientIdSubmit}
              value={azureClientId}
            />
          </>
        );
      }

      case 'azureCredential': {
        return (
          <>
            <Text color={colors.bright}>Select the Microsoft Entra credential chain:</Text>
            <OptionList
              highlightedIndex={optIndex}
              onSelect={handleAzureCredentialSelect}
              options={azureCredentialOptions}
            />
          </>
        );
      }

      case 'azureDeployment': {
        return (
          <>
            <Text color={colors.bright}>
              Enter the Azure model deployment name (not the catalog model ID):
            </Text>
            <Input
              onChange={setAzureDeployment}
              onSubmit={handleAzureDeploymentSubmit}
              value={azureDeployment}
            />
          </>
        );
      }

      case 'azureEmbeddingDeployment': {
        return (
          <>
            <Text color={colors.bright}>Enter the Azure embedding deployment name:</Text>
            <Input
              onChange={setAzureEmbeddingDeployment}
              onSubmit={handleAzureEmbeddingDeploymentSubmit}
              value={azureEmbeddingDeployment}
            />
          </>
        );
      }

      case 'azureEmbeddingDimension': {
        return (
          <>
            <Text color={colors.bright}>Enter the embedding deployment output dimension:</Text>
            <Input
              onChange={setAzureEmbeddingDimension}
              onSubmit={handleAzureEmbeddingDimensionSubmit}
              placeholder="1536"
              value={azureEmbeddingDimension}
            />
          </>
        );
      }

      case 'azureEndpoint': {
        return (
          <>
            <Text color={colors.bright}>Enter the Azure or Foundry endpoint:</Text>
            <Input
              onChange={setAzureEndpoint}
              onSubmit={handleAzureEndpointSubmit}
              placeholder="https://resource.openai.azure.com"
              value={azureEndpoint}
            />
          </>
        );
      }

      case 'azureEndpointType': {
        return (
          <>
            <Text color={colors.bright}>Select the Azure API endpoint surface:</Text>
            <OptionList
              highlightedIndex={optIndex}
              onSelect={handleAzureEndpointTypeSelect}
              options={azureEndpointOptions}
            />
          </>
        );
      }

      case 'azureReasoning': {
        return (
          <>
            <Text color={colors.bright}>Select the model reasoning effort:</Text>
            <OptionList
              highlightedIndex={optIndex}
              onSelect={handleAzureReasoningSelect}
              options={azureReasoningOptions}
            />
          </>
        );
      }

      case 'azureVerbosity': {
        return (
          <>
            <Text color={colors.bright}>Select response verbosity:</Text>
            <OptionList
              highlightedIndex={optIndex}
              onSelect={handleAzureVerbositySelect}
              options={azureVerbosityOptions}
            />
          </>
        );
      }

      default: {
        return null;
      }
    }
  };

  const renderGeneralStep = () => {
    switch (step) {
      case 'apiKey': {
        return (
          <>
            <Text color={colors.bright}>
              Enter your {provider === 'azure' ? 'Azure ' : ''}API key (stored securely in OS vault):
            </Text>
            <Input
              mask="*"
              onChange={(v: string) => setApiKey(v)}
              onSubmit={handleApiKeySubmit}
              placeholder="••••••••"
              value={apiKey}
            />
          </>
        );
      }

      case 'baseUrl': {
        return (
          <>
            <Text color={colors.bright}>
              {provider === 'qwen'
                ? 'Enter the Qwen API base URL (Enter for international; use dashscope.aliyuncs.com for mainland China):'
                : 'Enter your custom API base URL:'}
            </Text>
            <Input
              onChange={(v: string) => setCustomBaseUrl(v)}
              onSubmit={handleBaseUrlSubmit}
              placeholder={provider === 'qwen'
                ? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
                : 'https://api.your-provider.com/v1'}
              value={customBaseUrl}
            />
          </>
        );
      }

      case 'customModel': {
        return (
          <>
            <Text color={colors.bright}>Enter the model name:</Text>
            <Input
              onChange={(v: string) => setModel(v)}
              onSubmit={handleCustomModelSubmit}
              value={model}
            />
          </>
        );
      }

      case 'done': {
        return (
          <Text color={colors.success}>
            Configuration saved! Entering Shadow Auditor...
          </Text>
        );
      }

      case 'embedding': {
        return (
          <>
            <Text color={colors.bright}>Choose embedding strategy:</Text>
            <OptionList highlightedIndex={optIndex} onSelect={handleEmbeddingSelect} options={embeddingOptions} />
          </>
        );
      }

      case 'fetching': {
        return <Text color={colors.agent}>Fetching live models from API...</Text>;
      }

      case 'license': {
        return (
          <>
            <Text color={colors.bright}>
              Enter your license key (press Enter to skip):
            </Text>
            <Input
              onChange={(v: string) => setLicenseKey(v)}
              onSubmit={handleLicenseSubmit}
              placeholder="SA-XXXX-XXXX-XXXX-XXXX"
              value={licenseKey}
            />
          </>
        );
      }

      case 'model': {
        return (
          <>
            <Text color={colors.bright}>
              {fetching ? 'Select a model (live list):' : 'Select a model:'}
            </Text>
            <OptionList highlightedIndex={optIndex} onSelect={handleModelSelect} options={modelOptions} />
          </>
        );
      }

      case 'provider': {
        return (
          <>
            <Text color={colors.bright}>Select your LLM provider:</Text>
            <OptionList highlightedIndex={optIndex} onSelect={handleProviderSelect} options={providerOptions} />
          </>
        );
      }

      default: {
        return null;
      }
    }
  };

  return (
    <Box flexDirection="column" paddingX={spacing.panelPadX}>
      <Box
        borderColor={colors.brand} borderStyle={'rounded'}
        paddingX={spacing.panelPadX}
        paddingY={spacing.panelPadY}
      >
        <Text bold color={colors.brand}>
          ◈ Shadow Auditor — Environment Setup
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {renderAzureStep()}
        {renderGeneralStep()}

        {error && (
          <Box marginTop={1}>
            <Text color={colors.error}>✖ {error}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};
