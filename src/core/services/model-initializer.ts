/**
 * Model Initializer — embedding provider factory.
 *
 * Creates the correct EmbeddingProvider based on ShadowConfig settings:
 * - Ollama for local zero-data-leakage embeddings
 * - OpenAI-compatible for hosted providers
 * - NullEmbeddingProvider as a fallback for testing
 *
 * Extracted from AgentSession so it can be reused by other components
 * that need embedding access without depending on the full session.
 */

import type { ShadowConfig } from '../../utils/config.js';

import {buildAzureEmbeddingUrl} from '../../utils/azure-provider.js';
import {
  getEmbeddingDefaults,
  getProviderBaseUrl,
  getProviderEmbeddingDimension,
  normalizeProviderName,
  providerRequiresApiKey,
} from '../../utils/provider-catalog.js';
import {
  type EmbeddingProvider,

  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
} from '../memory/semantic-index.js';
import {createAzureTokenProvider} from '../providers/azure-auth.js';

/**
 * Build an EmbeddingProvider that matches the current configuration.
 *
 * @throws If a non-Ollama provider is selected but no API key is available.
 */
export function createEmbeddingProvider(config: ShadowConfig): EmbeddingProvider {
  const indexingConfig = config.indexing;
  const providerDefaults = getEmbeddingDefaults(config.provider);
  const embeddingProvider = indexingConfig?.embeddingProvider ?? providerDefaults.embeddingProvider;
  const embeddingModel = indexingConfig?.embeddingModel ?? providerDefaults.embeddingModel;

  if (embeddingProvider === 'ollama') {
    return new OllamaEmbeddingProvider({
      baseUrl: indexingConfig?.embeddingBaseUrl,
      dimension: indexingConfig?.embeddingDimension,
      model: embeddingModel,
    });
  }

  const normalizedProvider = normalizeProviderName(config.provider);
  if (normalizedProvider === 'azure') {
    if (!config.azure) {
      throw new Error('[SemanticIndex] Azure provider requires azure configuration.');
    }

    if (!config.azure.embeddingDimension) {
      throw new Error(
        '[SemanticIndex] azure.embeddingDimension is required for Azure embeddings.',
      );
    }

    const tokenProvider = config.azure.authMode === 'entra-id'
      ? createAzureTokenProvider(config.azure)
      : undefined;
    return new OpenAIEmbeddingProvider({
      apiKey: config.apiKey,
      credentialHeader: config.azure.authMode === 'api-key' ? 'api-key' : 'authorization',
      dimension: config.azure.embeddingDimension,
      endpointUrl: buildAzureEmbeddingUrl(config.azure),
      model: config.azure.embeddingDeployment,
      providerName: normalizedProvider,
      tokenProvider,
    });
  }

  if (providerRequiresApiKey(config.provider) && !config.apiKey) {
    throw new Error(
      `[SemanticIndex] Embedding provider "${embeddingProvider}" requires an API key for "${config.provider}".`,
    );
  }

  const baseUrl = getProviderBaseUrl(normalizedProvider, config.customBaseUrl);

  return new OpenAIEmbeddingProvider({
    apiKey: config.apiKey,
    baseUrl,
    dimension: getProviderEmbeddingDimension(normalizedProvider),
    model: embeddingModel,
    providerName: normalizedProvider,
  });
}

// Re-export for callers that previously imported these from agent.ts internals



export {type EmbeddingProvider, NullEmbeddingProvider, OllamaEmbeddingProvider, OpenAIEmbeddingProvider} from '../memory/semantic-index.js';