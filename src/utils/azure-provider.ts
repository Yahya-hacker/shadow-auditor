export const AZURE_DEFAULT_ENTRA_SCOPE = 'https://ai.azure.com/.default';
export const AZURE_OPENAI_ENTRA_SCOPE = 'https://cognitiveservices.azure.com/.default';

export type AzureApiMode = 'auto' | 'chat-completions' | 'responses';
export type AzureAuthMode = 'api-key' | 'entra-id';
export type AzureCredentialMode = 'default' | 'managed-identity';
export type AzureEndpointType =
  | 'azure-openai-legacy'
  | 'azure-openai-v1'
  | 'foundry-project'
  | 'foundry-resource'
  | 'model-inference';

export interface AzureProviderConfig {
  apiMode: AzureApiMode;
  apiVersion?: string;
  authMode: AzureAuthMode;
  credentialMode?: AzureCredentialMode;
  deployment: string;
  embeddingDeployment?: string;
  embeddingDimension?: number;
  endpoint: string;
  endpointType: AzureEndpointType;
  managedIdentityClientId?: string;
  model?: string;
  reasoningEffort?: 'high' | 'low' | 'medium' | 'minimal' | 'none' | 'xhigh';
  reasoningSummary?: 'auto' | 'concise' | 'detailed';
  tokenScope?: string;
  verbosity?: 'high' | 'low' | 'medium';
}

export function detectAzureEndpointType(endpoint: string): AzureEndpointType | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }

  const hostname = url.hostname.toLowerCase();
  const pathname = stripTrailingSlash(url.pathname).toLowerCase();
  if (hostname.endsWith('.services.ai.azure.com')) {
    return /^\/api\/projects\/[^/]+(?:\/openai\/v1)?$/u.test(pathname)
      ? 'foundry-project'
      : pathname === '' || pathname === '/openai/v1'
        ? 'foundry-resource'
        : undefined;
  }

  if (hostname.endsWith('.models.ai.azure.com')) return 'model-inference';
  if (hostname.endsWith('.openai.azure.com')) {
    if (pathname.includes('/openai/deployments/')) return 'azure-openai-legacy';
    if (pathname === '/openai/v1') return 'azure-openai-v1';
  }

  return undefined;
}

function parseHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid Azure endpoint URL: ${value}`);
  }

  if (url.protocol !== 'https:') {
    throw new Error('Azure endpoints must use HTTPS.');
  }

  url.hash = '';
  url.search = '';
  return url;
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '');
}

export function normalizeAzureEndpoint(config: AzureProviderConfig): string {
  const url = parseHttpsUrl(config.endpoint);
  const path = stripTrailingSlash(url.pathname);

  switch (config.endpointType) {
    case 'azure-openai-legacy': {
      if (!url.hostname.endsWith('.openai.azure.com')) {
        throw new Error('Legacy Azure OpenAI endpoints must use an *.openai.azure.com host.');
      }

      url.pathname = '';
      break;
    }

    case 'azure-openai-v1': {
      if (!url.hostname.endsWith('.openai.azure.com')) {
        throw new Error('Azure OpenAI v1 endpoints must use an *.openai.azure.com host.');
      }

      url.pathname = '/openai/v1';
      break;
    }

    case 'foundry-project': {
      if (!url.hostname.endsWith('.services.ai.azure.com')) {
        throw new Error('Foundry project endpoints must use an *.services.ai.azure.com host.');
      }

      const projectMatch = path.match(/^\/api\/projects\/([^/]+)/);
      if (!projectMatch) {
        throw new Error(
          'Foundry project endpoints must include /api/projects/<project>.',
        );
      }

      url.pathname = `/api/projects/${projectMatch[1]}/openai/v1`;
      break;
    }

    case 'foundry-resource': {
      if (!url.hostname.endsWith('.services.ai.azure.com')) {
        throw new Error('Foundry resource endpoints must use an *.services.ai.azure.com host.');
      }

      url.pathname = '/openai/v1';
      break;
    }

    case 'model-inference': {
      if (path === '') {
        throw new Error(
          'Model Inference endpoints must include the service path returned by Foundry.',
        );
      }

      url.pathname = path;
      break;
    }
  }

  return stripTrailingSlash(url.toString());
}

export function resolveAzureTokenScope(config: AzureProviderConfig): string {
  if (config.tokenScope) return config.tokenScope;
  return config.endpointType === 'azure-openai-legacy'
    ? AZURE_OPENAI_ENTRA_SCOPE
    : AZURE_DEFAULT_ENTRA_SCOPE;
}

export function buildAzureEmbeddingUrl(config: AzureProviderConfig): string {
  const baseUrl = normalizeAzureEndpoint(config);
  const deployment = config.embeddingDeployment;
  if (!deployment) {
    throw new Error('Azure embeddingDeployment is required when semantic indexing is enabled.');
  }

  if (config.endpointType === 'azure-openai-legacy') {
    if (!config.apiVersion) {
      throw new Error('apiVersion is required for legacy Azure OpenAI embeddings.');
    }

    return `${baseUrl}/openai/deployments/${encodeURIComponent(deployment)}` +
      `/embeddings?api-version=${encodeURIComponent(config.apiVersion)}`;
  }

  const url = new URL(`${baseUrl}/embeddings`);
  if (config.apiVersion) url.searchParams.set('api-version', config.apiVersion);
  return url.toString();
}

export function validateAzureProviderConfig(config: AzureProviderConfig): void {
  normalizeAzureEndpoint(config);
  if (config.deployment.trim() === '') {
    throw new Error('Azure deployment must not be empty.');
  }

  const modelIdentity = config.model ?? config.deployment;
  if (/^gpt-5\.6-sol(?:-|$)/i.test(modelIdentity)) {
    if (config.endpointType === 'azure-openai-legacy') {
      throw new Error(
        'gpt-5.6-sol requires an Azure OpenAI v1 or Microsoft Foundry v1 endpoint.',
      );
    }

    if (config.reasoningEffort === 'minimal') {
      throw new Error(
        'gpt-5.6-sol does not support minimal reasoning effort; use none, low, medium, high, or xhigh.',
      );
    }
  }

  if (
    (config.endpointType === 'azure-openai-legacy' ||
      config.endpointType === 'model-inference') &&
    !config.apiVersion
  ) {
    throw new Error(`apiVersion is required for ${config.endpointType} endpoints.`);
  }

  if (
    config.credentialMode === 'managed-identity' &&
    config.managedIdentityClientId !== undefined &&
    config.managedIdentityClientId.trim() === ''
  ) {
    throw new Error('managedIdentityClientId must not be empty when configured.');
  }
}
