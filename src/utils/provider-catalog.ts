export type SupportedProvider =
  | 'anthropic'
  | 'custom'
  | 'deepseek'
  | 'google'
  | 'mistral'
  | 'moonshot'
  | 'nvidia'
  | 'ollama'
  | 'openai'
  | 'perplexity'
  | 'qwen';

const OPENAI_COMPATIBLE_PROVIDERS = new Set<string>([
  'custom',
  'deepseek',
  'moonshot',
  'nvidia',
  'openai',
  'perplexity',
  'qwen',
]);

const PROVIDER_BASE_URLS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/v1',
  moonshot: 'https://api.moonshot.ai/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  perplexity: 'https://api.perplexity.ai',
  qwen: 'https://ws-w4be56kh33b5j2nl.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
};

const PROVIDER_EMBEDDING_MODELS: Record<string, string> = {
  deepseek: 'deepseek-embedding',
  moonshot: 'text-embedding-v1',
  nvidia: 'nvidia/nv-embedqa-e5-v5',
  openai: 'text-embedding-3-small',
  qwen: 'text-embedding-v3',
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
  deepseek: [
    { label: 'DeepSeek Chat (V3)', value: 'deepseek-chat' },
    { label: 'DeepSeek Reasoner (R1)', value: 'deepseek-reasoner' },
  ],
  google: [
    { label: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro-preview-05-06' },
    { label: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash-preview-05-20' },
    { label: 'Gemini 2.0 Flash', value: 'gemini-2.0-flash' },
    { label: 'Gemini 2.0 Flash-Lite', value: 'gemini-2.0-flash-lite' },
  ],
  mistral: [
    { label: 'Mistral Large', value: 'mistral-large-latest' },
    { label: 'Mistral Medium', value: 'mistral-medium-latest' },
    { label: 'Mistral Small', value: 'mistral-small-latest' },
    { label: 'Codestral', value: 'codestral-latest' },
  ],
  moonshot: [
    { label: 'Moonshot v1 128k', value: 'moonshot-v1-128k' },
    { label: 'Moonshot v1 32k', value: 'moonshot-v1-32k' },
    { label: 'Moonshot v1 8k', value: 'moonshot-v1-8k' },
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
    { label: 'Mistral 7B', value: 'mistral' },
    { label: 'DeepSeek R1', value: 'deepseek-r1' },
    { label: 'CodeLlama 13B', value: 'codellama:13b' },
  ],
  openai: [
    { label: 'GPT-4o (recommended)', value: 'gpt-4o' },
    { label: 'GPT-4o mini', value: 'gpt-4o-mini' },
    { label: 'o3-mini', value: 'o3-mini' },
    { label: 'o1', value: 'o1' },
    { label: 'GPT-4.1', value: 'gpt-4.1' },
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
  return normalizeProviderName(provider) !== 'ollama';
}

export function isOpenAICompatibleProvider(provider: string): boolean {
  return OPENAI_COMPATIBLE_PROVIDERS.has(normalizeProviderName(provider));
}

export function getProviderBaseUrl(provider: string, customBaseUrl?: string): string | undefined {
  const normalizedProvider = normalizeProviderName(provider);
  if (normalizedProvider === 'custom') {
    const normalizedCustomBaseUrl = customBaseUrl?.trim();
    return normalizedCustomBaseUrl || undefined;
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
 * that all OpenAI-compatible providers expose.  Returns `null` on any failure
 * so the caller can fall back to the hardcoded PROVIDER_MODELS list.
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

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) return null;

    const body = (await response.json()) as {
      data?: Array<{ id: string }>;
    };

    if (!Array.isArray(body.data)) return null;

    return body.data
      .map((m) => ({ label: m.id, value: m.id }))
      .sort((a, b) => a.value.localeCompare(b.value));
  } catch {
    return null;
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
