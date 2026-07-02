import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { type BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import { type LanguageModel } from 'ai';
import { createOllama } from 'ollama-ai-provider';

import type { ShadowConfig } from '../utils/config.js';

import {
  getProviderBaseUrl,
  isOpenAICompatibleProvider,
  normalizeProviderName,
} from '../utils/provider-catalog.js';

/**
 * Returns the correct model instance based on provider configuration.
 */
export function getModel(config: ShadowConfig): LanguageModel {
  const { apiKey, customBaseUrl, model, provider } = config;
  const normalizedProvider = normalizeProviderName(provider);

  switch (normalizedProvider) {
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(model) as LanguageModel;
    }

    case 'custom': {
      if (!customBaseUrl?.trim()) {
        throw new Error('[SHADOW-AUDITOR] custom provider requires customBaseUrl in configuration.');
      }

      const customProvider = createOpenAI({
        apiKey,
        baseURL: customBaseUrl,
      });
      return customProvider(model) as LanguageModel;
    }

    case 'google': {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(model) as LanguageModel;
    }

    case 'mistral': {
      const mistral = createMistral({ apiKey });
      return mistral(model) as LanguageModel;
    }

    case 'ollama': {
      const ollama = createOllama();
      return ollama(model) as unknown as LanguageModel;
    }

    case 'openai': {
      const openai = createOpenAI({ apiKey });
      return openai(model) as LanguageModel;
    }

    default: {
      if (isOpenAICompatibleProvider(normalizedProvider)) {
        const baseURL = getProviderBaseUrl(normalizedProvider, customBaseUrl);
        if (!baseURL) {
          throw new Error(
            `[SHADOW-AUDITOR] Provider "${normalizedProvider}" requires a base URL but none was configured.`,
          );
        }

        const compatibleProvider = createOpenAI({
          apiKey,
          baseURL,
        });

        return compatibleProvider(model) as LanguageModel;
      }

      throw new Error(
        '[SHADOW-AUDITOR] Unknown provider: ' +
          `"${provider}". Supported: anthropic, openai, google, mistral, ollama, deepseek, qwen, moonshot, nvidia, perplexity, custom.`,
      );
    }
  }
}

export function getLangchainModel(config: ShadowConfig): BaseChatModel {
  const { apiKey, customBaseUrl, model, provider } = config;
  const normalizedProvider = normalizeProviderName(provider);

  switch (normalizedProvider) {
    case 'anthropic': {
      return new ChatAnthropic({ apiKey, modelName: model }) as unknown as BaseChatModel;
    }

    case 'custom': {
      return new ChatOpenAI({ apiKey, configuration: { baseURL: customBaseUrl }, modelName: model }) as unknown as BaseChatModel;
    }

    case 'google': {
      return new ChatGoogleGenerativeAI({ apiKey, model }) as unknown as BaseChatModel;
    }

    default: {
      if (isOpenAICompatibleProvider(normalizedProvider)) {
        const baseURL = getProviderBaseUrl(normalizedProvider, customBaseUrl);
        return new ChatOpenAI({ apiKey, configuration: { baseURL }, modelName: model }) as unknown as BaseChatModel;
      }

      return new ChatOpenAI({ apiKey, modelName: model }) as unknown as BaseChatModel;
    }
  }
}
