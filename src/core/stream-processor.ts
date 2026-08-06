/**
 * Stream Processor — unified stream handling for LangGraph workflows.
 *
 * Both `sendSingleAgentMessage` and `resumeWithHumanInput` share ~80% of
 * their stream processing logic (event iteration, chunk extraction, tool
 * call/result tracking, silent-failure detection, and post-stream interrupt
 * checking). This module extracts the common parts into a single function.
 */

import type { CompiledStateGraph } from '@langchain/langgraph';

import type { AgentStreamEvent } from './agent.js';
import type { AuditStage } from './graph/pipeline-artifacts.js';
import type { HumanInputRequest } from './graph/state.js';
import type { EnhancedFinding } from './output/finding-schema.js';
import type { PipelineArtifactBundle , ToolArtifactEvent } from './run-artifacts.js';

import { logToStderr } from '../utils/stderr-logger.js';
import { STAGE_AGENT_LABELS, STAGE_LABELS } from './graph/pipeline-prompts.js';
import { normalizeTokenUsage } from './usage.js';

/**
 * Minimal structural type for the compiled workflow accepted by
 * `processAgentStream`.  Using `AgentStateType` directly fails because
 * `CompiledStateGraph` is invariant in its state type parameter and the
 * channel-level types from `Annotation.Root` don't unify with the plain
 * object type.  We only ever call `.getState()` on the workflow, so a
 * narrow type is sufficient and avoids coupling to LangGraph internals.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCompiledStateGraph = CompiledStateGraph<any, any, any>;

/**
 * Options that differ between the normal message and resume paths.
 */
export interface ProcessAgentStreamOptions {
  /** LangGraph streamEvents inputs (messages, pendingHumanInput, etc.). */
  inputs: null | Record<string, unknown>;
  /** LangGraph configurable (thread_id, version). */
  lcConfig: { configurable: { thread_id: string }; version: 'v3' };
  /** Label used in log messages to identify the caller. */
  logLabel: string;
  /** Provider family used to distinguish public summaries from private reasoning. */
  providerHint?: string;
  /** True only when the endpoint is configured to return public reasoning summaries. */
  reasoningSummaryEnabled?: boolean;
  /** Whether to persist messages on success (normal path) or not (resume may have its own logic). */
  recordToolEvent?: (event: ToolArtifactEvent) => Promise<void>;
  /** The compiled workflow to stream from. */
  workflow: AnyCompiledStateGraph;
}

export interface ProcessAgentStreamResult {
  /** Number of successfully completed source-inspection tool actions. */
  evidenceActions: number;
  /** Structured findings committed to checkpointed graph state. */
  findings: EnhancedFinding[];
  /** Whether the workflow explicitly completed through finish_task. */
  finishTaskCompleted: boolean;
  /** The accumulated full text response. */
  fullResponse: string;
  /** If the graph paused at HumanIntervention, the request details. */
  humanInputRequest?: HumanInputRequest;
  /** Explicit file paths successfully read during this operation. */
  inspectedPaths: string[];
  /** Validated stage handoffs persisted for auditability. */
  pipelineArtifacts?: PipelineArtifactBundle;
  /** Whether every attempted structured finding was accepted by the report pipeline. */
  reportFindingsAccepted: boolean;
}

const PUBLIC_MESSAGE_NODE = 'ReportingAgent';
const STAGE_NODES: Readonly<Record<string, AuditStage>> = {
  CodebaseIntelligence: 'codebase_intelligence',
  CodebaseResumeTools: 'codebase_intelligence',
  CodebaseTools: 'codebase_intelligence',
  DevilsAdvocate: 'devils_advocate',
  DevilsAdvocateResumeTools: 'devils_advocate',
  DevilsAdvocateTools: 'devils_advocate',
  ReportingAgent: 'reporting',
  ReportingResumeTools: 'reporting',
  ReportingTools: 'reporting',
  SastAuditor: 'sast_audit',
  SastResumeTools: 'sast_audit',
  SastTools: 'sast_audit',
};

const STAGE_HANDOFF_LABELS: Readonly<Partial<Record<AuditStage, string>>> = {
  devils_advocate: 'Passing candidate findings to the Devil’s Advocate for adversarial verification.',
  reporting: 'Passing verified findings to the reporting agent for the final bug-bounty report.',
  sast_audit: 'Repository intelligence complete. Passing the repository map and report to the specialized SAST auditing agent.',
};

