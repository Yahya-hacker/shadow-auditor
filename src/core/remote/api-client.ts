import type {
  CancelSessionRequest,
  CapabilityNegotiationRequest,
  CapabilityNegotiationResponse,
  ClientCapabilities,
  CreateSessionRequest,
  DeviceEnrollmentRequest,
  DeviceEnrollmentResponse,
  DeviceRefreshRequest,
  DeviceRefreshResponse,
  EventEnvelope,
  HealthResponse,
  JsonObject,
  JsonValue,
  PauseSessionRequest,
  Problem,
  ReadinessResponse,
  ResumeSessionRequest,
  SessionControlResponse,
  SessionSnapshot,
  SignedRequestMetadata,
  ToolDecision,
  ToolResult,
} from '../../protocol/generated.js';
import type { DeviceCredentials } from '../../utils/keychain.js';

import { sha256Digest } from '../../protocol/canonical-json.js';
import { type ProtocolSchemaName, validateProtocolDto } from '../../protocol/validate.js';
import { DeviceCredentialVault } from '../../utils/keychain.js';
import { createDeviceKeyPair, createSignedRequest, verifyCanonical } from './crypto.js';
import { problem, ProtocolError } from './protocol-error.js';
import { parseEventStream } from './sse.js';

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_OUTBOUND_BYTES = 512 * 1024;

export interface RemoteApiClientOptions {
  backendUrl: string;
  credentialAccount: string;
  fetchImplementation?: typeof fetch;
  vault?: DeviceCredentialVault;
}

function validateBackendUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Shadow Auditor backend URL must use HTTPS');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

async function readBoundedJson<T>(response: Response, limit = DEFAULT_MAX_RESPONSE_BYTES): Promise<T> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response body is unavailable');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > limit) {
        throw new ProtocolError(problem({
          code: 'RESPONSE_TOO_LARGE',
          detail: `Backend response exceeds ${limit} bytes`,
          status: 413,
          title: 'Backend response is too large',
        }));
      }

      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw new ProtocolError(
      problem({
        code: 'INVALID_JSON_RESPONSE',
        detail: 'Backend returned a non-JSON response',
        status: 502,
        title: 'Invalid backend response',
      }),
      { cause: error },
    );
  }
}

async function throwResponseProblem(response: Response): Promise<never> {
  try {
    const remoteProblem = validateProtocolDto<Problem>(
      'problem.schema.json',
      await readBoundedJson<unknown>(response),
    );
    if (typeof remoteProblem.code === 'string' && typeof remoteProblem.status === 'number') {
      throw new ProtocolError(remoteProblem);
    }
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
  }

  throw new ProtocolError(problem({
    code: 'HTTP_ERROR',
    detail: `Backend request failed with HTTP ${response.status}`,
    status: response.status,
    title: response.statusText || 'Backend request failed',
  }));
}

function signedHeaders(
  request: Record<string, unknown> & { signature: string },
  accessToken: string,
): Record<string, string> {
  return {
    accept: 'application/json',
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'x-shadow-device-id': String(request.deviceId),
    'x-shadow-key-id': String(request.keyId),
    'x-shadow-nonce': String(request.nonce),
    'x-shadow-request-id': String(request.requestId),
    'x-shadow-signature': request.signature,
    'x-shadow-timestamp': String(request.timestamp),
  };
}

export class RemoteApiClient {
  private readonly baseUrl: URL;
  private credentials: DeviceCredentials | null = null;
  private readonly fetchImplementation: typeof fetch;
  private maxOutboundPayloadBytes = DEFAULT_MAX_OUTBOUND_BYTES;
  private readonly vault: DeviceCredentialVault;

  constructor(private readonly options: RemoteApiClientOptions) {
    this.baseUrl = validateBackendUrl(options.backendUrl);
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.vault = options.vault ?? new DeviceCredentialVault();
  }

