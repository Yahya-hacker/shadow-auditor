import type { AzureProviderConfig } from './azure-provider.js';

const AUTH_ERROR_PATTERNS: readonly string[] = [
  'api key',
  '401',
  'authentication',
  'unauthorized',
  'invalid token',
  'key not valid',
  'permission denied',
] as const;

export function isAuthError(message: string): boolean {
  const normalized = message.toLowerCase();
  if (/content[_ -]?filter|responsible ai|policy violation/.test(normalized)) {
    return false;
  }

  return AUTH_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function azureTarget(config: AzureProviderConfig): string {
  const hostname = new URL(config.endpoint).hostname;
  return `${hostname} (${config.endpointType})`;
}

export function diagnoseAzureError(
  message: string,
  config: AzureProviderConfig,
): string {
  const normalized = message.toLowerCase();
  const target = azureTarget(config);

  if (/content[_ -]?filter|responsible ai|policy violation|content management policy/.test(normalized)) {
    return `Azure content filtering blocked the request for ${target}. ` +
      'Revise the flagged input or review the deployment content-filter policy; changing credentials will not resolve this failure.';
  }

  if (
    /\b429\b|rate[_ -]?limit|too_many_requests|quota|tokens per minute|retry after/.test(normalized)
  ) {
    return `Azure throttled the request for ${target} after automatic retries. ` +
      'Wait for the reported retry interval, reduce concurrent token usage, or increase the deployment capacity and regional quota.';
  }

  if (
    config.authMode === 'api-key' &&
    /invalid subscription key|wrong api endpoint|access denied due to invalid/.test(normalized)
  ) {
    return `Azure rejected the API key for ${target}. ` +
      'The key must belong to that exact Azure resource; copy its current key and endpoint together, then run with --reconfigure.';
  }

  if (
    config.authMode === 'entra-id' &&
    (/\b(?:401|403)\b/.test(normalized) ||
      /authentication|authorization|forbidden|permission/.test(normalized))
  ) {
    return `Azure Entra authentication was rejected for ${target}. ` +
      'Verify the selected identity, tenant, token scope, and Azure AI role assignment, then run with --reconfigure.';
  }

  if (
    /\b404\b/.test(normalized) &&
    /deployment|model|resource not found/.test(normalized)
  ) {
    return `Azure deployment "${config.deployment}" was not found on ${target}. ` +
      'Deployment names are resource-specific; verify the deployment and endpoint together, then run with --reconfigure.';
  }

  if (/api[- ]version|unsupported api|invalid api version/.test(normalized)) {
    return `Azure rejected the API contract for ${target}. ` +
      `Verify the endpoint type, API mode, and API version${config.apiVersion ? ` (${config.apiVersion})` : ''}, then run with --reconfigure.`;
  }

  if (isAuthError(message)) {
    const credential = config.authMode === 'api-key' ? 'API key' : 'Entra identity';
    return `Azure ${credential} authentication failed for ${target}. Run with --reconfigure and verify the credential belongs to this resource.`;
  }

  return message;
}

export function toUserFacingError(message: string): string {
  const azureDiagnosticIndex = message.indexOf('Azure ');
  if (azureDiagnosticIndex !== -1) return message.slice(azureDiagnosticIndex);
  if (isAuthError(message)) {
    return 'Authentication failed. Run again with --reconfigure.';
  }

  if (/exceeded its \d+-invocation safety limit/i.test(message)) {
    return 'The audit stage exhausted its invocation ceiling before finalizing its evidence handoff. ' +
      'No partial findings were reported. Increase the affected agent budget with /tools or narrow the audit scope.';
  }

  if (/failed validation|required artifact tags/i.test(message)) {
    return 'The audit stage returned an invalid evidence handoff after schema repair. ' +
      'No partial or unvalidated findings were reported.';
  }

  if (/does not support the external tool contract/i.test(message)) {
    return 'This provider cannot run tool-driven audits. Reconfigure Shadow with a supported tool-calling provider.';
  }

  return `Error: ${message}`;
}