const TOOL_ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  edit_file: 'Editing files',
  execute_command: 'Running a command',
  finish_task: 'Finishing the task',
  list_directory: 'Exploring files',
  read_file_content: 'Reading files',
  search_codebase: 'Searching code',
};
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const SENSITIVE_VALUE_PATTERN =
  /((?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;

function usageMessageId(message: Record<string, unknown>): string | undefined {
  if (typeof message.id === 'string' && message.id.length > 0) return message.id;
  const responseMetadata = message.response_metadata ?? message.responseMetadata;
  if (!responseMetadata || typeof responseMetadata !== 'object') return undefined;
  const metadata = responseMetadata as Record<string, unknown>;
  for (const key of ['id', 'response_id', 'request_id']) {
    if (typeof metadata[key] === 'string' && metadata[key].length > 0) {
      return metadata[key] as string;
    }
  }

  return undefined;
}

function usageEventId(
  event: Record<string, unknown>,
  params: Record<string, unknown>,
  nodeName: unknown,
  messageIndex: number,
): string | undefined {
  for (const candidate of [
    event.id,
    event.run_id,
    event.runId,
    params.id,
    params.run_id,
    params.runId,
  ]) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return `${candidate}:${String(nodeName)}:${messageIndex}`;
    }

    const sequence = event.seq ?? params.seq;
    if (
      (typeof sequence === 'number' && Number.isFinite(sequence)) ||
      (typeof sequence === 'string' && sequence.length > 0)
    ) {
      const namespace = event.namespace ?? params.namespace ?? 'root';
      return `protocol:${String(namespace)}:${String(sequence)}:${String(nodeName)}:${messageIndex}`;
    }
  }
}

function toolActivity(toolName: string, completed: boolean): string {
  const activeLabel = TOOL_ACTIVITY_LABELS[toolName] ?? 'Using a tool';
  if (!completed) return activeLabel;

  const completedLabels: Readonly<Record<string, string>> = {
    edit_file: 'Edited files',
    execute_command: 'Ran a command',
    finish_task: 'Finished the task',
    list_directory: 'Explored files',
    read_file_content: 'Read files',
    search_codebase: 'Searched code',
  };
  return completedLabels[toolName] ?? 'Finished using a tool';
}

function firstOutputLine(value: unknown): string | undefined {
  let text: string | undefined;
  if (typeof value === 'string') {
    text = value;
  } else if (Array.isArray(value)) {
    const textPart = value.find((part) => {
      if (!part || typeof part !== 'object') return false;
      return typeof (part as Record<string, unknown>).text === 'string';
    }) as Record<string, unknown> | undefined;
    text = textPart?.text as string | undefined;
  }

  if (!text) return undefined;
  const plainText = redactSensitiveText(text.replaceAll(ANSI_ESCAPE_PATTERN, '')).trim();
  if (!plainText) return undefined;

  try {
    const structured = JSON.parse(plainText) as unknown;
    if (Array.isArray(structured)) return `${structured.length} items returned`;
    if (structured && typeof structured === 'object') {
      const record = structured as Record<string, unknown>;
      const preferred = record.stdout ?? record.output ?? record.content ?? record.error;
      if (typeof preferred === 'string') return firstOutputLine(preferred);
      const keys = Object.keys(record);
      return keys.length > 0 ? `${keys.slice(0, 3).join(', ')} returned` : 'Structured result returned';
    }
  } catch {
    // Plain-text tool output is handled below.
  }

  const line = plainText.split(/\r?\n/, 1)[0]!;
  return line.length > 140 ? `${line.slice(0, 137)}...` : line;
}

function toolDetail(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const values = args as Record<string, unknown>;
  const detail = toolName === 'execute_command'
    ? values.command ?? values.cmd
    : values.path ?? values.filePath ?? values.pattern ?? values.query;
  if (typeof detail !== 'string' || !detail.trim()) return undefined;
  const safeDetail = redactSensitiveText(detail.trim());
  return toolName === 'execute_command' ? `$ ${safeDetail}` : safeDetail;
}

function redactSensitiveText(value: string): string {
  return value.replaceAll(SENSITIVE_VALUE_PATTERN, '$1[REDACTED]');
}

function toolResultSucceeded(message: Record<string, unknown>, output: string): boolean {
  if (message.status === 'error') return false;
  return !/^\s*\[(?:ERROR|DENIED)\]/i.test(output);
}

function stageIdentity(stage: AuditStage | undefined) {
  return stage
    ? {agent: STAGE_AGENT_LABELS[stage], stage}
    : {};
}

function findProtocolToken(value: string, tokens: string[]) {
  return tokens
    .map((token) => ({index: value.indexOf(token), token}))
    .filter(({index}) => index !== -1)
    .sort((left, right) => left.index - right.index)[0];
}

function retainedProtocolPrefixLength(value: string, tokens: string[]): number {
  for (
    let length = Math.min(Math.max(...tokens.map((token) => token.length)) - 1, value.length);
    length > 0;
    length--
  ) {
    if (tokens.some((token) => token.startsWith(value.slice(-length)))) return length;
  }

  return 0;
}