  static async enroll(options: {
    backendUrl: string;
    clientVersion: string;
    credentialAccount: string;
    deviceName: string;
    enrollmentCode: string;
    fetchImplementation?: typeof fetch;
    vault?: DeviceCredentialVault;
  }): Promise<DeviceEnrollmentResponse> {
    const baseUrl = validateBackendUrl(options.backendUrl);
    const keyPair = createDeviceKeyPair();
    const request = validateProtocolDto<DeviceEnrollmentRequest>('device-enrollment-request.schema.json', {
      clientVersion: options.clientVersion,
      deviceName: options.deviceName,
      devicePublicKey: {
        algorithm: 'ed25519',
        keyId: keyPair.keyId,
        publicKey: keyPair.publicKey,
      },
      enrollmentCode: options.enrollmentCode,
      platform: process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux',
      protocolVersion: '1.0',
    });
    const response = await (options.fetchImplementation ?? fetch)(new URL('/v1/auth/device/enroll', baseUrl), {
      body: JSON.stringify(request),
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      method: 'POST',
      redirect: 'error',
    });
    if (!response.ok) await throwResponseProblem(response);
    const enrollment = validateProtocolDto<DeviceEnrollmentResponse>(
      'device-enrollment-response.schema.json',
      await readBoundedJson<unknown>(response),
    );
    if (enrollment.serverSigningKeys.length === 0) {
      throw new ProtocolError(problem({
        code: 'INVALID_ENROLLMENT_RESPONSE',
        detail: 'Backend enrollment response is missing required protocol fields or signing keys',
        status: 502,
        title: 'Invalid enrollment response',
      }));
    }

    await (options.vault ?? new DeviceCredentialVault()).save(options.credentialAccount, {
      deviceId: enrollment.deviceId,
      keyId: keyPair.keyId,
      privateKeyPkcs8: keyPair.privateKeyPkcs8,
      publicKey: keyPair.publicKey,
      serverSigningKeys: [...enrollment.serverSigningKeys],
      tokens: enrollment.tokens,
    });
    return enrollment;
  }

