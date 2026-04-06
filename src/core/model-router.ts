import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { type LanguageModel } from 'ai';
import { createOllama } from 'ollama-ai-provider';

import type { ShadowConfig } from '../utils/config.js';

/**
 * Returns the correct model instance based on provider configuration.
 */
export function getModel(config: ShadowConfig): LanguageModel {
  const { apiKey, customBaseUrl, model, provider } = config;

  switch (provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(model) as LanguageModel;
    }

    case 'custom': {
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
      throw new Error(
        `[SHADOW-AUDITOR] Unknown provider: "${provider}". Supported: anthropic, openai, google, mistral, ollama, custom.`,
      );
    }
  }
}