function progressPreview(value: string): string | undefined {
  const text = value.replaceAll(ANSI_ESCAPE_PATTERN, '').trim();
  if (!text || text.startsWith('[') || text.startsWith('{')) return undefined;
  if (/(?:｜｜DSML｜｜|｜DSML｜)/u.test(text)) return undefined;
  if (/<\/?(?:repo_map|codebase_report|sast_report|sast_candidates_json|adversarial_report|verdicts_json)>/i.test(text)) {
    return undefined;
  }

  const compact = text.replaceAll(/\s+/g, ' ');
  return compact.length > 400 ? `${compact.slice(0, 397)}...` : compact;
}

function isReasoningSummaryBlock(value: Record<string, unknown>): boolean {
  const type = typeof value.type === 'string' ? value.type.toLowerCase() : '';
  return type === 'reasoning' ||
    type === 'reasoning-delta' ||
    type === 'reasoning_delta' ||
    type === 'thought_summary' ||
    type === 'thought-summary-delta';
}

function reasoningSummaryText(value: Record<string, unknown>): string {
  for (const key of ['reasoning', 'text', 'delta', 'summary']) {
    const candidate = value[key];
    if (typeof candidate === 'string') return candidate;
  }

  return '';
}

function mayRenderReasoningSummary(options: ProcessAgentStreamOptions): boolean {
  if (options.reasoningSummaryEnabled === false) return false;
  const provider = options.providerHint?.trim().toLowerCase();
  if (!provider) return options.reasoningSummaryEnabled === true;
  if (provider === 'deepseek' || provider === 'openrouter' || provider === 'ollama') {
    return false;
  }

  return options.reasoningSummaryEnabled === true ||
    provider === 'anthropic' ||
    provider === 'google';
}

/**
 * Process a LangGraph event stream, extracting text chunks and tool events.
 *
 * Handles:
 * - LangGraph v2 ProtocolEvent format (messages + updates)
 * - Silent failure detection (zero processable events)
 * - Post-stream interrupt detection (pendingHumanInput)
 * - Error recovery with nested interrupt checking
 */
type StreamEmitEvent = (event: Omit<AgentStreamEvent, 'timestamp'>) => void;
type ProtocolEvent = Record<string, unknown> & {
  method?: string;
  params?: Record<string, unknown>;
  type?: string;
};

interface StreamState {
  candidateIds: Set<string>;
  currentMessageBlock: string;
  currentPrivateReasoningObserved: boolean;
  currentPublicBlockEmitted: boolean;
  currentPublicSafeBlock: string;
  currentReasoningSummary: string;
  deepSeekPublicPending: string;
  deepSeekPublicProtocol: boolean;
  emittedStages: Set<string>;
  emittedToolCalls: Set<string>;
  emittedToolResults: Set<string>;
  emittedUsageIds: Set<string>;
  eventsProcessed: number;
  evidenceActions: number;
  finishTaskCompleted: boolean;
  fullResponse: string;
  inspectedPaths: Set<string>;
  pendingToolCalls: Map<string, {args: unknown; name: string}>;
  previousPublicBlock: string;
  reportFindingsAccepted: boolean;
  verifiedFindingIds: Set<string>;
}

interface StreamContext {
  emitEvent: StreamEmitEvent;
  onChunk: (text: string) => void;
  options: ProcessAgentStreamOptions;
  state: StreamState;
}

function createStreamState(): StreamState {
  return {
    candidateIds: new Set(),
    currentMessageBlock: '',
    currentPrivateReasoningObserved: false,
    currentPublicBlockEmitted: false,
    currentPublicSafeBlock: '',
    currentReasoningSummary: '',
    deepSeekPublicPending: '',
    deepSeekPublicProtocol: false,
    emittedStages: new Set(),
    emittedToolCalls: new Set(),
    emittedToolResults: new Set(),
    emittedUsageIds: new Set(),
    eventsProcessed: 0,
    evidenceActions: 0,
    finishTaskCompleted: false,
    fullResponse: '',
    inspectedPaths: new Set(),
    pendingToolCalls: new Map(),
    previousPublicBlock: '',
    reportFindingsAccepted: true,
    verifiedFindingIds: new Set(),
  };
}

function announceStage(context: StreamContext, stage: AuditStage): void {
  const {emitEvent, state} = context;
  if (state.emittedStages.has(stage)) return;
  state.emittedStages.add(stage);
  emitEvent({...stageIdentity(stage), kind: 'status', message: STAGE_LABELS[stage]});
  const handoff = STAGE_HANDOFF_LABELS[stage];
  if (handoff) {
    emitEvent({...stageIdentity(stage), kind: 'status', message: handoff});
  }

  emitEvent({
    auditTelemetry: {
      activeStage: stage,
      candidateIds: [...state.candidateIds],
      verifiedFindingIds: [...state.verifiedFindingIds],
    },
    kind: 'audit_telemetry',
    message: 'Audit stage updated.',
  });
}

function auditEvidence(state: StreamState) {
  return {
    evidenceActions: state.evidenceActions,
    finishTaskCompleted: state.finishTaskCompleted,
    inspectedPaths: [...state.inspectedPaths],
    reportFindingsAccepted: state.reportFindingsAccepted,
  };
}

