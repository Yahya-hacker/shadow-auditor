import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { promisify } from 'node:util';

import type {
  AgentAction,
  ClientCapabilities,
  EventEnvelope,
  ExecutionGrant,
  JsonObject,
  JsonValue,
  NegotiatedCapabilities,
  Problem,
  RepositoryDescriptor,
  SessionSnapshot,
  ToolDecision,
  ToolDescriptor,
  ToolProposal,
  ToolResult,
  UsageRecord,
  UsageTotals,
} from '../../protocol/generated.js';
import type { ShadowConfig } from '../../utils/config.js';

import { sha256Digest } from '../../protocol/canonical-json.js';
import { validateProtocolDto } from '../../protocol/validate.js';
import { HybridRetriever } from '../memory/hybrid-retriever.js';
import { KnowledgeGraph } from '../memory/knowledge-graph.js';
import { Retrieval } from '../memory/retrieval.js';
import {
  NullEmbeddingProvider,
  OllamaEmbeddingProvider,
  SemanticIndex,
} from '../memory/semantic-index.js';
import { deduplicateFindings } from '../output/dedup.js';
import { validateLocalReport } from '../output/report-safety.js';
import { type SecurityReport, securityReportSchema } from '../output/report-schema.js';
import { generateSarifReport } from '../output/sarif.js';
import { RunArtifacts } from '../run-artifacts.js';
import { getChangedFiles } from '../tools/git-diff.js';
import { createLocalToolRegistry, type LocalToolRegistry } from '../tools/registry.js';
import { RemoteApiClient } from './api-client.js';
import { validateEventEnvelope, verifyCanonical } from './crypto.js';
import { ActiveSessionStore, CursorStore, ExecutionLedger } from './durable-state.js';
import { problem, ProtocolError } from './protocol-error.js';

const execFileAsync = promisify(execFile);
const REQUIRED_FEATURES = [
  'digest-bound-approvals',
  'durable-events',
  'event-hash-chain',
  'local-tool-execution',
  'resumable-sessions',
  'sse',
] as const;

export interface StreamActivity {
  content: string;
  detail?: string;
  toolName?: string;
  type: 'error' | 'status' | 'text' | 'tool-call' | 'tool-result' | 'usage';
}

export interface AgentRuntime {
  cancel(reason?: string): Promise<void>;
  getActiveSessionId(): null | string;
  getRunDirectory(): string;
  getToolDescriptors(): ToolDescriptor[];
  getUsage(): UsageTotals;
  pause(reason?: string): Promise<void>;
  resume(): AsyncGenerator<StreamActivity>;
  sendMessage(message: string): AsyncGenerator<StreamActivity>;
  shutdown(): Promise<void>;
}

export interface RemoteAgentSessionOptions {
  apiClient?: RemoteApiClient;
  ciEnabled?: boolean;
  config: ShadowConfig;
  confirmToolExecution?: (request: ToolApprovalRequest) => Promise<boolean>;
  repositoryMap: string;
  targetPath: string;
}

export interface ToolApprovalRequest {
  arguments: JsonObject;
  reason: string;
  risk: ToolProposal['risk'];
  toolName: string;
}

function asJsonObject(value: object): JsonObject {
  return value as unknown as JsonObject;
}

function isTerminal(status: SessionSnapshot['status']): boolean {
  return status === 'cancelled' || status === 'completed' || status === 'failed';
}

function toErrorProblem(error: Error): Problem {
  if (error instanceof ProtocolError) return error.problem;
  return problem({
    code: 'LOCAL_TOOL_FAILURE',
    detail: error.message,
    status: 500,
    title: 'Local tool execution failed',
  });
}

async function repositoryState(targetPath: string, repositoryMap: string, semanticDigest: string): Promise<RepositoryDescriptor> {
  let revision = 'unversioned';
  let dirty = false;
  try {
    const [revisionResult, statusResult] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: targetPath }),
      execFileAsync('git', ['status', '--porcelain'], { cwd: targetPath }),
    ]);
    revision = revisionResult.stdout.trim();
    dirty = statusResult.stdout.trim().length > 0;
  } catch {
    // Non-git targets retain a deterministic, explicit unversioned descriptor.
  }

  return {
    dirty,
    displayName: path.basename(targetPath),
    repositoryId: sha256Digest(path.resolve(targetPath)),
    repositoryMapDigest: sha256Digest(repositoryMap),
    revision,
    semanticIndexDigest: semanticDigest,
    sourceMode: 'tool-mediated',
  };
}

