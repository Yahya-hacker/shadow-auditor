/**
 * Standards-compliant MCP Streamable HTTP client with SSRF-safe DNS pinning.
 */

import type { LookupFunction } from 'node:net';

import * as http from 'node:http';
import * as https from 'node:https';

import type { MCPRawInvoker } from '../mcp/types.js';

import { logToStderr } from '../../utils/stderr-logger.js';
import { resolveExternalUrl, validateExternalUrl } from './ssrf-protection.js';

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MCP_PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcResponse {
  error?: { code?: number; data?: unknown; message?: string };
  id?: number | string;
  jsonrpc: '2.0';
  result?: unknown;
}

interface PinnedRequest {
  address: string;
  body: string;
  family: 4 | 6;
  headers: Record<string, string>;
  method: 'GET' | 'POST';
  signal: AbortSignal;
  url: URL;
}

interface PinnedResponse {
  body: string;
  headers: http.IncomingHttpHeaders;
  statusCode: number;
}

export function maybeCreateHttpInvoker(endpoint?: string): MCPRawInvoker | undefined {
  return createHttpInvoker(endpoint, resolveExternalUrl);
}

export function createHttpInvoker(
  endpoint: string | undefined,
  resolver: typeof resolveExternalUrl,
): MCPRawInvoker | undefined {
  const parsedUrl = validateExternalUrl(endpoint ?? '');
  if (!parsedUrl) {
    const normalized = endpoint?.trim();
    if (normalized) {
      logToStderr(`[MCP] Invalid or blocked endpoint URL: "${normalized}". MCP adapter disabled.`);
    }

    return undefined;
  }

  const validUrl = parsedUrl.href;
  let initializePromise: Promise<void> | undefined;
  let requestId = 0;
  let sessionId: string | undefined;

  async function rpc(
    method: string,
    parameters: Record<string, unknown>,
    signal: AbortSignal,
    notification = false,
  ): Promise<unknown> {
    const id = notification ? undefined : ++requestId;
    const resolved = await resolver(validUrl);
    if (!resolved) {
      throw new Error('MCP endpoint resolved to a blocked or unavailable address.');
    }

    let response = await pinnedPost({
      address: resolved.address,
      body: JSON.stringify({
        ...(id === undefined ? {} : { id }),
        jsonrpc: '2.0',
        method,
        params: parameters,
      }),
      family: resolved.family,
      headers: {
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      method: 'POST',
      signal,
      url: resolved.url,
    });

    // Streamable HTTP long-task flow: a spec-compliant server may defer slow
    // operations (e.g. kali/chrome tools) with 202 Accepted plus a Location
    // polling URL, delivering the JSON-RPC result only once the task finishes.
    // Follow the Location chain instead of treating 202 as a hard error.
    if (response.statusCode === 202 && typeof response.headers.location === 'string') {
      response = await followLocation(response.headers.location, resolved.family, signal);
    }

    const responseSession = response.headers['mcp-session-id'];
    if (typeof responseSession === 'string' && responseSession.trim()) {
      sessionId = responseSession;
    }

    if (id === undefined || !response.body.trim()) return undefined;
    const payload = parseMcpResponse(response.body, id);
    if (payload.error) {
      const code = payload.error.code === undefined ? '' : ` (${payload.error.code})`;
      throw new Error(`MCP ${method} failed${code}: ${payload.error.message ?? 'Unknown error'}`);
    }

    return payload.result;
  }

  /**
   * Poll a deferred 202+Location endpoint until the JSON-RPC result is ready.
   * Each hop may return either the finished body or another 202+Location to
   * keep polling. The session id is threaded through so the server associates
   * the poll with the original request.
   */
  async function followLocation(
    location: string,
    family: 4 | 6,
    signal: AbortSignal,
  ): Promise<PinnedResponse> {
    let target = new URL(location, validUrl);
    let pollSessionId = sessionId;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const resolved = await resolver(target.href);
      if (!resolved) {
        throw new Error('MCP endpoint resolved to a blocked or unavailable address.');
      }

      const response = await pinnedPost({
        address: resolved.address,
        body: '',
        family: resolved.family,
        headers: {
          accept: 'text/event-stream, application/json',
          ...(pollSessionId ? { 'mcp-session-id': pollSessionId } : {}),
        },
        method: 'GET',
        signal,
        url: resolved.url,
      });

      const pollSession = response.headers['mcp-session-id'];
      if (typeof pollSession === 'string' && pollSession.trim()) {
        pollSessionId = pollSession;
      }

      if (response.statusCode === 202 && typeof response.headers.location === 'string') {
        target = new URL(response.headers.location, target);
        continue;
      }

      return response;
    }

    throw new Error('MCP endpoint kept returning 202 Accepted with new polling URLs (dropped after 10 hops).');
  }

  async function initialize(signal: AbortSignal): Promise<void> {
    await rpc('initialize', {
      capabilities: {},
      clientInfo: { name: 'shadow-auditor', version: '1.0.0' },
      protocolVersion: MCP_PROTOCOL_VERSION,
    }, signal);
    await rpc('notifications/initialized', {}, signal, true);
  }

  return async (operation: string, input: Record<string, unknown>, signal?: AbortSignal) => {
      // Bail immediately when the caller is already aborting: addEventListener
      // does not re-fire for a pre-aborted signal, so without this a fresh request
      // would still be dispatched and held for the full timeout window.
      if (signal?.aborted) throw signal.reason ?? new Error('MCP request aborted.');

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(new Error('MCP request timed out.')), 30_000);
      const abortFromCaller = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abortFromCaller, { once: true });

      try {
      initializePromise ??= initialize(controller.signal).catch((error: unknown) => {
        initializePromise = undefined;
        sessionId = undefined;
        throw error;
      });
      await initializePromise;
      return await rpc('tools/call', { arguments: input, name: operation }, controller.signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw error;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  };
}