function emitPublicText(context: StreamContext, text: string, prependSeparator: boolean): void {
  const {onChunk, state} = context;
  if (prependSeparator && state.fullResponse.trim()) {
    onChunk('\n\n');
    state.fullResponse += '\n\n';
  }

  onChunk(text);
  state.fullResponse += text;
}

function consumeDeepSeekProtocol(context: StreamContext, text: string): string {
  const {state} = context;
  const markers = ['<｜｜DSML｜｜', '<｜DSML｜'];
  const endMarkers = ['</｜｜DSML｜｜tool_calls>', '</｜DSML｜tool_calls>'];
  let remaining = state.deepSeekPublicPending + text;
  let safe = '';
  state.deepSeekPublicPending = '';

  while (remaining) {
    const tokens = state.deepSeekPublicProtocol ? endMarkers : markers;
    const token = findProtocolToken(remaining, tokens);
    const orphanEnd = state.deepSeekPublicProtocol ? undefined : findProtocolToken(remaining, endMarkers);
    const next = orphanEnd && (!token || orphanEnd.index < token.index) ? orphanEnd : token;
    if (!next) {
      const retained = retainedProtocolPrefixLength(remaining, state.deepSeekPublicProtocol
        ? endMarkers
        : [...markers, ...endMarkers]);
      if (!state.deepSeekPublicProtocol) safe += remaining.slice(0, remaining.length - retained);
      state.deepSeekPublicPending = retained ? remaining.slice(-retained) : '';
      break;
    }

    if (!state.deepSeekPublicProtocol) safe += remaining.slice(0, next.index);
    remaining = remaining.slice(next.index + next.token.length);
    state.deepSeekPublicProtocol = !state.deepSeekPublicProtocol && next === token;
  }

  return safe;
}

function filterPublicText(context: StreamContext, text: string, finish = false): string {
  if (context.options.providerHint?.trim().toLowerCase() !== 'deepseek') return text;
  const safe = consumeDeepSeekProtocol(context, text);
  if (finish) {
    context.state.deepSeekPublicPending = '';
    context.state.deepSeekPublicProtocol = false;
  }

  return safe;
}

function emitPublicDelta(context: StreamContext, text: string): void {
  const {state} = context;
  if (!text) return;
  state.currentPublicSafeBlock += text;
  if (state.currentPublicBlockEmitted) {
    emitPublicText(context, text, false);
    return;
  }

  if (state.previousPublicBlock.startsWith(state.currentPublicSafeBlock)) return;
  const commonPrefixLength = [...state.currentPublicSafeBlock].findIndex(
    (character, index) => state.previousPublicBlock[index] !== character,
  );
  const suffix = commonPrefixLength === -1
    ? state.currentPublicSafeBlock.slice(state.previousPublicBlock.length)
    : state.currentPublicSafeBlock.slice(commonPrefixLength);
  emitPublicText(context, suffix || state.currentPublicSafeBlock, true);
  state.currentPublicBlockEmitted = true;
}

function resetMessageBlock(state: StreamState): void {
  state.currentMessageBlock = '';
  state.currentPublicSafeBlock = '';
  state.currentReasoningSummary = '';
  state.currentPrivateReasoningObserved = false;
  state.currentPublicBlockEmitted = false;
}

function emitProgress(context: StreamContext, stage: AuditStage, message: string): void {
  context.emitEvent({...stageIdentity(stage), kind: 'agent_progress', message});
}

function handleReasoningDelta(
  context: StreamContext,
  delta: Record<string, unknown>,
  stage: AuditStage,
): void {
  const {state} = context;
  if (mayRenderReasoningSummary(context.options)) {
    state.currentReasoningSummary += reasoningSummaryText(delta);
  } else {
    state.currentPrivateReasoningObserved = true;
  }

  const ready = state.currentReasoningSummary.includes('\n') ||
    state.currentReasoningSummary.length >= 160;
  if (!ready) return;
  const progress = progressPreview(state.currentReasoningSummary);
  if (progress) emitProgress(context, stage, progress);
  state.currentReasoningSummary = '';
}

function handleMessageDelta(
  context: StreamContext,
  message: Record<string, unknown>,
  stage: AuditStage,
  isPublicNode: boolean,
): void {
  const delta = message.delta as Record<string, unknown> | undefined;
  if (!delta) return;
  if (isReasoningSummaryBlock(delta)) {
    handleReasoningDelta(context, delta, stage);
    return;
  }

  if (delta.type !== 'text-delta' || typeof delta.text !== 'string') return;
  const safeText = filterPublicText(context, delta.text);
  context.state.currentMessageBlock += safeText;
  if (isPublicNode) emitPublicDelta(context, safeText);
}

