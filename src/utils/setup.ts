import * as p from '@clack/prompts';
import { loadConfig, saveConfig } from './config.js';
import type { ShadowConfig } from './config.js';

/**
 * Runs the interactive setup wizard if configuration is missing or forced via --reconfigure.
 * Returns the validated configuration object.
 */
export async function runSetupWizard(forceReconfigure = false): Promise<ShadowConfig> {
  // Check existing config unless reconfiguration is forced
  if (!forceReconfigure) {
    const existing = await loadConfig();
    if (existing) return existing;
  }

  p.intro('🔓 SHADOW-AUDITOR :: Configuration Wizard');

  const provider = await p.select({
    message: 'Select your LLM provider:',
    options: [
      { value: 'anthropic', label: 'Anthropic', hint: 'Claude family (claude-3-5-sonnet, claude-3-opus, etc.)' },
      { value: 'openai', label: 'OpenAI', hint: 'GPT-4o, GPT-4, o1, o3, etc.' },
      { value: 'google', label: 'Google', hint: 'Gemini models (gemini-2.5-pro, etc.)' },
      { value: 'mistral', label: 'Mistral', hint: 'Mistral Large, Codestral, etc.' },
      { value: 'ollama', label: 'Ollama', hint: 'Local models (llama3, codellama, etc.)' },
      { value: 'custom', label: 'Custom (OpenAI-Compatible)', hint: 'Any OpenAI-compatible API endpoint' },
    ],
  });

  if (p.isCancel(provider)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  let customBaseUrl: string | undefined;
  if (provider === 'custom') {
    const baseUrl = await p.text({
      message: 'Enter your custom API base URL:',
      placeholder: 'https://api.your-provider.com/v1',
      validate: (value: string | undefined) => {
        if (!value || !value.trim()) return 'Base URL is required for custom providers.';
        try {
          new URL(value);
        } catch {
          return 'Please enter a valid URL.';
        }
      },
    });

    if (p.isCancel(baseUrl)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }

    customBaseUrl = baseUrl as string;
  }

  const model = await p.text({
    message: 'Enter the model name:',
    placeholder: getModelPlaceholder(provider as string),
    validate: (value: string | undefined) => {
      if (!value || !value.trim()) return 'Model name is required.';
    },
  });

  if (p.isCancel(model)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  let apiKey = '';
  if (provider !== 'ollama') {
    const key = await p.password({
      message: 'Enter your API key:',
      validate: (value: string | undefined) => {
        if (!value || !value.trim()) return 'API key is required.';
      },
    });

    if (p.isCancel(key)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }

    apiKey = key as string;
  }

  const config: ShadowConfig = {
    provider: provider as string,
    model: model as string,
    apiKey,
    ...(customBaseUrl ? { customBaseUrl } : {}),
  };

  await saveConfig(config);

  p.outro('✅ Configuration saved to ~/.shadow-auditor.json');

  return config;
}

/**
 * Returns a helpful placeholder for the model input based on the selected provider
 */
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