function parseMcpResponse(body: string, expectedId: number): JsonRpcResponse {
  // SSE events are separated by blank lines; a single event may carry several
  // `data:` lines that together form one payload (joined by `\n`). Parsing each
  // line individually would break multi-line JSON, so we first group contiguous
  // `data:` lines into whole events before attempting to parse.
  const lines = body.split(/\r?\n/);
  const grouped: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (grouped.length > 0 && grouped.at(-1) !== '') grouped.push('');
      continue;
    }

    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim();
      const last = grouped.at(-1);
      if (last === undefined || last === '') {
        grouped.push(payload);
      } else {
        grouped[grouped.length - 1] = `${last}\n${payload}`;
      }
    }
  }

  const events = grouped
    .map((event) => event.trim())
    .filter((event) => event && event !== '[DONE]');

  const sources = events.length > 0 ? events : [body];

  for (const source of sources) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      continue;
    }

    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
      (parsed as { id?: unknown }).id === expectedId
    ) {
      return parsed as JsonRpcResponse;
    }
  }

  throw new Error('MCP endpoint returned an invalid JSON-RPC response.');
}

async function pinnedPost(requestOptions: PinnedRequest): Promise<PinnedResponse> {
  const { address, body, family, headers, method, signal, url } = requestOptions;
  const transport = url.protocol === 'https:' ? https : http;
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (typeof options === 'object' && options.all) {
      callback(null, [{ address, family }]);
      return;
    }

    callback(null, address, family);
  };

  return new Promise<PinnedResponse>((resolve, reject) => {
    const request = transport.request(url, {
      headers: {
        ...headers,
        ...(body ? { 'content-length': Buffer.byteLength(body).toString() } : {}),
        'content-type': 'application/json',
      },
      lookup,
      method,
      signal,
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode >= 300) {
        response.resume();
        reject(new Error(`MCP endpoint error (${statusCode}): ${response.statusMessage ?? 'Unknown error'}`));
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy(new Error('MCP endpoint response exceeded the 10 MiB limit.'));
          return;
        }

        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        headers: response.headers,
        statusCode,
      }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}