function finishReasoningProgress(
  context: StreamContext,
  content: Record<string, unknown> | undefined,
  stage: AuditStage,
): void {
  const {state} = context;
  if (content &&
    !state.currentReasoningSummary &&
    isReasoningSummaryBlock(content) &&
    mayRenderReasoningSummary(context.options)
  ) {
    state.currentReasoningSummary += reasoningSummaryText(content);
  }

  const progress = progressPreview(state.currentReasoningSummary);
  if (progress) {
    emitProgress(context, stage, progress);
  } else if (state.currentPrivateReasoningObserved) {
    emitProgress(context, stage, 'Analyzing evidence and selecting the next audit action.');
  }

  state.currentReasoningSummary = '';
  state.currentPrivateReasoningObserved = false;
}

function recoverFinishedText(
  context: StreamContext,
  content: Record<string, unknown> | undefined,
  isPublicNode: boolean,
): void {
  if (context.state.currentMessageBlock ||
    content?.type !== 'text' ||
    typeof content.text !== 'string' ||
    !content.text
  ) return;
  context.state.currentMessageBlock = filterPublicText(context, content.text);
  if (isPublicNode) emitPublicDelta(context, context.state.currentMessageBlock);
}

function finishMessageBlock(
  context: StreamContext,
  message: Record<string, unknown>,
  stage: AuditStage,
  isPublicNode: boolean,
): void {
  const {state} = context;
  const content = message.content as Record<string, unknown> | undefined;
  finishReasoningProgress(context, content, stage);
  recoverFinishedText(context, content, isPublicNode);
  const publicBlock = context.options.providerHint?.trim().toLowerCase() === 'deepseek'
    ? state.currentPublicSafeBlock
    : state.currentMessageBlock;
  if (isPublicNode && publicBlock && publicBlock !== state.previousPublicBlock) {
    if (!state.currentPublicBlockEmitted) emitPublicText(context, publicBlock, true);
    state.previousPublicBlock = publicBlock;
  } else if (!isPublicNode) {
    const progress = progressPreview(state.currentMessageBlock);
    if (progress) emitProgress(context, stage, progress);
  }

  state.currentMessageBlock = '';
  state.currentPublicBlockEmitted = false;
}

function handleMessageEvent(
  context: StreamContext,
  data: unknown,
  nodeName: unknown,
  stage: AuditStage | undefined,
): void {
  context.state.eventsProcessed++;
  const message = data as Record<string, unknown>;
  const messageEvent = message.event as string | undefined;
  const isPublicNode = nodeName === PUBLIC_MESSAGE_NODE && context.state.finishTaskCompleted;
  if (messageEvent === 'content-block-start') {
    resetMessageBlock(context.state);
  } else if (messageEvent === 'content-block-delta' && stage) {
    handleMessageDelta(context, message, stage, isPublicNode);
  } else if (messageEvent === 'content-block-finish' && stage) {
    finishMessageBlock(context, message, stage, isPublicNode);
  }
}

function updateFindingTelemetry(
  context: StreamContext,
  nodeUpdate: Record<string, unknown>,
  stage: AuditStage | undefined,
  eventStage: AuditStage | undefined,
): void {
  const {candidateIds, verifiedFindingIds} = context.state;
  const sastAudit = nodeUpdate.sastAudit as undefined | {candidates?: Array<{findingId?: unknown}>};
  const verdicts = nodeUpdate.verdicts as Array<{findingId?: unknown; verdict?: unknown}> | undefined;
  const findings = nodeUpdate.pipelineFindings as Array<{vulnId?: unknown}> | undefined;
  if (Array.isArray(sastAudit?.candidates)) {
    candidateIds.clear();
    for (const candidate of sastAudit.candidates) {
      if (typeof candidate.findingId === 'string' && candidate.findingId.length > 0) {
        candidateIds.add(candidate.findingId);
      }
    }
  }

  for (const verdict of verdicts ?? []) {
    if (typeof verdict.findingId !== 'string' || verdict.findingId.length === 0) continue;
    candidateIds.delete(verdict.findingId);
    if (verdict.verdict === 'CONFIRMED') verifiedFindingIds.add(verdict.findingId);
  }

  for (const finding of findings ?? []) {
    if (typeof finding.vulnId !== 'string' || finding.vulnId.length === 0) continue;
    candidateIds.delete(finding.vulnId);
    verifiedFindingIds.add(finding.vulnId);
  }

  if (!sastAudit && !verdicts && !findings) return;
  context.emitEvent({
    auditTelemetry: {
      activeStage: stage ?? eventStage ?? 'codebase_intelligence',
      candidateIds: [...candidateIds],
      verifiedFindingIds: [...verifiedFindingIds],
    },
    kind: 'audit_telemetry',
    message: 'Audit telemetry updated.',
  });
}

function emitTokenUsage(
  context: StreamContext,
  message: Record<string, unknown>,
  usageId: string | undefined,
  stage: AuditStage | undefined,
): void {
  const usage = normalizeTokenUsage(message);
  if (!usage || !usageId || context.state.emittedUsageIds.has(usageId)) return;
  context.state.emittedUsageIds.add(usageId);
  context.emitEvent({
    ...stageIdentity(stage),
    kind: 'token_usage',
    message: 'Model usage recorded.',
    usage,
  });
}

