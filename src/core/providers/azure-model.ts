import type {BaseChatModel} from '@langchain/core/language_models/chat_models';

import {AzureChatOpenAI, ChatOpenAI} from '@langchain/openai';

import {
  type AzureProviderConfig,
  normalizeAzureEndpoint,
  validateAzureProviderConfig,
} from '../../utils/azure-provider.js';
import {createAzureTokenProvider} from './azure-auth.js';

export interface AzureModelInput {
  apiKey: string;
  azure: AzureProviderConfig;
  deterministic?: boolean;
  maxOutputTokens?: number;
  maxRetries?: number;
  requestTimeoutMs?: number;
  streaming?: boolean;
}

function resolveAuthentication(
  input: AzureModelInput,
): (() => Promise<string>) | string {
  if (input.azure.authMode === 'entra-id') {
    return createAzureTokenProvider(input.azure);
  }

  if (!input.apiKey) {
    throw new Error('Azure API-key authentication requires a non-empty API key.');
  }

  return input.apiKey;
}

function reasoningOptions(azure: AzureProviderConfig, useResponsesApi: boolean): {
  reasoning?: {
    effort?: AzureProviderConfig['reasoningEffort'];
    summary?: AzureProviderConfig['reasoningSummary'];
  };
  verbosity?: AzureProviderConfig['verbosity'];
} {
  const reasoning = azure.reasoningEffort || azure.reasoningSummary
    ? {
      effort: azure.reasoningEffort,
      summary: useResponsesApi ? azure.reasoningSummary : undefined,
    }
    : undefined;
  return {reasoning, verbosity: azure.verbosity};
}

export function createAzureModel(input: AzureModelInput): BaseChatModel {
  validateAzureProviderConfig(input.azure);
  const modelIdentity = input.azure.model ?? input.azure.deployment;
  const responsesOnly = /(?:^codex|(?:^|-)codex$|^gpt-5\.6-sol$)/i.test(modelIdentity);
  if (responsesOnly && input.azure.apiMode === 'chat-completions') {
    throw new Error(
      `Azure model "${modelIdentity}" requires the Responses API; set azure.apiMode to "responses" or "auto".`,
    );
  }

  const useResponsesApi = input.azure.apiMode === 'responses' ||
    (input.azure.apiMode === 'auto' && responsesOnly);
  if (
    input.azure.endpointType === 'model-inference' &&
    useResponsesApi
  ) {
    throw new Error('The legacy Model Inference API does not support the Responses API.');
  }

  const authentication = resolveAuthentication(input);
  const common = {
    maxRetries: input.maxRetries ?? 4,
    maxTokens: input.maxOutputTokens,
    streaming: input.streaming ?? true,
    temperature: input.deterministic && !/^gpt-5(?:\.|-|$)/i.test(modelIdentity)
      ? 0
      : undefined,
    timeout: input.requestTimeoutMs ?? 120_000,
    ...reasoningOptions(input.azure, useResponsesApi),
  };

  if (input.azure.endpointType === 'azure-openai-legacy') {
    const authFields = input.azure.authMode === 'entra-id'
      ? {azureADTokenProvider: authentication as () => Promise<string>}
      : {azureOpenAIApiKey: authentication as string};
    return new AzureChatOpenAI({
      ...common,
      ...authFields,
      azureOpenAIApiDeploymentName: input.azure.deployment,
      azureOpenAIApiVersion: input.azure.apiVersion,
      azureOpenAIEndpoint: normalizeAzureEndpoint(input.azure),
      useResponsesApi,
    });
  }

  const defaultQuery = input.azure.apiVersion
    ? {'api-version': input.azure.apiVersion}
    : undefined;
  const azureFetch: typeof fetch | undefined = input.azure.authMode === 'api-key'
    ? async (request, init) => {
      const headers = new Headers(init?.headers);
      headers.delete('authorization');
      headers.set('api-key', input.apiKey);
      return globalThis.fetch(request, {...init, headers});
    }
    : undefined;
  return new ChatOpenAI({
    ...common,
    apiKey: authentication,
    configuration: {
      baseURL: normalizeAzureEndpoint(input.azure),
      defaultQuery,
      fetch: azureFetch,
    },
    model: input.azure.deployment,
    useResponsesApi,
  });
}
