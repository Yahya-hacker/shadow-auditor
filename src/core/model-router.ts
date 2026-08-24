import { ChatAnthropic } from '@langchain/anthropic';
import { type BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatMistralAI } from '@langchain/mistralai';
import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAI } from '@langchain/openai';

import type { ShadowConfig } from '../utils/config.js';

import {
  getProviderBaseUrl,
  isOpenAICompatibleProvider,
  normalizeProviderName,
} from '../utils/provider-catalog.js';
import {createAzureModel} from './providers/azure-model.js';
import {DeepSeekChatOpenAI} from './providers/deepseek-model.js';

/**
 * Bridge cast for LangChain model type interop.
 * ChatAnthropic / ChatGoogleGenerativeAI / ChatOpenAI implement BaseChatModel
 * structurally, but their TypeScript declarations diverge across package
 * versions. This adapter centralises the cast so each call-site stays
 * readable and the rationale is documented once.
 */
function asBaseChatModel(model: unknown): BaseChatModel {
  return model as BaseChatModel;
}

function deterministicTemperature(
  deterministic: boolean,
  provider: string,
  model: string,
): number | undefined {
  if (!deterministic) return undefined;
  if (provider === 'moonshot' || provider === 'custom') return undefined;
  if (provider === 'deepseek' && /(?:reason|r\d|v4)/i.test(model)) return undefined;
  if (provider === 'openai' && /^(?:gpt-5|o\d)/i.test(model)) return undefined;
  return 0;
}

function deepSeekReasoningSettings(
  effort: ShadowConfig['reasoningEffort'],
): Record<string, unknown> | undefined {
  if (!effort) return undefined;
  if (effort === 'none') return {thinking: {type: 'disabled'}};

  const reasoningEffort = effort === 'minimal' || effort === 'low'
    ? 'low'
    : effort === 'xhigh'
      ? 'max'
      : 'high';
  return {
    reasoning_effort: reasoningEffort,
    thinking: {type: 'enabled'},
  };
}

function reasoningSettings(
  effort: ShadowConfig['reasoningEffort'],
): undefined | {effort: NonNullable<ShadowConfig['reasoningEffort']>} {
  return effort ? {effort} : undefined;
}

export function getLangchainModel(config: ShadowConfig): BaseChatModel {
  const { apiKey, customBaseUrl, model, provider } = config;
  const normalizedProvider = normalizeProviderName(provider);
  const deterministic = config.ci?.enabled === true;
  const maxTokens = config.maxOutputTokens;
  const temperature = deterministicTemperature(deterministic, normalizedProvider, model);
  const reasoning = reasoningSettings(config.reasoningEffort);

  switch (normalizedProvider) {
    case 'anthropic': {
      return asBaseChatModel(new ChatAnthropic({
        apiKey,
            clientOptions: {timeout: 120_000},
            maxRetries: 2,
            maxTokens,
            modelName: model,
            temperature,
          }));
        }

    case 'azure': {
      if (!config.azure) {
        throw new Error('[SHADOW-AUDITOR] Azure provider requires azure configuration.');
      }

      return asBaseChatModel(createAzureModel({
        apiKey,
        azure: {
          ...config.azure,
          reasoningEffort: config.reasoningEffort ?? config.azure.reasoningEffort,
        },
        deterministic,
        maxOutputTokens: maxTokens,
      }));
    }

    case 'custom': {
      if (!customBaseUrl?.trim()) {
        throw new Error('[SHADOW-AUDITOR] custom provider requires customBaseUrl in configuration.');
      }

      return asBaseChatModel(new ChatOpenAI({
        apiKey,
              configuration: { baseURL: customBaseUrl, timeout: 120_000 },
        maxRetries: 2,
        maxTokens,
        modelName: model,
        temperature,
      }));
    }

    case 'deepseek': {
      const baseURL = getProviderBaseUrl(normalizedProvider, customBaseUrl);
      if (!baseURL) {
        throw new Error('[SHADOW-AUDITOR] DeepSeek provider requires a base URL.');
      }

      return asBaseChatModel(new DeepSeekChatOpenAI({
        apiKey,
              configuration: {baseURL, timeout: 120_000},
        maxRetries: 2,
        maxTokens,
        modelKwargs: deepSeekReasoningSettings(config.reasoningEffort),
        modelName: model,
        temperature,
      }));
    }

    case 'google': {
      return asBaseChatModel(new ChatGoogleGenerativeAI({
        apiKey,
        maxOutputTokens: maxTokens,
        maxRetries: 2,
        model,
        temperature,
      }));
    }

    case 'mistral': {
      return asBaseChatModel(new ChatMistralAI({
        apiKey,
        maxRetries: 2,
        maxTokens,
        model,
        streamUsage: true,
        temperature,
      }));
    }

    case 'ollama': {
      return asBaseChatModel(new ChatOllama({
        baseUrl: customBaseUrl?.trim() || 'http://127.0.0.1:11434',
        maxRetries: 2,
        model,
        numPredict: maxTokens,
        streaming: true,
        temperature,
      }));
    }

    case 'openai': {
      const useResponsesApi = /(?:codex|^gpt-5\.6-sol$)/i.test(model);
      return asBaseChatModel(new ChatOpenAI({
        apiKey,
        maxRetries: 2,
        maxTokens,
        modelName: model,
        reasoning,
        temperature,
              timeout: 120_000,
              useResponsesApi,
            }));
    }

    case 'perplexity': {
      throw new Error(
        '[SHADOW-AUDITOR] Perplexity Sonar does not support the external tool contract required by the deterministic audit pipeline. Use a tool-capable provider; Perplexity support is disabled rather than silently issuing incompatible Chat Completions requests.',
      );
    }

    default: {
      if (isOpenAICompatibleProvider(normalizedProvider)) {
        const baseURL = getProviderBaseUrl(normalizedProvider, customBaseUrl);
        if (!baseURL) {
          throw new Error(
            `[SHADOW-AUDITOR] Provider "${normalizedProvider}" requires a base URL but none was configured.`,
          );
        }

        return asBaseChatModel(new ChatOpenAI({
          apiKey,
                  configuration: { baseURL, timeout: 120_000 },
          maxRetries: 2,
          maxTokens,
          modelName: model,
          temperature,
        }));
      }

      throw new Error(
        '[SHADOW-AUDITOR] Unknown provider: ' +
          `"${provider}". Supported: anthropic, azure, openai, openrouter, google, mistral, ollama, deepseek, qwen, moonshot, nvidia, custom.`,
      );
    }
  }
}