async function emitToolCalls(
  context: StreamContext,
  message: Record<string, unknown>,
  stage: AuditStage | undefined,
): Promise<void> {
  if (!Array.isArray(message.tool_calls)) return;
  for (const toolCall of message.tool_calls as Array<Record<string, unknown>>) {
    const toolCallId = typeof toolCall.id === 'string' ? toolCall.id : undefined;
    if (toolCallId && context.state.emittedToolCalls.has(toolCallId)) continue;
    if (toolCallId) {
      context.state.emittedToolCalls.add(toolCallId);
      context.state.pendingToolCalls.set(toolCallId, {
        args: toolCall.args,
        name: String(toolCall.name),
      });
    }

    const detail = toolDetail(String(toolCall.name), toolCall.args);
    context.emitEvent({
      ...stageIdentity(stage),
      ...(detail ? {detail} : {}),
      ...(toolCallId ? {toolCallId} : {}),
      kind: 'tool_call',
      message: toolActivity(String(toolCall.name), false),
      toolName: toolCall.name as string,
    });
    if (context.options.recordToolEvent) {
      await context.options.recordToolEvent({
        data: toolCall.args,
        event: 'call',
        timestamp: new Date().toISOString(),
        toolCallId: toolCallId ?? `anonymous-${context.state.eventsProcessed}`,
        toolName: String(toolCall.name),
      });
    }
  }
}

function isToolMessage(message: Record<string, unknown>): boolean {
  if (message.type === 'tool') return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof (message as any)._getType === 'function' && (message as any)._getType() === 'tool';
}

function acceptReportFinding(state: StreamState, toolOutput: string): boolean {
  try {
    const reportResult = JSON.parse(toolOutput) as {accepted?: unknown};
    if (reportResult.accepted === true) return true;
  } catch {
    // Invalid report results are rejected below.
  }

  state.reportFindingsAccepted = false;
  return false;
}

function addReadPath(state: StreamState, pendingCall: undefined | {args: unknown; name: string}): void {
  const filePath = (pendingCall?.args as undefined | {filePath?: unknown})?.filePath;
  if (typeof filePath === 'string' && filePath.trim()) state.inspectedPaths.add(filePath.trim());
}

function addRetrievedPaths(state: StreamState, toolOutput: string): void {
  const matchedFiles = /^Files matched: (.+)$/m.exec(toolOutput)?.[1];
  for (const filePath of matchedFiles?.split(',') ?? []) {
    if (filePath.trim()) state.inspectedPaths.add(filePath.trim());
  }
}

function addSearchPaths(state: StreamState, toolOutput: string): void {
  for (const match of toolOutput.matchAll(/^📄 (.+?) — \d+ matches?$/gm)) {
    if (match[1]?.trim()) state.inspectedPaths.add(match[1].trim());
  }
}

interface CompletedTool {
  pendingCall: undefined | {args: unknown; name: string};
  succeeded: boolean;
  toolName: string | undefined;
  toolOutput: string;
}

function recordCompletedTool(state: StreamState, completed: CompletedTool): void {
  const {pendingCall, succeeded, toolName, toolOutput} = completed;
  if (toolName === 'finish_task' && succeeded) {
    state.finishTaskCompleted = true;
    return;
  }

  const evidenceTool = toolName === 'context_retrieval' ||
    toolName === 'read_file_content' ||
    toolName === 'search_codebase';
  if (!succeeded || !evidenceTool) return;
  state.evidenceActions++;
  if (toolName === 'read_file_content') addReadPath(state, pendingCall);
  if (toolName === 'context_retrieval') addRetrievedPaths(state, toolOutput);
  if (toolName === 'search_codebase') addSearchPaths(state, toolOutput);
}

async function emitToolResult(
  context: StreamContext,
  message: Record<string, unknown>,
  stage: AuditStage | undefined,
): Promise<void> {
  if (!isToolMessage(message)) return;
  const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined;
  if (toolCallId && context.state.emittedToolResults.has(toolCallId)) return;
  if (toolCallId) context.state.emittedToolResults.add(toolCallId);
  const pendingCall = toolCallId ? context.state.pendingToolCalls.get(toolCallId) : undefined;
  const toolOutput = typeof message.content === 'string' ? message.content : '';
  const completedToolName = typeof message.name === 'string' ? message.name : pendingCall?.name;
  let succeeded = toolResultSucceeded(message, toolOutput);
  if (completedToolName === 'report_finding') {
    succeeded = succeeded && acceptReportFinding(context.state, toolOutput);
  }

  recordCompletedTool(context.state, {pendingCall, succeeded, toolName: completedToolName, toolOutput});
  if (toolCallId) context.state.pendingToolCalls.delete(toolCallId);
  const resultPreview = firstOutputLine(message.content);
  context.emitEvent({
    ...stageIdentity(stage),
    ...(resultPreview ? {resultPreview} : {}),
    ...(toolCallId ? {toolCallId} : {}),
    kind: 'tool_result',
    message: toolActivity(String(message.name), true),
    succeeded,
    toolName: message.name as string,
  });
  if (context.options.recordToolEvent && completedToolName) {
    await context.options.recordToolEvent({
      data: message.content,
      event: 'result',
      timestamp: new Date().toISOString(),
      toolCallId: toolCallId ?? `anonymous-${context.state.eventsProcessed}`,
      toolName: completedToolName,
    });
  }
}

