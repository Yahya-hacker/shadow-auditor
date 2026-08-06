import {HumanMessage} from '@langchain/core/messages';
import {tool} from '@langchain/core/tools';
import {expect} from 'chai';
import {z} from 'zod';

import {resolveModelCapabilities} from '../src/core/model-capabilities.js';
import {createAzureModel} from '../src/core/providers/azure-model.js';
import {
  type AzureProviderConfig,
  buildAzureEmbeddingUrl,
  detectAzureEndpointType,
  normalizeAzureEndpoint,
  validateAzureProviderConfig,
} from '../src/utils/azure-provider.js';
import {validateConfig} from '../src/utils/config.js';
import {
  diagnoseAzureError,
  isAuthError,
  toUserFacingError,
} from '../src/utils/error-classification.js';

function azureConfig(
  overrides: Partial<AzureProviderConfig> = {},
): AzureProviderConfig {
  return {
    apiMode: 'auto',
    authMode: 'api-key',
    deployment: 'security-auditor',
    endpoint: 'https://audit.openai.azure.com',
    endpointType: 'azure-openai-v1',
    model: 'gpt-5.6-sol',
    ...overrides,
  };
}

describe('Azure and Microsoft Foundry provider', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('normalizes each supported endpoint family without accepting lookalike hosts', () => {
    expect(normalizeAzureEndpoint(azureConfig()))
      .to.equal('https://audit.openai.azure.com/openai/v1');
    expect(normalizeAzureEndpoint(azureConfig({
      endpoint: 'https://audit.services.ai.azure.com',
      endpointType: 'foundry-resource',
    }))).to.equal('https://audit.services.ai.azure.com/openai/v1');
    expect(normalizeAzureEndpoint(azureConfig({
      endpoint: 'https://audit.services.ai.azure.com/api/projects/red-team',
      endpointType: 'foundry-project',
    }))).to.equal(
      'https://audit.services.ai.azure.com/api/projects/red-team/openai/v1',
    );
    expect(() => normalizeAzureEndpoint(azureConfig({
      endpoint: 'https://audit.openai.azure.com.attacker.example',
    }))).to.throw('*.openai.azure.com');
    expect(() => normalizeAzureEndpoint(azureConfig({
      endpoint: 'http://audit.openai.azure.com',
    }))).to.throw('HTTPS');
  });

  it('detects Foundry and Azure endpoint families from their canonical URLs', () => {
    expect(detectAzureEndpointType(
      'https://essasbayahya-0244-resource.services.ai.azure.com/openai/v1',
    )).to.equal('foundry-resource');
    expect(detectAzureEndpointType(
      'https://audit.services.ai.azure.com/api/projects/red-team',
    )).to.equal('foundry-project');
    expect(detectAzureEndpointType(
      'https://audit.openai.azure.com/openai/v1',
    )).to.equal('azure-openai-v1');
    expect(detectAzureEndpointType(
      'https://inference.eastus.models.ai.azure.com/models',
    )).to.equal('model-inference');
    expect(detectAzureEndpointType(
      'https://audit.openai.azure.com',
    )).to.equal(undefined);
  });

  it('requires dated API versions only for legacy endpoint surfaces', () => {
    expect(() => validateAzureProviderConfig(azureConfig({
      endpointType: 'azure-openai-legacy',
      model: 'gpt-4.1',
    }))).to.throw('apiVersion is required');
    expect(() => validateAzureProviderConfig(azureConfig({
      endpoint: 'https://inference.eastus.models.ai.azure.com/models',
      endpointType: 'model-inference',
    }))).to.throw('apiVersion is required');
    expect(() => validateAzureProviderConfig(azureConfig())).not.to.throw();
  });

  it('enforces the live gpt-5.6-sol v1 and reasoning contracts', () => {
    expect(() => validateAzureProviderConfig(azureConfig({
      apiVersion: '2025-04-01-preview',
      endpointType: 'azure-openai-legacy',
    }))).to.throw('requires an Azure OpenAI v1 or Microsoft Foundry v1 endpoint');
    expect(() => validateAzureProviderConfig(azureConfig({
      reasoningEffort: 'minimal',
    }))).to.throw('does not support minimal reasoning effort');
    expect(() => validateAzureProviderConfig(azureConfig({
      reasoningEffort: 'none',
    }))).not.to.throw();
  });

  it('builds deployment-scoped legacy and v1 embedding URLs', () => {
    expect(buildAzureEmbeddingUrl(azureConfig({
      embeddingDeployment: 'embed-large',
    }))).to.equal('https://audit.openai.azure.com/openai/v1/embeddings');
    expect(buildAzureEmbeddingUrl(azureConfig({
      apiVersion: '2024-10-21',
      embeddingDeployment: 'embed large',
      endpointType: 'azure-openai-legacy',
    }))).to.equal(
      'https://audit.openai.azure.com/openai/deployments/embed%20large/' +
      'embeddings?api-version=2024-10-21',
    );
  });

  it('accepts secret-free persisted Azure configs before keychain resolution', () => {
    expect(validateConfig({
      apiKey: '',
      azure: azureConfig({authMode: 'entra-id'}),
      model: 'gpt-5.6-sol',
      provider: 'azure',
    })).not.to.equal(null);
    expect(validateConfig({
      apiKey: '',
      azure: azureConfig(),
      model: 'gpt-5.6-sol',
      provider: 'azure',
    })).not.to.equal(null);
  });

  it('registers verified gpt-5.6-sol execution limits', () => {
    const capabilities = resolveModelCapabilities({
      model: 'gpt-5.6-sol',
      provider: 'azure',
    });
    expect(capabilities.maxOutputTokens).to.equal(128_000);
    expect(capabilities.maxToolSteps).to.equal(64);
    expect(capabilities.supportsReasoningMode).to.equal(true);
  });

  it('turns Azure key and endpoint rejection into one actionable diagnostic', () => {
    const diagnostic = diagnoseAzureError(
      '401 Access denied due to invalid subscription key or wrong API endpoint.',
      azureConfig(),
    );

    expect(diagnostic).to.equal(
      'Azure rejected the API key for audit.openai.azure.com (azure-openai-v1). ' +
        'The key must belong to that exact Azure resource; copy its current key and endpoint together, then run with --reconfigure.',
    );
    expect(toUserFacingError(diagnostic)).to.equal(diagnostic);
    expect(toUserFacingError(`Resume failed: ${diagnostic}`)).to.equal(diagnostic);
  });

  it('distinguishes Azure deployment, Entra RBAC, API-version, and content-filter failures', () => {
    expect(diagnoseAzureError(
      '404 The API deployment for this resource does not exist.',
      azureConfig(),
    )).to.include('deployment "security-auditor" was not found');
    expect(diagnoseAzureError(
      '403 Forbidden: permission denied',
      azureConfig({authMode: 'entra-id'}),
    )).to.include('identity, tenant, token scope, and Azure AI role assignment');
    expect(diagnoseAzureError(
      '400 Unsupported api-version',
      azureConfig({apiVersion: '2024-01-01'}),
    )).to.include('API mode, and API version (2024-01-01)');
    const contentFilter = '403 request blocked by the responsible AI content filter';
    expect(isAuthError(contentFilter)).to.equal(false);
    expect(diagnoseAzureError(
      contentFilter,
      azureConfig({authMode: 'entra-id'}),
    )).to.include('content filtering blocked the request');
    expect(diagnoseAzureError(
      contentFilter,
      azureConfig({authMode: 'entra-id'}),
    )).not.to.include('authentication was rejected');
    expect(diagnoseAzureError(
      'rate_limit_exceeded: tokens per minute quota exceeded',
      azureConfig({authMode: 'entra-id'}),
    )).to.include('after automatic retries');
  });

  it('sends deployment names, tools, API-key auth, and API versions to chat completions', async () => {
    let requestBody: {
      model?: string;
      tools?: Array<{function?: {name?: string}}>;
    } = {};
    let requestHeaders = new Headers();
    let requestUrl = '';
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: 'tool_calls',
          index: 0,
          message: {
            content: null,
            role: 'assistant',
            tool_calls: [{
              function: {arguments: '{"path":"src/app.ts"}', name: 'read_file'},
              id: 'call-1',
              type: 'function',
            }],
          },
        }],
        created: 1,
        id: 'chatcmpl-azure',
        model: 'security-auditor',
        object: 'chat.completion',
        usage: {completion_tokens: 10, prompt_tokens: 20, total_tokens: 30},
      }), {headers: {'content-type': 'application/json'}, status: 200});
    };

    const model = createAzureModel({
      apiKey: 'azure-secret',
      azure: azureConfig({
        apiMode: 'chat-completions',
        apiVersion: '2024-05-01-preview',
        endpoint: 'https://inference.eastus.models.ai.azure.com/models',
        endpointType: 'model-inference',
        model: 'security-auditor',
      }),
      streaming: false,
    });
    const readFile = tool(async ({path}) => path, {
      description: 'Read a file',
      name: 'read_file',
      schema: z.object({path: z.string()}),
    });
    if (!model.bindTools) throw new Error('Azure model does not expose tool binding.');
    const response = await model.bindTools([readFile]).invoke([
      new HumanMessage('Inspect the application.'),
    ]);

    expect(requestUrl).to.equal(
      'https://inference.eastus.models.ai.azure.com/models/chat/completions' +
      '?api-version=2024-05-01-preview',
    );
    expect(requestHeaders.get('api-key')).to.equal('azure-secret');
    expect(requestHeaders.has('authorization')).to.equal(false);
    expect(requestBody.model).to.equal('security-auditor');
    expect(requestBody.tools?.[0]?.function?.name).to.equal('read_file');
    expect(response.tool_calls?.[0]?.name).to.equal('read_file');
  });

  it('rejects chat-completions routing for Responses-only Azure models', () => {
    expect(() => createAzureModel({
      apiKey: 'azure-secret',
      azure: azureConfig({apiMode: 'chat-completions'}),
    })).to.throw('requires the Responses API');
  });
});