async function createRetriever(config: ShadowConfig, targetPath: string): Promise<{
  digest: string;
  retriever: HybridRetriever;
}> {
  const storagePath = path.join(targetPath, '.shadow-auditor', 'semantic-index');
  const provider = config.indexing?.embeddingProvider === 'ollama'
    ? new OllamaEmbeddingProvider({
        baseUrl: config.indexing.ollamaBaseUrl,
        model: config.indexing.ollamaModel,
      })
    : new NullEmbeddingProvider();
  const semanticIndex = new SemanticIndex({ provider, rootPath: targetPath, storagePath });
  await semanticIndex.initialize();
  await semanticIndex.indexRepository();
  const graph = await KnowledgeGraph.create({
    runId: sha256Digest(path.resolve(targetPath)).slice('sha256:'.length, 'sha256:'.length + 24),
    storagePath: path.join(targetPath, '.shadow-auditor', 'knowledge'),
  });
  const retrieval = new Retrieval(graph);
  const retriever = new HybridRetriever(graph, retrieval, semanticIndex, { rootPath: targetPath });
  retrieval.setHybridRetriever(retriever);
  const digest = sha256Digest(
    semanticIndex.getAllChunks().map((chunk) => ({
      contentDigest: sha256Digest(chunk.rawContent),
      id: chunk.id,
    })),
  );
  return { digest, retriever };
}