interface UpdatedMessagesContext {
  event: ProtocolEvent;
  eventStage: AuditStage | undefined;
  messages: unknown;
  nodeName: unknown;
  params: Record<string, unknown>;
  stage: AuditStage | undefined;
}

async function handleUpdatedMessages(
  context: StreamContext,
  update: UpdatedMessagesContext,
): Promise<void> {
  if (!Array.isArray(update.messages)) return;
  for (const [messageIndex, value] of update.messages.entries()) {
    const message = value as Record<string, unknown>;
    const usageId = usageMessageId(message) ??
      usageEventId(update.event, update.params, update.nodeName, messageIndex);
    emitTokenUsage(context, message, usageId, update.stage ?? update.eventStage);
    await emitToolCalls(context, message, update.stage);
    await emitToolResult(context, message, update.stage);
  }
}

function updateEntries(updates: Record<string, unknown>): Array<[string, unknown]> {
  return typeof updates.node === 'string' &&
    updates.values &&
    typeof updates.values === 'object' &&
    !Array.isArray(updates.values)
    ? [[updates.node, updates.values]]
    : Object.entries(updates);
}

interface UpdatesEventContext {
  data: unknown;
  event: ProtocolEvent;
  eventStage: AuditStage | undefined;
  nodeName: unknown;
  params: Record<string, unknown>;
}

async function handleUpdatesEvent(
  context: StreamContext,
  update: UpdatesEventContext,
): Promise<void> {
  context.state.eventsProcessed++;
  for (const [updatedNode, value] of updateEntries(update.data as Record<string, unknown>)) {
    const stage = STAGE_NODES[updatedNode];
    if (stage) announceStage(context, stage);
    const nodeUpdate = value as Record<string, unknown>;
    updateFindingTelemetry(context, nodeUpdate, stage, update.eventStage);
    await handleUpdatedMessages(context, {
      event: update.event,
      eventStage: update.eventStage,
      messages: nodeUpdate.messages,
      nodeName: update.nodeName,
      params: update.params,
      stage,
    });
  }
}

async function processProtocolEvent(context: StreamContext, protocolEvent: unknown): Promise<void> {
  const event = protocolEvent as ProtocolEvent;
  if (event.type !== 'event') return;
  const params = event.params ?? {};
  const data = params.data;
  const nodeName = params.node;
  const eventStage = typeof nodeName === 'string' ? STAGE_NODES[nodeName] : undefined;
  if (eventStage) announceStage(context, eventStage);
  if (event.method === 'messages' && data) {
    handleMessageEvent(context, data, nodeName, eventStage);
  }

  if (event.method === 'updates' && data) {
    await handleUpdatesEvent(context, {data, event, eventStage, nodeName, params});
  }
}

function emitHumanInput(context: StreamContext, pendingInput: HumanInputRequest): void {
  context.emitEvent({
    humanInputRequest: {
      context: pendingInput.context,
      question: pendingInput.question,
      requestId: pendingInput.requestId,
      type: pendingInput.type,
    },
    kind: 'human_input_required',
    message: pendingInput.question,
  });
}

function interruptedResult(
  state: StreamState,
  pendingInput: HumanInputRequest,
  findings: EnhancedFinding[],
): ProcessAgentStreamResult {
  return {
    ...auditEvidence(state),
    findings,
    fullResponse: `[AWAITING_HUMAN_INPUT] ${pendingInput.question}`,
    humanInputRequest: pendingInput,
  };
}