  async cancel(sessionId: string, reason?: string): Promise<SessionControlResponse> {
    return this.post<CancelSessionRequest, SessionControlResponse>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/cancel`,
      { protocolVersion: '1.0', reason },
      'cancel-session-request.schema.json',
      'session-control-response.schema.json',
    );
  }

  async capabilities(client: ClientCapabilities): Promise<CapabilityNegotiationResponse> {
    return this.post<CapabilityNegotiationRequest, CapabilityNegotiationResponse>(
      '/v1/capabilities/negotiate',
      { client, protocolVersion: '1.0' },
      'capability-negotiation-request.schema.json',
      'capability-negotiation-response.schema.json',
    );
  }

  async createSession(payload: Omit<CreateSessionRequest, 'request'>): Promise<SessionSnapshot> {
    return this.post<CreateSessionRequest, SessionSnapshot>(
      '/v1/sessions',
      payload,
      'create-session-request.schema.json',
      'session-snapshot.schema.json',
    );
  }

  async getCredentials(): Promise<DeviceCredentials> {
    if (!this.credentials) this.credentials = await this.vault.load(this.options.credentialAccount);
    return this.credentials;
  }

  async getSession(sessionId: string): Promise<SessionSnapshot> {
    return this.get<SessionSnapshot>(
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
      'session-snapshot.schema.json',
    );
  }

  async health(): Promise<HealthResponse> {
    return this.unsignedGet<HealthResponse>('/v1/health', 'health-response.schema.json');
  }

  async measureSignedPayload<TRequest extends JsonObject>(
    payload: Omit<TRequest, 'request'>,
    requestSchema: ProtocolSchemaName,
    path: string,
  ): Promise<number> {
    const credentials = await this.getCredentials();
    const signed = createSignedRequest(payload as JsonObject, {
      deviceId: credentials.deviceId,
      keyId: credentials.keyId,
      method: 'POST',
      path,
      privateKeyPkcs8: credentials.privateKeyPkcs8,
    }) as unknown as TRequest;
    return Buffer.byteLength(
      JSON.stringify(validateProtocolDto<TRequest>(requestSchema, signed)),
    );
  }

  async pause(sessionId: string, reason?: string): Promise<SessionControlResponse> {
    return this.post<PauseSessionRequest, SessionControlResponse>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/pause`,
      { protocolVersion: '1.0', reason },
      'pause-session-request.schema.json',
      'session-control-response.schema.json',
    );
  }

  async prepareDecision(sessionId: string, decision: Omit<ToolDecision, 'request'>): Promise<ToolDecision> {
    const path = `/v1/sessions/${encodeURIComponent(sessionId)}/tool-decisions`;
    return this.prepareSigned<ToolDecision>(
      path,
      decision,
      'tool-decision.schema.json',
    );
  }

  async prepareResult(sessionId: string, result: Omit<ToolResult, 'request'>): Promise<ToolResult> {
    const path = `/v1/sessions/${encodeURIComponent(sessionId)}/tool-results`;
    return this.prepareSigned<ToolResult>(
      path,
      result,
      'tool-result.schema.json',
    );
  }

  async readiness(): Promise<ReadinessResponse> {
    return this.unsignedGet<ReadinessResponse>('/v1/readiness', 'readiness-response.schema.json');
  }

  async resume(sessionId: string, cursor: number, lastEventHash: null | string): Promise<SessionControlResponse> {
    return this.post<ResumeSessionRequest, SessionControlResponse>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/resume`,
      { cursor, lastEventHash, protocolVersion: '1.0' },
      'resume-session-request.schema.json',
      'session-control-response.schema.json',
    );
  }

  async sendDecision(sessionId: string, decision: Omit<ToolDecision, 'request'>): Promise<ToolDecision> {
    const signed = await this.prepareDecision(sessionId, decision);
    await this.submitDecision(sessionId, signed);
    return signed;
  }

  async sendResult(sessionId: string, result: Omit<ToolResult, 'request'>): Promise<ToolResult> {
    const signed = await this.prepareResult(sessionId, result);
    await this.submitResult(sessionId, signed);
    return signed;
  }

  setMaxOutboundPayloadBytes(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > DEFAULT_MAX_OUTBOUND_BYTES) {
      throw new ProtocolError(problem({
        code: 'INVALID_PAYLOAD_LIMIT',
        detail: `Backend negotiated an invalid outbound payload limit: ${limit}`,
        status: 412,
        title: 'Invalid negotiated capabilities',
      }));
    }

    this.maxOutboundPayloadBytes = limit;
  }

  async streamEvents(
    sessionId: string,
    cursor: number,
    maxEventBytes: number,
    signal?: AbortSignal,
    allowRefresh = true,
  ): Promise<AsyncGenerator<EventEnvelope>> {
    const path = `/v1/sessions/${encodeURIComponent(sessionId)}/events?cursor=${cursor}`;
    const credentials = await this.getCredentials();
    const signed = createSignedRequest({}, {
      deviceId: credentials.deviceId,
      keyId: credentials.keyId,
      method: 'GET',
      path,
      privateKeyPkcs8: credentials.privateKeyPkcs8,
    });
    const response = await this.fetchImplementation(new URL(path, this.baseUrl), {
      headers: {
        ...signedHeaders(signed.request, credentials.tokens.accessToken),
        accept: 'text/event-stream',
        'last-event-id': String(cursor),
      },
      method: 'GET',
      redirect: 'error',
      signal,
    });
    if (response.status === 401 && allowRefresh) {
      await this.refresh();
      return this.streamEvents(sessionId, cursor, maxEventBytes, signal, false);
    }

    if (!response.ok) await throwResponseProblem(response);
    if (!response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      throw new ProtocolError(problem({
        code: 'INVALID_EVENT_STREAM',
        detail: 'Backend event endpoint did not return text/event-stream',
        status: 502,
        title: 'Invalid event stream response',
      }));
    }

    return parseEventStream(response.body, maxEventBytes);
  }

  async submitDecision(sessionId: string, decision: ToolDecision): Promise<void> {
    const path = `/v1/sessions/${encodeURIComponent(sessionId)}/tool-decisions`;
    await this.postPrepared(path, decision, 'tool-decision.schema.json');
  }

  async submitResult(sessionId: string, result: ToolResult): Promise<void> {
    const path = `/v1/sessions/${encodeURIComponent(sessionId)}/tool-results`;
    await this.postPrepared(path, result, 'tool-result.schema.json');
  }

  private assertOutboundPayloadSize(path: string, body: string): void {
    const byteLength = Buffer.byteLength(body);
    if (byteLength > this.maxOutboundPayloadBytes) {
      throw new ProtocolError(problem({
        code: 'OUTBOUND_PAYLOAD_TOO_LARGE',
        detail: `${path} payload is ${byteLength} bytes; negotiated limit is ${this.maxOutboundPayloadBytes}`,
        status: 413,
        title: 'Outbound protocol payload exceeds negotiated limit',
      }));
    }
  }

  private async get<TResponse>(
    path: string,
    responseSchema: ProtocolSchemaName,
    allowRefresh = true,
  ): Promise<TResponse> {
    const credentials = await this.getCredentials();
    const signed = createSignedRequest({}, {
      deviceId: credentials.deviceId,
      keyId: credentials.keyId,
      method: 'GET',
      path,
      privateKeyPkcs8: credentials.privateKeyPkcs8,
    });
    const response = await this.fetchImplementation(new URL(path, this.baseUrl), {
      headers: signedHeaders(signed.request, credentials.tokens.accessToken),
      method: 'GET',
      redirect: 'error',
    });
    if (response.status === 401 && allowRefresh) {
      await this.refresh();
      return this.get(path, responseSchema, false);
    }

    if (!response.ok) await throwResponseProblem(response);
    return validateProtocolDto<TResponse>(responseSchema, await readBoundedJson<unknown>(response));
  }

  private async post<TRequest extends JsonObject, TResponse>(
    path: string,
    payload: Omit<TRequest, 'request'>,
    requestSchema: ProtocolSchemaName,
    responseSchema: ProtocolSchemaName,
    allowRefresh = true,
  ): Promise<TResponse> {
    const credentials = await this.getCredentials();
    const signed = createSignedRequest(payload as JsonObject, {
      deviceId: credentials.deviceId,
      keyId: credentials.keyId,
      method: 'POST',
      path,
      privateKeyPkcs8: credentials.privateKeyPkcs8,
    }) as unknown as TRequest;
    const validated = validateProtocolDto<TRequest>(requestSchema, signed);
    const body = JSON.stringify(validated);
    this.assertOutboundPayloadSize(path, body);
    const response = await this.fetchImplementation(new URL(path, this.baseUrl), {
      body,
      headers: signedHeaders((signed as unknown as { request: Record<string, unknown> & { signature: string } }).request, credentials.tokens.accessToken),
      method: 'POST',
      redirect: 'error',
    });
    if (response.status === 401 && allowRefresh && path !== '/v1/auth/device/refresh') {
      await this.refresh();
      return this.post<TRequest, TResponse>(path, payload, requestSchema, responseSchema, false);
    }

    if (!response.ok) await throwResponseProblem(response);
    if (response.status === 204) {
      throw new ProtocolError(problem({
        code: 'MISSING_RESPONSE_BODY',
        detail: `${path} returned no protocol response`,
        status: 502,
        title: 'Backend response is incomplete',
      }));
    }

    return validateProtocolDto<TResponse>(responseSchema, await readBoundedJson<unknown>(response));
  }

  private async postPrepared<TRequest extends JsonObject>(
    path: string,
    signed: TRequest,
    requestSchema: ProtocolSchemaName,
    allowRefresh = true,
  ): Promise<void> {
    const credentials = await this.getCredentials();
    const validated = validateProtocolDto<TRequest>(requestSchema, signed);
    const request = (validated as unknown as { request: SignedRequestMetadata }).request;
    const { request: _request, ...payload } = validated as TRequest & { request: SignedRequestMetadata };
    const { signature, ...unsignedRequest } = request;
    if (
      request.deviceId !== credentials.deviceId ||
      request.keyId !== credentials.keyId ||
      request.method !== 'POST' ||
      request.path !== path ||
      request.bodyDigest !== sha256Digest(payload as unknown as JsonValue) ||
      !verifyCanonical(unsignedRequest as unknown as JsonValue, signature, credentials.publicKey)
    ) {
      throw new ProtocolError(problem({
        code: 'INVALID_PREPARED_REQUEST',
        detail: `Prepared request for ${path} failed local signature or binding validation`,
        status: 409,
        title: 'Prepared protocol request is invalid',
      }));
    }

    const body = JSON.stringify(validated);
    this.assertOutboundPayloadSize(path, body);
    const response = await this.fetchImplementation(new URL(path, this.baseUrl), {
      body,
      headers: signedHeaders(request, credentials.tokens.accessToken),
      method: 'POST',
      redirect: 'error',
    });
    if (response.status === 401 && allowRefresh) {
      await this.refresh();
      return this.postPrepared(path, signed, requestSchema, false);
    }

    if (!response.ok) await throwResponseProblem(response);
    if (response.body) await response.body.cancel();
  }

  private async prepareSigned<TRequest extends JsonObject>(
    path: string,
    payload: Omit<TRequest, 'request'>,
    requestSchema: ProtocolSchemaName,
  ): Promise<TRequest> {
    const credentials = await this.getCredentials();
    const signed = createSignedRequest(payload as JsonObject, {
      deviceId: credentials.deviceId,
      keyId: credentials.keyId,
      method: 'POST',
      path,
      privateKeyPkcs8: credentials.privateKeyPkcs8,
    }) as unknown as TRequest;
    const validated = validateProtocolDto<TRequest>(requestSchema, signed);
    const body = JSON.stringify(validated);
    this.assertOutboundPayloadSize(path, body);
    return validated;
  }

  private async refresh(): Promise<void> {
    const credentials = await this.getCredentials();
    const response = await this.post<DeviceRefreshRequest, DeviceRefreshResponse>(
      '/v1/auth/device/refresh',
      {
        deviceId: credentials.deviceId,
        protocolVersion: '1.0',
        refreshToken: credentials.tokens.refreshToken,
      },
      'device-refresh-request.schema.json',
      'device-refresh-response.schema.json',
      false,
    );
    if (response.protocolVersion !== '1.0' || response.deviceId !== credentials.deviceId) {
      throw new ProtocolError(problem({
        code: 'INVALID_REFRESH_RESPONSE',
        detail: 'Backend returned a token set for an unexpected protocol or device',
        status: 502,
        title: 'Invalid token refresh response',
      }));
    }

    this.credentials = { ...credentials, tokens: response.tokens };
    await this.vault.save(this.options.credentialAccount, this.credentials);
  }

  private async unsignedGet<TResponse>(
    path: string,
    responseSchema: ProtocolSchemaName,
  ): Promise<TResponse> {
    const response = await this.fetchImplementation(new URL(path, this.baseUrl), {
      headers: { accept: 'application/json' },
      method: 'GET',
      redirect: 'error',
    });
    if (!response.ok) await throwResponseProblem(response);
    return validateProtocolDto<TResponse>(responseSchema, await readBoundedJson<unknown>(response));
  }
}