export class RemoteAgentSession implements AgentRuntime {
  private abortController: AbortController | null = null;
  private readonly activeSessionStore: ActiveSessionStore;
  private activeSnapshot: null | SessionSnapshot = null;
  private readonly api: RemoteApiClient;
  private readonly artifacts: RunArtifacts;
  private readonly cursorStore: CursorStore;
  private readonly decisions = new Map<string, ToolDecision>();
  private readonly grants = new Map<string, ExecutionGrant>();
  private readonly negotiated: NegotiatedCapabilities;
  private readonly repository: RepositoryDescriptor;
  private readonly scanScope: { baselineRevision?: string; files: string[] };
  private readonly toolRegistry: LocalToolRegistry;
  private usage: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    storageBytes: 0,
    toolExecutionMilliseconds: 0,
  };

  private constructor(
    private readonly options: RemoteAgentSessionOptions,
    initialized: {
      api: RemoteApiClient;
      artifacts: RunArtifacts;
      negotiated: NegotiatedCapabilities;
      repository: RepositoryDescriptor;
      scanScope: {
        baselineRevision?: string;
        files: string[];
      };
      toolRegistry: LocalToolRegistry;
    },
  ) {
    this.api = initialized.api;
    this.artifacts = initialized.artifacts;
    this.activeSessionStore = new ActiveSessionStore(options.targetPath, options.config.backendUrl);
    this.cursorStore = new CursorStore(options.targetPath);
    this.negotiated = initialized.negotiated;
    this.repository = initialized.repository;
    this.scanScope = initialized.scanScope;
    this.toolRegistry = initialized.toolRegistry;
  }

  static async create(options: RemoteAgentSessionOptions): Promise<RemoteAgentSession> {
    const semantic = await createRetriever(options.config, options.targetPath);
    const retriever = semantic.retriever;
    const semanticDigest = semantic.digest;
    const toolRegistry = await createLocalToolRegistry({
      config: options.config,
      retriever,
      targetPath: options.targetPath,
    });
    const api = options.apiClient ?? new RemoteApiClient({
      backendUrl: options.config.backendUrl,
      credentialAccount: options.config.credentialAccount,
    });
    const client: ClientCapabilities = {
      features: [...REQUIRED_FEATURES],
      maxInboundEventBytes: 1024 * 1024,
      maxOutboundPayloadBytes: 512 * 1024,
      protocolVersions: ['1.0'],
      tools: [...toolRegistry.tools.values()].map((tool) => tool.descriptor),
    };
    const capabilities = await api.capabilities(client);
    api.setMaxOutboundPayloadBytes(capabilities.negotiated.maxClientPayloadBytes);
    const credentials = await api.getCredentials();
    const trustedKeys = new Map(credentials.serverSigningKeys.map((key) => [key.keyId, key]));
    if (
      capabilities.protocolVersion !== '1.0' ||
      !REQUIRED_FEATURES.every((feature) => capabilities.negotiated.features.includes(feature)) ||
      capabilities.negotiated.maxClientPayloadBytes > client.maxOutboundPayloadBytes ||
      capabilities.negotiated.maxServerEventBytes > client.maxInboundEventBytes ||
      capabilities.server.signingKeys.length === 0 ||
      !capabilities.server.signingKeys.every((key) => {
        const trusted = trustedKeys.get(key.keyId);
        return trusted?.algorithm === key.algorithm && trusted.publicKey === key.publicKey;
      })
    ) {
      await toolRegistry.close();
      throw new ProtocolError(problem({
        code: 'CAPABILITY_NEGOTIATION_FAILED',
        detail: 'Backend did not negotiate all required protocol 1.0 security capabilities',
        status: 412,
        title: 'Incompatible backend capabilities',
      }));
    }

    const repository = await repositoryState(options.targetPath, options.repositoryMap, semanticDigest);
    let scanScope: { baselineRevision?: string; files: string[] } = { files: ['.'] };
    if (options.config.diff?.enabled) {
      const changed = await getChangedFiles({
        baseRef: options.config.diff.baseRef,
        cwd: options.targetPath,
        extensions: [],
      });
      if (changed.usedFallback) {
        await toolRegistry.close();
        throw new ProtocolError(problem({
          code: 'DIFF_SCOPE_UNAVAILABLE',
          detail: `Unable to resolve incremental scan baseline ${options.config.diff.baseRef}`,
          status: 422,
          title: 'Incremental scan scope could not be established',
        }));
      }

      if (changed.files.length > 1024) {
        await toolRegistry.close();
        throw new ProtocolError(problem({
          code: 'DIFF_SCOPE_TOO_LARGE',
          detail: `Incremental scan contains ${changed.files.length} files; protocol limit is 1024`,
          status: 413,
          title: 'Incremental scan scope is too large',
        }));
      }

      scanScope = { baselineRevision: changed.resolvedRef, files: changed.files };
    }

    const artifacts = await RunArtifacts.create(options.targetPath, {
      backendUrl: options.config.backendUrl,
      cursor: 0,
      lastEventHash: null,
      protocolVersion: '1.0',
      repositoryPath: path.resolve(options.targetPath),
      sessionIds: [],
      status: 'running',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        storageBytes: 0,
        toolExecutionMilliseconds: 0,
      },
    });
    const runtime = new RemoteAgentSession(options, {
      api,
      artifacts,
      negotiated: capabilities.negotiated,
      repository,
      scanScope,
      toolRegistry,
    });
    const restored = await runtime.activeSessionStore.load();
    if (restored) {
      if (
        isTerminal(restored.status) ||
        sha256Digest(restored.negotiatedCapabilities) !== sha256Digest(capabilities.negotiated)
      ) {
        await toolRegistry.close();
        throw new ProtocolError(problem({
          code: 'ACTIVE_SESSION_CAPABILITY_MISMATCH',
          detail: `Durable session ${restored.sessionId} cannot be resumed with the negotiated capabilities`,
          status: 409,
          title: 'Cannot safely restore remote session',
        }));
      }

      const cursor = await runtime.cursorStore.load(restored.sessionId);
      runtime.activeSnapshot = restored;
      runtime.usage = { ...restored.usage };
      await artifacts.updateMeta({
        cursor: cursor.sequence,
        lastEventHash: cursor.eventHash,
        sessionIds: [restored.sessionId],
        usage: runtime.usage,
      });
    }

    return runtime;
  }

  async cancel(reason = 'Cancelled by local user'): Promise<void> {
    if (!this.activeSnapshot || isTerminal(this.activeSnapshot.status)) return;
    const response = await this.api.cancel(this.activeSnapshot.sessionId, reason);
    this.activeSnapshot = { ...this.activeSnapshot, status: response.status };
    if (isTerminal(this.activeSnapshot.status)) {
      await this.activeSessionStore.clear(this.activeSnapshot.sessionId);
    } else {
      await this.activeSessionStore.persist(this.activeSnapshot);
    }

    this.abortController?.abort(reason);
  }

  getActiveSessionId(): null | string {
    return this.activeSnapshot?.sessionId ?? null;
  }

  getRunDirectory(): string {
    return this.artifacts.getRunDirectory();
  }

  getToolDescriptors(): ToolDescriptor[] {
    return [...this.toolRegistry.tools.values()].map((tool) => tool.descriptor);
  }

  getUsage(): UsageTotals {
    return { ...this.usage };
  }

  async pause(reason = 'Paused by local user'): Promise<void> {
    if (!this.activeSnapshot || isTerminal(this.activeSnapshot.status)) return;
    const state = await this.cursorStore.load(this.activeSnapshot.sessionId);
    const response = await this.api.pause(this.activeSnapshot.sessionId, reason);
    this.activeSnapshot = { ...this.activeSnapshot, status: response.status };
    if (isTerminal(this.activeSnapshot.status)) {
      await this.activeSessionStore.clear(this.activeSnapshot.sessionId);
    } else {
      await this.activeSessionStore.persist(this.activeSnapshot);
    }

    await this.artifacts.updateMeta({
      cursor: state.sequence,
      lastEventHash: state.eventHash,
    });
    this.abortController?.abort(reason);
  }

  async *resume(): AsyncGenerator<StreamActivity> {
    if (!this.activeSnapshot) {
      throw new ProtocolError(problem({
        code: 'NO_ACTIVE_SESSION',
        detail: 'There is no active remote session to resume',
        status: 409,
        title: 'No resumable session',
      }));
    }

    const cursor = await this.cursorStore.load(this.activeSnapshot.sessionId);
    const response = await this.api.resume(
      this.activeSnapshot.sessionId,
      cursor.sequence,
      cursor.eventHash,
    );
    this.activeSnapshot = { ...this.activeSnapshot, status: response.status };
    if (isTerminal(this.activeSnapshot.status)) {
      await this.activeSessionStore.clear(this.activeSnapshot.sessionId);
    } else {
      await this.activeSessionStore.persist(this.activeSnapshot);
    }

    yield* this.streamActiveSession();
  }

  async *sendMessage(message: string): AsyncGenerator<StreamActivity> {
    if (this.activeSnapshot && !isTerminal(this.activeSnapshot.status)) {
      throw new ProtocolError(problem({
        code: 'SESSION_ALREADY_ACTIVE',
        detail: `Session ${this.activeSnapshot.sessionId} must complete or be cancelled before starting another scan`,
        status: 409,
        title: 'A remote session is already active',
      }));
    }

    await this.artifacts.recordMessage({
      content: message,
      role: 'user',
      timestamp: new Date().toISOString(),
    });
    if (this.scanScope.files.length === 0) {
      await this.persistReport({ findings: [] });
      yield { content: 'No files changed since the configured baseline', type: 'status' };
      return;
    }

    const snapshot = await this.api.createSession({
      capabilities: this.negotiated,
      clientRequestId: randomUUID(),
      protocolVersion: '1.0',
      repository: this.repository,
      scan: {
        baselineRevision: this.scanScope.baselineRevision,
        exclusions: ['.git', '.shadow-auditor', 'node_modules'],
        mode: this.options.ciEnabled
          ? 'ci'
          : this.options.config.auditMode === 'ctf'
            ? 'audit'
            : this.options.config.auditMode,
        objective: message,
        scope: this.scanScope.files,
      },
    });
    if (
      snapshot.cursor !== 0 ||
      snapshot.lastEventHash !== null ||
      sha256Digest(snapshot.negotiatedCapabilities) !== sha256Digest(this.negotiated) ||
      snapshot.scan.objective !== message
    ) {
      throw new ProtocolError(problem({
        code: 'UNSAFE_INITIAL_CURSOR',
        detail: 'New session did not begin at the event-chain genesis',
        status: 409,
        title: 'Cannot establish event-chain trust',
      }));
    }

    this.activeSnapshot = snapshot;
    this.usage = { ...snapshot.usage };
    await this.activeSessionStore.persist(snapshot);
    await this.cursorStore.persist({
      eventHash: null,
      sequence: 0,
      sessionId: snapshot.sessionId,
      updatedAt: new Date().toISOString(),
    });
    await this.artifacts.updateMeta({
      sessionIds: [...new Set([snapshot.sessionId])],
      usage: this.usage,
    });
    yield {
      content: `Connected to remote session ${snapshot.sessionId}`,
      type: 'status',
    };
    yield* this.streamActiveSession();
  }

  async shutdown(): Promise<void> {
    this.abortController?.abort('Runtime shutdown');
    await this.toolRegistry.close();
  }

  private async executeGrant(grant: ExecutionGrant, ledger: ExecutionLedger): Promise<StreamActivity[]> {
    const credentials = await this.api.getCredentials();
    const proposalEntry = ledger.findLatest(grant.proposalId, 'decision');
    const durableDecision = proposalEntry?.data.signedDecision;
    const decision = this.decisions.get(grant.proposalId)
      ?? (
        durableDecision
          ? validateProtocolDto<ToolDecision>('tool-decision.schema.json', durableDecision)
          : undefined
      );
    if (!decision) throw new ProtocolError(problem({
      code: 'MISSING_TOOL_DECISION',
      detail: `Grant ${grant.grantId} has no durable local decision`,
      status: 409,
      title: 'Execution grant cannot be authorized',
    }));
    const trustedKey = credentials.serverSigningKeys.find(
      (key) => key.keyId === grant.signer.keyId && key.publicKey === grant.signer.publicKey,
    );
    const { signature, ...unsignedGrant } = grant;
    if (
      !trustedKey ||
      !verifyCanonical(unsignedGrant as unknown as JsonValue, signature, trustedKey.publicKey) ||
      grant.deviceId !== credentials.deviceId ||
      grant.decisionId !== decision.decisionId ||
      grant.argumentsDigest !== decision.argumentsDigest ||
      grant.decisionDigest !== sha256Digest(decision as unknown as JsonValue) ||
      grant.sessionId !== this.activeSnapshot?.sessionId ||
      Date.parse(grant.expiresAt) <= Date.now()
    ) {
      throw new ProtocolError(problem({
        code: 'INVALID_EXECUTION_GRANT',
        detail: `Grant ${grant.grantId} failed signature, binding, expiry, or device validation`,
        status: 401,
        title: 'Local execution denied',
      }));
    }

    const proposalData = proposalEntry?.data.proposal;
    const proposal = proposalData
      ? validateProtocolDto<ToolProposal>('tool-proposal.schema.json', proposalData)
      : undefined;
    if (!proposal || grant.toolName !== proposal.toolName) {
      throw new ProtocolError(problem({
        code: 'GRANT_TOOL_MISMATCH',
        detail: `Grant ${grant.grantId} does not match its approved tool proposal`,
        status: 409,
        title: 'Local execution denied',
      }));
    }

    const priorResult = ledger.findLatest(grant.proposalId, 'result');
    if (priorResult) {
      const durableResult = validateProtocolDto<ToolResult>(
        'tool-result.schema.json',
        priorResult.data.result,
      );
      await this.api.submitResult(grant.sessionId, durableResult);
      return [{ content: `${grant.toolName}: replayed durable result without re-execution`, toolName: grant.toolName, type: 'tool-result' }];
    }

    const recordedGrant = ledger.findLatest(grant.proposalId, 'grant');
    if (
      recordedGrant &&
      (
        recordedGrant.data.nonce !== grant.nonce ||
        sha256Digest(recordedGrant.data) !== sha256Digest(grant as unknown as JsonValue)
      )
    ) {
      throw new ProtocolError(problem({
        code: 'GRANT_REPLAY_MISMATCH',
        detail: `Proposal ${grant.proposalId} received a different grant after local authorization`,
        status: 409,
        title: 'Execution grant mismatch rejected',
      }));
    }

    if (!recordedGrant && ledger.hasGrantNonce(grant.nonce)) {
      throw new ProtocolError(problem({
        code: 'GRANT_REPLAY',
        detail: `Execution grant nonce ${grant.nonce} was already used for another proposal`,
        status: 409,
        title: 'Execution grant replay rejected',
      }));
    }

    const tool = this.toolRegistry.tools.get(grant.toolName);
    if (!tool || tool.descriptor.risk !== proposal.risk) {
      throw new ProtocolError(problem({
        code: 'LOCAL_TOOL_MISMATCH',
        detail: `Tool ${grant.toolName} is unavailable or its local risk classification differs`,
        status: 409,
        title: 'Local execution denied',
      }));
    }

    if (!recordedGrant) await ledger.append(grant.proposalId, 'grant', asJsonObject(grant));
    this.grants.set(grant.proposalId, grant);
    const uncertain = ledger.findLatest(grant.proposalId, 'execution_started');
    const durableStartedAt = uncertain?.data.startedAt;
    const startedAt = typeof durableStartedAt === 'string'
      ? durableStartedAt
      : new Date().toISOString();
    if (!uncertain) {
      await ledger.append(grant.proposalId, 'execution_started', {
        grantId: grant.grantId,
        nonce: grant.nonce,
        startedAt,
      });
    }

    let error: Problem | undefined;
    let output: JsonValue = null;
    let status: ToolResult['status'] = 'succeeded';
    const started = performance.now();
    if (uncertain) {
      status = 'failed';
      error = problem({
        code: 'EXECUTION_STATE_UNCERTAIN',
        detail: 'A previous client process began this operation without durably recording a result; it was not re-executed',
        status: 409,
        title: 'Tool execution outcome is uncertain',
      });
    } else {
      try {
        output = await tool.execute(tool.parse(proposal.arguments));
      } catch (error_) {
        status = 'failed';
        error = toErrorProblem(error_ instanceof Error ? error_ : new Error(String(error_)));
      }
    }

    const serialized = JSON.stringify(output);
    const originalByteLength = Buffer.byteLength(serialized);
    const resultLimit = tool.descriptor.maxResultBytes;
    const truncated = originalByteLength > resultLimit;
    if (truncated) output = this.truncateUtf8(serialized, resultLimit);
    let result: Omit<ToolResult, 'request'> = {
      argumentsDigest: grant.argumentsDigest,
      completedAt: new Date().toISOString(),
      error,
      grantDigest: sha256Digest(grant as unknown as JsonValue),
      grantId: grant.grantId,
      originalByteLength,
      output,
      outputDigest: sha256Digest(output),
      proposalId: grant.proposalId,
      protocolVersion: '1.0',
      resultId: randomUUID(),
      sessionId: grant.sessionId,
      startedAt,
      status,
      truncated,
    };
    result = await this.fitToolResultPayload(result, serialized);
    const signedResult = await this.api.prepareResult(grant.sessionId, result);
    await ledger.append(grant.proposalId, 'result', { result: asJsonObject(signedResult) });
    await this.api.submitResult(grant.sessionId, signedResult);
    this.usage = {
      ...this.usage,
      toolExecutionMilliseconds:
        this.usage.toolExecutionMilliseconds + Math.round(performance.now() - started),
    };
    return [{
      content: status === 'succeeded' ? `${grant.toolName} completed` : `${grant.toolName} failed`,
      detail: error?.detail,
      toolName: grant.toolName,
      type: 'tool-result',
    }];
  }

  private async fitToolResultPayload(
    result: Omit<ToolResult, 'request'>,
    serializedOriginal: string,
  ): Promise<Omit<ToolResult, 'request'>> {
    const schema = 'tool-result.schema.json';
    const requestPath = `/v1/sessions/${encodeURIComponent(result.sessionId)}/tool-results`;
    if (
      await this.api.measureSignedPayload<ToolResult>(result, schema, requestPath) <=
      this.negotiated.maxClientPayloadBytes
    ) {
      return result;
    }

    const suffix = '\n[truncated]';
    const characters = Array.from(serializedOriginal);
    let low = 0;
    let high = characters.length;
    let best: null | Omit<ToolResult, 'request'> = null;
    while (low <= high) {
      const midpoint = Math.floor((low + high) / 2);
      const output = `${characters.slice(0, midpoint).join('')}${suffix}`;
      const candidate: Omit<ToolResult, 'request'> = {
        ...result,
        output,
        outputDigest: sha256Digest(output),
        truncated: true,
      };
      if (
        await this.api.measureSignedPayload<ToolResult>(candidate, schema, requestPath) <=
        this.negotiated.maxClientPayloadBytes
      ) {
        best = candidate;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }

    if (best) return best;
    throw new ProtocolError(problem({
      code: 'TOOL_RESULT_ENVELOPE_TOO_LARGE',
      detail: 'Tool result metadata exceeds the negotiated outbound payload limit',
      status: 413,
      title: 'Tool result cannot be represented safely',
    }));
  }

  private async handleAction(action: AgentAction): Promise<StreamActivity[]> {
    if (action.sessionId !== this.activeSnapshot?.sessionId) {
      throw new ProtocolError(problem({
        code: 'ACTION_SESSION_MISMATCH',
        detail: `Action ${action.actionId} belongs to an unexpected session`,
        status: 409,
        title: 'Invalid agent action',
      }));
    }

    if (action.kind === 'report') {
      const candidate = 'report' in action.data ? action.data.report : action.data;
      const parsed = securityReportSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new ProtocolError(problem({
          code: 'INVALID_SECURITY_REPORT',
          detail: parsed.error.message,
          status: 422,
          title: 'Backend report failed local validation',
        }));
      }

      await this.persistReport(parsed.data);
    }

    return [{ content: action.summary, type: action.kind === 'failed' ? 'error' : 'text' }];
  }

  private async handleProposal(proposal: ToolProposal, ledger: ExecutionLedger): Promise<StreamActivity[]> {
    if (
      proposal.sessionId !== this.activeSnapshot?.sessionId ||
      sha256Digest(proposal.arguments) !== proposal.argumentsDigest ||
      (proposal.expiresAt && Date.parse(proposal.expiresAt) <= Date.now())
    ) {
      throw new ProtocolError(problem({
        code: 'INVALID_TOOL_PROPOSAL',
        detail: `Proposal ${proposal.proposalId} failed session, argument digest, or expiry validation`,
        status: 422,
        title: 'Invalid tool proposal',
      }));
    }

    const durableDecisionEntry = ledger.findLatest(proposal.proposalId, 'decision');
    if (durableDecisionEntry) {
      const durableProposal = validateProtocolDto<ToolProposal>(
        'tool-proposal.schema.json',
        durableDecisionEntry.data.proposal,
      );
      const durableDecision = validateProtocolDto<ToolDecision>(
        'tool-decision.schema.json',
        durableDecisionEntry.data.signedDecision,
      );
      if (
        sha256Digest(durableProposal as unknown as JsonValue) !==
          sha256Digest(proposal as unknown as JsonValue) ||
        durableDecision.proposalId !== proposal.proposalId ||
        durableDecision.sessionId !== proposal.sessionId ||
        durableDecision.argumentsDigest !== proposal.argumentsDigest
      ) {
        throw new ProtocolError(problem({
          code: 'DURABLE_DECISION_MISMATCH',
          detail: `Durable decision for proposal ${proposal.proposalId} does not match the replayed proposal`,
          status: 409,
          title: 'Tool proposal replay rejected',
        }));
      }

      await this.api.submitDecision(proposal.sessionId, durableDecision);
      this.decisions.set(proposal.proposalId, durableDecision);
      return [{
        content: `Replayed durable ${durableDecision.decision} decision for ${proposal.toolName}`,
        toolName: proposal.toolName,
        type: 'tool-call',
      }];
    }

    const tool = this.toolRegistry.tools.get(proposal.toolName);
    const negotiatedTool = this.negotiated.tools.find((descriptor) => descriptor.name === proposal.toolName);
    const riskMatches =
      tool?.descriptor.risk === proposal.risk &&
      negotiatedTool?.risk === proposal.risk &&
      negotiatedTool.inputSchemaDigest === tool.descriptor.inputSchemaDigest;
    let approved = false;
    let actor: ToolDecision['actor'] = 'policy';
    let reason = tool ? undefined : 'Tool is not available locally';
    if (tool && riskMatches && proposal.risk === 'read') {
      approved = true;
      reason = 'Approved by local read-only tool policy';
    } else if (tool && riskMatches && this.options.ciEnabled) {
      reason = 'Denied by non-interactive CI policy';
    } else if (tool && riskMatches) {
      if (this.options.confirmToolExecution) {
        actor = 'human';
        approved = await this.options.confirmToolExecution({
          arguments: proposal.arguments,
          reason: proposal.reason,
          risk: proposal.risk,
          toolName: proposal.toolName,
        });
        reason = approved ? 'Approved by local user' : 'Denied by local user';
      } else {
        reason = 'Denied because no interactive approval handler is available';
      }
    } else if (tool && !riskMatches) {
      reason = 'Backend and local tool risk classifications differ';
    }

    const unsignedDecision: Omit<ToolDecision, 'request'> = {
      actor,
      argumentsDigest: proposal.argumentsDigest,
      decidedAt: new Date().toISOString(),
      decision: approved ? 'approve' : 'deny',
      decisionId: randomUUID(),
      proposalId: proposal.proposalId,
      protocolVersion: '1.0',
      reason,
      sessionId: proposal.sessionId,
    };
    const decision = await this.api.prepareDecision(proposal.sessionId, unsignedDecision);
    this.decisions.set(proposal.proposalId, decision);
    await ledger.append(proposal.proposalId, 'decision', {
      proposal: asJsonObject(proposal),
      signedDecision: asJsonObject(decision),
      ...asJsonObject(decision),
    });
    await this.api.submitDecision(proposal.sessionId, decision);
    return [{
      content: `${approved ? 'Approved' : 'Denied'} ${proposal.toolName}: ${reason}`,
      toolName: proposal.toolName,
      type: 'tool-call',
    }];
  }

  private handleUsage(record: UsageRecord): StreamActivity {
    switch (record.meter) {
      case 'input_tokens': {
        this.usage = { ...this.usage, inputTokens: this.usage.inputTokens + record.quantity };
        break;
      }

      case 'output_tokens': {
        this.usage = { ...this.usage, outputTokens: this.usage.outputTokens + record.quantity };
        break;
      }

      case 'storage_bytes': {
        this.usage = { ...this.usage, storageBytes: this.usage.storageBytes + record.quantity };
        break;
      }

      case 'tool_execution_ms': {
        this.usage = {
          ...this.usage,
          toolExecutionMilliseconds: this.usage.toolExecutionMilliseconds + record.quantity,
        };
        break;
      }
    }

    return { content: `${record.meter}: +${record.quantity} ${record.unit}`, type: 'usage' };
  }

  private async persistReport(report: SecurityReport): Promise<void> {
    const deduped: SecurityReport = { findings: deduplicateFindings(report.findings) };
    let validated: Awaited<ReturnType<typeof validateLocalReport>>;
    try {
      validated = await validateLocalReport(deduped, this.options.targetPath);
    } catch (error) {
      throw new ProtocolError(
        problem({
          code: 'LOCAL_REPORT_SAFETY_FAILURE',
          detail: error instanceof Error ? error.message : String(error),
          status: 422,
          title: 'Backend report failed local safety validation',
        }),
        { cause: error },
      );
    }

    await this.artifacts.writeReportJson(asJsonObject(validated.report));
    await this.artifacts.writeReportMarkdown(validated.markdown);
    await this.artifacts.writeReportSarif(
      generateSarifReport(validated.report) as unknown as JsonObject,
    );
  }

  private async processEvent(envelope: EventEnvelope, ledger: ExecutionLedger): Promise<StreamActivity[]> {
    if (envelope.sessionId !== this.activeSnapshot?.sessionId || envelope.protocolVersion !== '1.0') {
      throw new ProtocolError(problem({
        code: 'EVENT_SESSION_MISMATCH',
        detail: `Event ${envelope.eventId} targets an unexpected session or protocol`,
        status: 409,
        title: 'Invalid event envelope',
      }));
    }

    switch (envelope.eventType) {
      case 'agent.action': {
        return this.handleAction(
          validateProtocolDto<AgentAction>('agent-action.schema.json', envelope.payload),
        );
      }

      case 'execution.grant': {
        return this.executeGrant(
          validateProtocolDto<ExecutionGrant>('execution-grant.schema.json', envelope.payload),
          ledger,
        );
      }

      case 'heartbeat': {
        return [];
      }

      case 'session.cancelled': {
        if (this.activeSnapshot) this.activeSnapshot = { ...this.activeSnapshot, status: 'cancelled' };
        return [{ content: 'Remote session cancelled', type: 'status' }];
      }

      case 'session.completed': {
        if (this.activeSnapshot) this.activeSnapshot = { ...this.activeSnapshot, status: 'completed' };
        return [{ content: 'Remote session completed', type: 'status' }];
      }

      case 'session.failed': {
        if (this.activeSnapshot) this.activeSnapshot = { ...this.activeSnapshot, status: 'failed' };
        return [{ content: 'Remote session failed', type: 'error' }];
      }

      case 'session.paused': {
        return [{ content: 'Remote session paused', type: 'status' }];
      }

      case 'session.resumed': {
        return [{ content: 'Remote session resumed', type: 'status' }];
      }

      case 'session.snapshot': {
        const snapshot = validateProtocolDto<SessionSnapshot>(
          'session-snapshot.schema.json',
          envelope.payload,
        );
        if (snapshot.sessionId !== envelope.sessionId) {
          throw new ProtocolError(problem({
            code: 'SNAPSHOT_SESSION_MISMATCH',
            detail: `Snapshot event ${envelope.eventId} contains a different session identifier`,
            status: 409,
            title: 'Invalid session snapshot',
          }));
        }

        this.activeSnapshot = snapshot;
        this.usage = { ...this.activeSnapshot.usage };
        return [{ content: `Session status: ${this.activeSnapshot.status}`, type: 'status' }];
      }

      case 'tool.proposal': {
        return this.handleProposal(
          validateProtocolDto<ToolProposal>('tool-proposal.schema.json', envelope.payload),
          ledger,
        );
      }

      case 'usage.record': {
        return [this.handleUsage(
          validateProtocolDto<UsageRecord>('usage-record.schema.json', envelope.payload),
        )];
      }
    }
  }

  private async *streamActiveSession(): AsyncGenerator<StreamActivity> {
    if (!this.activeSnapshot) return;
    const sessionId = this.activeSnapshot.sessionId;
    const credentials = await this.api.getCredentials();
    const ledger = await ExecutionLedger.open(this.options.targetPath, sessionId);
    let reconnectAttempts = 0;
    this.abortController = new AbortController();
    while (!isTerminal(this.activeSnapshot.status)) {
      const cursor = await this.cursorStore.load(sessionId);
      try {
        const stream = await this.api.streamEvents(
          sessionId,
          cursor.sequence,
          this.negotiated.maxServerEventBytes,
          this.abortController.signal,
        );
        for await (const envelope of stream) {
          const current = await this.cursorStore.load(sessionId);
          const next = validateEventEnvelope(
            envelope,
            { eventHash: current.eventHash, sequence: current.sequence },
            credentials.serverSigningKeys,
            this.negotiated.maxServerEventBytes,
          );
          const activities = await this.processEvent(envelope, ledger);
          await this.artifacts.recordEvent(envelope);
          await this.cursorStore.persist({
            eventHash: next.eventHash,
            sequence: next.sequence,
            sessionId,
            updatedAt: new Date().toISOString(),
          });
          if (isTerminal(this.activeSnapshot.status)) {
            await this.activeSessionStore.clear(sessionId);
          } else {
            await this.activeSessionStore.persist(this.activeSnapshot);
          }

          await this.artifacts.updateMeta({
            cursor: next.sequence,
            lastEventHash: next.eventHash,
            usage: this.usage,
          });
          for (const activity of activities) {
            await this.artifacts.recordMessage({
              content: activity.content,
              role: activity.type === 'error' ? 'system' : 'assistant',
              timestamp: new Date().toISOString(),
            });
            yield activity;
          }

          reconnectAttempts = 0;
          if (isTerminal(this.activeSnapshot.status)) break;
        }

        if (!isTerminal(this.activeSnapshot.status)) throw new Error('Event stream ended before a terminal event');
      } catch (error) {
        if (this.abortController.signal.aborted) break;
        if (error instanceof ProtocolError) throw error;
        reconnectAttempts += 1;
        if (reconnectAttempts > 8) {
          throw new ProtocolError(
            problem({
              code: 'EVENT_STREAM_RECONNECT_EXHAUSTED',
              detail: error instanceof Error ? error.message : String(error),
              status: 503,
              title: 'Unable to resume backend event stream',
            }),
            { cause: error },
          );
        }

        const delay = Math.min(30_000, 250 * 2 ** (reconnectAttempts - 1));
        yield {
          content: `Event stream interrupted; resuming from durable cursor in ${delay}ms`,
          type: 'status',
        };
        await new Promise((resolve) => {
          setTimeout(resolve, delay);
        });
      }
    }

    if (isTerminal(this.activeSnapshot.status)) {
      await this.artifacts.updateMeta({
        completedAt: new Date().toISOString(),
        status: this.activeSnapshot.status === 'completed'
          ? 'completed'
          : this.activeSnapshot.status === 'cancelled'
            ? 'cancelled'
            : 'failed',
        usage: this.usage,
      });
    } else {
      const cursor = await this.cursorStore.load(sessionId);
      await this.artifacts.updateMeta({
        cursor: cursor.sequence,
        lastEventHash: cursor.eventHash,
        status: 'running',
        usage: this.usage,
      });
    }
  }

  private truncateUtf8(value: string, maxBytes: number): string {
    const characters = Array.from(value);
    let low = 0;
    let high = characters.length;
    let result = '';
    while (low <= high) {
      const midpoint = Math.floor((low + high) / 2);
      const candidate = characters.slice(0, midpoint).join('');
      if (Buffer.byteLength(candidate) <= maxBytes) {
        result = candidate;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }

    return result;
  }
}