async function finishStream(context: StreamContext): Promise<ProcessAgentStreamResult> {
  const {options, state} = context;
  if (state.eventsProcessed === 0 && !state.fullResponse) {
    logToStderr(`[${options.logLabel}] WARNING: No processable events in stream.`);
    context.emitEvent({kind: 'status', message: 'No response received from the model. Check provider logs.'});
  }

  const workflowState = await getWorkflowState(options.workflow, options.lcConfig);
  for (const file of workflowState.auditedFiles) state.inspectedPaths.add(file);
  state.evidenceActions = Math.max(state.evidenceActions, workflowState.evidenceActions);
  if (workflowState.pipelineReport.trim()) state.finishTaskCompleted = true;
  if (workflowState.pendingHumanInput) {
    emitHumanInput(context, workflowState.pendingHumanInput);
    return interruptedResult(state, workflowState.pendingHumanInput, workflowState.pipelineFindings);
  }

  if (workflowState.pipelineReport) {
    const report = options.providerHint?.trim().toLowerCase() === 'deepseek'
      ? filterPublicText(context, workflowState.pipelineReport, true)
      : workflowState.pipelineReport;
    if (!state.fullResponse) {
      emitPublicText(context, report, false);
    } else if (state.fullResponse.trim() !== report.trim()) {
      throw new Error('The streamed reporter response did not match the checkpointed final report.');
    }
  }

  const pipelineArtifacts = workflowState.codebaseIntelligence &&
    workflowState.sastAudit &&
    workflowState.devilsAdvocate &&
    workflowState.pipelineReport
    ? {
        adversarialReport: workflowState.devilsAdvocate.reportMarkdown,
        codebaseReport: workflowState.codebaseIntelligence.reportMarkdown,
        finalReport: workflowState.pipelineReport,
        repoMap: workflowState.codebaseIntelligence.repoMap,
        sastReport: workflowState.sastAudit.reportMarkdown,
        verdicts: workflowState.devilsAdvocate.verdicts,
      }
    : undefined;
  return {
    ...auditEvidence(state),
    findings: workflowState.pipelineFindings,
    fullResponse: state.fullResponse,
    ...(pipelineArtifacts ? {pipelineArtifacts} : {}),
  };
}

export async function processAgentStream(
  onChunk: (text: string) => void,
  emitEvent: StreamEmitEvent,
  options: ProcessAgentStreamOptions,
): Promise<ProcessAgentStreamResult> {
  const context: StreamContext = {emitEvent, onChunk, options, state: createStreamState()};
  try {
    const stream = await options.workflow.streamEvents(options.inputs, options.lcConfig);
    for await (const protocolEvent of stream) {
      try {
        await processProtocolEvent(context, protocolEvent);
      } catch (streamError) {
        throw new Error(
          `Malformed ${options.logLabel} stream event: ${
            streamError instanceof Error ? streamError.message : String(streamError)
          }`,
          {cause: streamError},
        );
      }
    }

    return await finishStream(context);
  } catch (error) {
    const pendingInput = await getPendingHumanInput(options.workflow, options.lcConfig);
    if (!pendingInput) throw error;
    emitHumanInput(context, pendingInput);
    return interruptedResult(context.state, pendingInput, []);
  }
}

async function getWorkflowState(
  workflow: AnyCompiledStateGraph,
  lcConfig: { configurable: { thread_id: string }; version: 'v3' },
): Promise<{
  auditedFiles: string[];
  codebaseIntelligence: null | {repoMap: string; reportMarkdown: string};
  devilsAdvocate: null | {reportMarkdown: string; verdicts: unknown[]};
  evidenceActions: number;
  pendingHumanInput: HumanInputRequest | null;
  pipelineFindings: EnhancedFinding[];
  pipelineReport: string;
  sastAudit: null | {reportMarkdown: string};
}> {
  const stateSnapshot = await workflow.getState(lcConfig);
  const values = stateSnapshot?.values as Record<string, unknown> | undefined;
  return {
    auditedFiles: Array.isArray(values?.auditedFiles)
      ? values.auditedFiles.filter((value): value is string => typeof value === 'string')
      : [],
    codebaseIntelligence: values?.codebaseIntelligence as null | {
      repoMap: string;
      reportMarkdown: string;
    } ?? null,
    devilsAdvocate: values?.devilsAdvocate as null | {
      reportMarkdown: string;
      verdicts: unknown[];
    } ?? null,
    evidenceActions: typeof values?.evidenceActions === 'number'
      ? values.evidenceActions
      : 0,
    pendingHumanInput: values?.pendingHumanInput as HumanInputRequest | null ?? null,
    pipelineFindings: Array.isArray(values?.pipelineFindings)
      ? values.pipelineFindings as EnhancedFinding[]
      : [],
    pipelineReport: typeof values?.pipelineReport === 'string' ? values.pipelineReport : '',
    sastAudit: values?.sastAudit as null | {reportMarkdown: string} ?? null,
  };
}

/**
 * Safely check for pendingHumanInput from the workflow's checkpointed state.
 * Returns null if there's no pending input or if getState fails.
 */
async function getPendingHumanInput(
  workflow: AnyCompiledStateGraph,
  lcConfig: { configurable: { thread_id: string }; version: 'v3' },
): Promise<HumanInputRequest | null> {
  try {
    const stateSnapshot = await workflow.getState(lcConfig);
    const pendingInput = stateSnapshot?.values?.pendingHumanInput as HumanInputRequest | null | undefined;
    if (pendingInput) {
      return {
        context: pendingInput.context,
        question: pendingInput.question,
        type: pendingInput.type,
      };
    }
  } catch {
    // getState failed — checkpoint may be corrupt
  }

  return null;
}
