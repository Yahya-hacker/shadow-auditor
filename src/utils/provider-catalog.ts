export type SupportedProvider =
  | 'anthropic'
  | 'azure'
  | 'custom'
  | 'deepseek'
  | 'google'
  | 'mistral'
  | 'moonshot'
  | 'nvidia'
  | 'ollama'
  | 'openai'
  | 'openrouter'
  | 'perplexity'
  | 'qwen';

const OPENAI_COMPATIBLE_PROVIDERS = new Set<string>([
  'custom',
  'deepseek',
  'moonshot',
  'nvidia',
  'openai',
  'openrouter',
  'qwen',
]);

const PROVIDER_BASE_URLS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/v1',
  moonshot: 'https://api.moonshot.ai/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
};

const PROVIDER_EMBEDDING_MODELS: Record<string, string> = {
  nvidia: 'nvidia/nv-embedqa-e5-v5',
  openai: 'text-embedding-3-small',
};

const PROVIDER_EMBEDDING_DIMENSIONS: Record<string, number> = {
  nvidia: 1024,
  openai: 1536,
};

/**
 * Known models for each provider, used for interactive selection in the setup wizard.
 * Users can also type a custom model name if their preferred model isn't listed.
 */
export const PROVIDER_MODELS: Record<string, Array<{ label: string; value: string }>> = {
  anthropic: [
    { label: 'Claude Sonnet 4 (recommended)', value: 'claude-sonnet-4-20250514' },
    { label: 'Claude Opus 4', value: 'claude-opus-4-20250514' },
    { label: 'Claude Haiku 3.5', value: 'claude-3-5-haiku-20241022' },
    { label: 'Claude Sonnet 3.5', value: 'claude-3-5-sonnet-20241022' },
  ],
  azure: [
    { label: 'GPT-5.6 Sol', value: 'gpt-5.6-sol' },
    { label: 'GPT-5.4', value: 'gpt-5.4' },
    { label: 'GPT-5.2 Codex', value: 'gpt-5.2-codex' },
    { label: 'GPT-5.2', value: 'gpt-5.2' },
    { label: 'GPT-5.1 Codex', value: 'gpt-5.1-codex' },
    { label: 'GPT-5.1', value: 'gpt-5.1' },
    { label: 'GPT-5', value: 'gpt-5' },
    { label: 'GPT-4.1', value: 'gpt-4.1' },
  ],
  deepseek: [
    { label: 'DeepSeek V4 Pro', value: 'deepseek-v4-pro' },
    { label: 'DeepSeek V4 Flash', value: 'deepseek-v4-flash' },
  ],
  google: [
    { label: 'Gemini 3.6 Flash', value: 'gemini-3.6-flash' },
    { label: 'Gemini 3.5 Flash', value: 'gemini-3.5-flash' },
    { label: 'Gemini 3.5 Flash-Lite', value: 'gemini-3.5-flash-lite' },
    { label: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro' },
  ],
  mistral: [
    { label: 'Mistral Large', value: 'mistral-large-latest' },
    { label: 'Mistral Medium', value: 'mistral-medium-latest' },
    { label: 'Mistral Small', value: 'mistral-small-latest' },
    { label: 'Codestral', value: 'codestral-latest' },
  ],
  moonshot: [
    { label: 'Kimi K3', value: 'kimi-k3' },
    { label: 'Kimi K2.7 Code', value: 'kimi-k2.7-code' },
    { label: 'Kimi K2.6', value: 'kimi-k2.6' },
  ],
  nvidia: [
    { label: 'Llama 3.1 70B Instruct', value: 'meta/llama-3.1-70b-instruct' },
    { label: 'Llama 3.1 405B Instruct', value: 'meta/llama-3.1-405b-instruct' },
    { label: 'Llama 3.1 8B Instruct', value: 'meta/llama-3.1-8b-instruct' },
    { label: 'Nemotron 4 340B Instruct', value: 'nvidia/nemotron-4-340b-instruct' },
  ],
  ollama: [
    { label: 'Llama 3.1 8B', value: 'llama3.1' },
    { label: 'Llama 3.1 70B', value: 'llama3.1:70b' },
    { label: 'Qwen 2.5 Coder 7B', value: 'qwen2.5-coder:7b' },
    { label: 'Qwen 2.5 14B', value: 'qwen2.5:14b' },
  ],
  openai: [
    { label: 'GPT-4o (recommended)', value: 'gpt-4o' },
    { label: 'GPT-4o mini', value: 'gpt-4o-mini' },
    { label: 'o3-mini', value: 'o3-mini' },
    { label: 'o1', value: 'o1' },
    { label: 'GPT-4.1', value: 'gpt-4.1' },
  ],
  openrouter: [
    { label: 'Auto (recommended)', value: 'openrouter/auto' },
    { label: 'GPT-5.2', value: 'openai/gpt-5.2' },
    { label: 'Claude Sonnet 4.5', value: 'anthropic/claude-sonnet-4.5' },
    { label: 'Gemini 3 Flash Preview', value: 'google/gemini-3-flash-preview' },
  ],
  perplexity: [
    { label: 'Sonar Pro', value: 'sonar-pro' },
    { label: 'Sonar', value: 'sonar' },
    { label: 'Sonar Reasoning Pro', value: 'sonar-reasoning-pro' },
  ],
  qwen: [
    { label: 'Qwen Plus (recommended)', value: 'qwen-plus' },
    { label: 'Qwen Turbo', value: 'qwen-turbo' },
    { label: 'Qwen Max', value: 'qwen-max' },
    { label: 'Qwen Coder Plus', value: 'qwen-coder-plus' },
  ],
};

export interface EmbeddingDefaults {
  embeddingModel: string;
  embeddingProvider: 'ollama' | 'openai';
  requiresOllamaInstallPrompt: boolean;
}

export function normalizeProviderName(provider: string): string {
  return provider.trim().toLowerCase();
}

export function providerRequiresApiKey(provider: string): boolean {
  const normalized = normalizeProviderName(provider);
  return normalized !== 'custom' && normalized !== 'ollama';
}

export function isOpenAICompatibleProvider(provider: string): boolean {
  return OPENAI_COMPATIBLE_PROVIDERS.has(normalizeProviderName(provider));
}

export function getProviderBaseUrl(provider: string, customBaseUrl?: string): string | undefined {
  const normalizedProvider = normalizeProviderName(provider);
  if (normalizedProvider === 'custom' || normalizedProvider === 'qwen') {
    const normalizedCustomBaseUrl = customBaseUrl?.trim();
    if (normalizedCustomBaseUrl) return normalizedCustomBaseUrl;
    if (normalizedProvider === 'custom') return undefined;
  }

  return PROVIDER_BASE_URLS[normalizedProvider];
}

/**
 * Check whether a provider has a native cloud embedding API.
 * If true, the user can choose between cloud embeddings, Ollama, or skip.
 */
export function providerHasNativeEmbedding(provider: string): boolean {
  return normalizeProviderName(provider) in PROVIDER_EMBEDDING_MODELS;
}

export function getProviderEmbeddingDimension(provider: string): number | undefined {
  return PROVIDER_EMBEDDING_DIMENSIONS[normalizeProviderName(provider)];
}

/**
 * Get the list of known models for a provider.
 * Returns null for unknown/custom providers (user must type manually).
 */
export function getProviderModels(provider: string): Array<{ label: string; value: string }> | null {
  const normalizedProvider = normalizeProviderName(provider);
  return PROVIDER_MODELS[normalizedProvider] ?? null;
}

/**
 * Fetch available models from an OpenAI-compatible API endpoint.
 *
 * Uses native `fetch` (Node ≥ 18) against the standard `GET /models` route
 * that OpenAI-compatible providers commonly expose. Returns `null` only when
 * discovery is unsupported; authentication and connectivity failures surface.
 */
export async function fetchApiModels(
  provider: string,
  apiKey: string,
  customBaseUrl?: string,
): Promise<Array<{ label: string; value: string }> | null> {
  const baseUrl = getProviderBaseUrl(provider, customBaseUrl);
  if (!baseUrl) return null;

  const normalizedProvider = normalizeProviderName(provider);

  // Only attempt for OpenAI-compatible providers
  if (!isOpenAICompatibleProvider(normalizedProvider)) return null;

  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/models`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(8000),
    });

    if (response.status === 404 || response.status === 405) return null;
    if (!response.ok) {
      throw new Error(
        response.status === 401 || response.status === 403
          ? `Provider authentication failed (${response.status}). Check the API key and endpoint.`
          : `Provider model discovery failed with HTTP ${response.status}.`,
      );
    }

    const body = (await response.json()) as {
      data?: Array<{ id: string }>;
    };

    if (!Array.isArray(body.data)) {
      throw new TypeError('Provider returned an invalid model-discovery response.');
    }

    return body.data
      .map((m) => ({ label: m.id, value: m.id }))
      .sort((a, b) => a.value.localeCompare(b.value));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Provider ')) throw error;
    throw new Error(
      `Could not connect to the provider model endpoint: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function getEmbeddingDefaults(provider: string): EmbeddingDefaults {
  const normalizedProvider = normalizeProviderName(provider);

  if (normalizedProvider === 'ollama') {
    return {
      embeddingModel: 'nomic-embed-text',
      embeddingProvider: 'ollama',
      requiresOllamaInstallPrompt: false,
    };
  }

  const providerEmbeddingModel = PROVIDER_EMBEDDING_MODELS[normalizedProvider];
  if (providerEmbeddingModel) {
    return {
      embeddingModel: providerEmbeddingModel,
      embeddingProvider: 'openai',
      requiresOllamaInstallPrompt: false,
    };
  }

  return {
    embeddingModel: 'nomic-embed-text',
    embeddingProvider: 'ollama',
    requiresOllamaInstallPrompt: true,
  };
}
