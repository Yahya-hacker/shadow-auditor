type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

/**
 * Minimal structural contract for the fetch implementation the OpenAI SDK and
 * LangChain's ChatOpenAI accept in their `configuration.fetch` slot. Kept local
 * so this module has no dependency on either package's type surface.
 */
export type OpenAIFetchImplementation = (
  input: FetchInput,
  init?: FetchInit,
) => Promise<Response>;

interface DiagnosticFetchOptions {
  /** Human-facing label for the provider (e.g. "custom", "qwen", "openrouter"). */
  provider: string;
}

function endpointPath(input: FetchInput): string {
  try {
    const raw = typeof input === 'string' || input instanceof URL
      ? input.toString()
      : (input as undefined | {url?: unknown})?.url;
    if (typeof raw !== 'string') return '';
    return new URL(raw).pathname || '/';
  } catch {
    return '';
  }
}

function requestedModel(init?: FetchInit): string | undefined {
  const body = init?.body;
  if (typeof body !== 'string') return undefined;
  try {
    const parsed = JSON.parse(body) as {model?: unknown};
    return typeof parsed.model === 'string' ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

function recordValue(parsed: unknown): Record<string, unknown> | undefined {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  return parsed as Record<string, unknown>;
}

function providerMessage(record: Record<string, unknown>): string | undefined {
  for (const key of ['error', 'message', 'msg', 'error_message', 'detail']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'object' && value !== null) {
      const nested = recordValue(value);
      const nestedMessage = nested?.message;
      if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
        return nestedMessage.trim();
      }

      const nestedMsg = nested?.msg;
      if (typeof nestedMsg === 'string' && nestedMsg.trim()) {
        return nestedMsg.trim();
      }
    }
  }

  return undefined;
}

interface DiagnosticDetails {
  code?: string;
  model?: string;
  path: string;
  provider: string;
  status: number;
}

function diagnosticGuidance({code, model, path, provider, status}: DiagnosticDetails): string {
  const target = model && model.trim() ? ` for model "${model.trim()}"` : '';
  const where = path ? ` (POST ${path})` : '';
  const codeSuffix = code ? ` [code: ${code}]` : '';
  return (
    `The provider "${provider}" rejected the request with HTTP ${status}${codeSuffix}${target}${where} ` +
    'and returned no error detail. The most common causes, in order: (1) the model name is not served by ' +
    'this endpoint, (2) the request exceeded the model context window, or (3) the endpoint rejected an ' +
    'unsupported parameter (for example streaming tool calls). Verify the model name and base URL (run with ' +
    '--reconfigure), reduce the audit scope, or switch to a different model.'
  );
}

/**
 * OpenAI-compatible gateways frequently answer a bad request with either an
 * empty body or a non-standard JSON envelope (`{code, msg}`). The OpenAI SDK
 * only understands a top-level `error` object, so those responses collapse to
 * the opaque "400 status code (no body)". This fetch decorator normalises
 * provider error bodies into the OpenAI shape the SDK can surface, and
 * synthesises an actionable diagnostic when the provider sent nothing at all.
 */
export function diagnosticOpenAIFetch(
  upstream: OpenAIFetchImplementation,
  {provider}: DiagnosticFetchOptions,
): OpenAIFetchImplementation {
  return async (input, init) => {
    const response = await upstream(input, init);
    if (response.ok) return response;

    const status = response.status;
    const path = endpointPath(input);
    const model = requestedModel(init);

    let text = '';
    try {
      text = await response.clone().text();
    } catch {
      text = '';
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return new Response(
        JSON.stringify({
          error: {
            message: diagnosticGuidance({model, path, provider, status}),
            type: 'provider_request_rejected',
          },
        }),
        {headers: {'content-type': 'application/json'}, status, statusText: response.statusText},
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Non-JSON body (plain text or HTML): the SDK already surfaces it, so
      // leave it untouched rather than substituting our own wording.
      return response;
    }

    const record = recordValue(parsed);
    if (!record) return response;

    // Already in the OpenAI `{error: {message, ...}}` shape the SDK understands.
    if (typeof record.error === 'object' && record.error !== null) return response;

    const code = ['code', 'status_code', 'status'].map((key) => record[key]).find(
      (value): value is number | string =>
        typeof value === 'string' || typeof value === 'number',
    );

    const detail = providerMessage(record)
          ?? diagnosticGuidance({
            code: code === undefined ? undefined : String(code),
            model,
            path,
            provider,
            status,
          });

    const errorPayload: Record<string, unknown> = {
      message: detail,
      type: 'provider_request_rejected',
    };
    if (code !== undefined) errorPayload.code = String(code);

    return new Response(
      JSON.stringify({error: errorPayload}),
      {headers: {'content-type': 'application/json'}, status, statusText: response.statusText},
    );
  };
}