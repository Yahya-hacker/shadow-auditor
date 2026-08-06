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
export async function processAgentStream(
  onChunk: (text: string) => void,
  emitEvent: (event: Omit<AgentStreamEvent, 'timestamp'>) => void,
  options: ProcessAgentStreamOptions,
): Promise<ProcessAgentStreamResult> {
  const { inputs, lcConfig, logLabel, recordToolEvent, workflow } = options;

  let fullResponse = '';
  let eventsProcessed = 0;
  let currentMessageBlock = '';
  let currentPublicSafeBlock = '';
  let currentReasoningSummary = '';
  let currentPrivateReasoningObserved = false;
  let currentPublicBlockEmitted = false;
  let previousPublicBlock = '';
  let deepSeekPublicProtocol = false;
  let deepSeekPublicPending = '';
  const emittedToolCalls = new Set<string>();
  const emittedToolResults = new Set<string>();
  const emittedUsageIds = new Set<string>();
  const pendingToolCalls = new Map<string, { args: unknown; name: string }>();
  const emittedStages = new Set<string>();
  const candidateIds = new Set<string>();
  const verifiedFindingIds = new Set<string>();
  const inspectedPaths = new Set<string>();
  let evidenceActions = 0;
  let finishTaskCompleted = false;
  let reportFindingsAccepted = true;

  const announceStage = (stage: AuditStage) => {
    if (emittedStages.has(stage)) return;
    emittedStages.add(stage);
    emitEvent({
      ...stageIdentity(stage),
      kind: 'status',
      message: STAGE_LABELS[stage],
    });
    const handoff = STAGE_HANDOFF_LABELS[stage];
    if (handoff) {
      emitEvent({
        ...stageIdentity(stage),
        kind: 'status',
        message: handoff,
      });
    }

    emitEvent({
      auditTelemetry: {
        activeStage: stage,
        candidateIds: [...candidateIds],
        verifiedFindingIds: [...verifiedFindingIds],
      },
      kind: 'audit_telemetry',
      message: 'Audit stage updated.',
    });
  };

  const auditEvidence = () => ({
    evidenceActions,
    finishTaskCompleted,
    inspectedPaths: [...inspectedPaths],
    reportFindingsAccepted,
  });

  const emitPublicText = (text: string, prependSeparator: boolean) => {
    if (prependSeparator && fullResponse.trim()) {
      onChunk('\n\n');
      fullResponse += '\n\n';
    }

    onChunk(text);
    fullResponse += text;
  };

  const filterPublicText = (text: string, finish = false): string => {
    if (options.providerHint?.trim().toLowerCase() !== 'deepseek') return text;

    const markers = ['<｜｜DSML｜｜', '<｜DSML｜'];
    const endMarkers = ['</｜｜DSML｜｜tool_calls>', '</｜DSML｜tool_calls>'];

    let remaining = deepSeekPublicPending + text;
    let safe = '';
    deepSeekPublicPending = '';

    while (remaining) {
      if (deepSeekPublicProtocol) {
        const end = findProtocolToken(remaining, endMarkers);
        if (!end) {
          const retained = retainedProtocolPrefixLength(remaining, endMarkers);
          deepSeekPublicPending = retained ? remaining.slice(-retained) : '';
          break;
        }

        remaining = remaining.slice(end.index + end.token.length);
        deepSeekPublicProtocol = false;
        continue;
      }

      const marker = findProtocolToken(remaining, markers);
      const orphanEnd = findProtocolToken(remaining, endMarkers);
      if (orphanEnd && (!marker || orphanEnd.index < marker.index)) {
        safe += remaining.slice(0, orphanEnd.index);
        remaining = remaining.slice(orphanEnd.index + orphanEnd.token.length);
        continue;
      }

      if (marker) {
        safe += remaining.slice(0, marker.index);
        remaining = remaining.slice(marker.index + marker.token.length);
        deepSeekPublicProtocol = true;
        continue;
      }

      const retained = retainedProtocolPrefixLength(remaining, [...markers, ...endMarkers]);
      safe += remaining.slice(0, remaining.length - retained);
      deepSeekPublicPending = remaining.slice(remaining.length - retained);
      break;
    }

    if (finish) {
      deepSeekPublicPending = '';
      deepSeekPublicProtocol = false;
    }

    return safe;
  };

  const emitPublicDelta = (text: string) => {
    if (!text) return;
    currentPublicSafeBlock += text;
    if (currentPublicBlockEmitted) {
      emitPublicText(text, false);
      return;
    }

    if (previousPublicBlock.startsWith(currentPublicSafeBlock)) return;
    const commonPrefixLength = [...currentPublicSafeBlock].findIndex(
      (character, index) => previousPublicBlock[index] !== character,
    );
    const suffix = commonPrefixLength === -1
      ? currentPublicSafeBlock.slice(previousPublicBlock.length)
      : currentPublicSafeBlock.slice(commonPrefixLength);
    emitPublicText(suffix || currentPublicSafeBlock, true);
    currentPublicBlockEmitted = true;
  };

  try {
    const stream = await workflow.streamEvents(inputs, lcConfig);

    for await (const protocolEvent of stream) {
      try {
        const event = protocolEvent as unknown as Record<string, unknown> & {
          method?: string;
          params?: Record<string, unknown>;
          type?: string;
        };
        if (event.type === 'event') {
          const method = event.method;
          const params = event.params ?? {};
          const data = params.data;
          const nodeName = params.node;
          const eventStage =
            typeof nodeName === 'string' ? STAGE_NODES[nodeName] : undefined;
          if (eventStage) announceStage(eventStage);

          // Stream message content from 'messages' events (v3 ProtocolEvent)
          if (method === 'messages' && data) {
            eventsProcessed++;
            const msgData = data as Record<string, unknown>;
            const msgEvent = msgData.event as string | undefined;
            const isPublicNode =
              nodeName === PUBLIC_MESSAGE_NODE && finishTaskCompleted;

            if (msgEvent === 'content-block-start') {
              currentMessageBlock = '';
              currentPublicSafeBlock = '';
              currentReasoningSummary = '';
              currentPrivateReasoningObserved = false;
              currentPublicBlockEmitted = false;
            } else if (msgEvent === 'content-block-delta' && eventStage) {
              const delta = msgData.delta as Record<string, unknown> | undefined;
              if (delta && isReasoningSummaryBlock(delta)) {
                if (mayRenderReasoningSummary(options)) {
                  currentReasoningSummary += reasoningSummaryText(delta);
                } else {
                  currentPrivateReasoningObserved = true;
                }

                if (
                  currentReasoningSummary.includes('\n') ||
                  currentReasoningSummary.length >= 160
                ) {
                  const progress = progressPreview(currentReasoningSummary);
                  if (progress) {
                    emitEvent({
                      ...stageIdentity(eventStage),
                      kind: 'agent_progress',
                      message: progress,
                    });
                  }

                  currentReasoningSummary = '';
                }
              } else if (delta && typeof delta === 'object' && delta.type === 'text-delta' && typeof delta.text === 'string') {
                const safeText = filterPublicText(delta.text);
                currentMessageBlock += safeText;
                if (isPublicNode) {
                  emitPublicDelta(safeText);
                }
              }
            } else if (msgEvent === 'content-block-finish' && eventStage) {
              const content = msgData.content as Record<string, unknown> | undefined;
              if (
                content &&
                !currentReasoningSummary &&
                isReasoningSummaryBlock(content) &&
                mayRenderReasoningSummary(options)
              ) {
                currentReasoningSummary += reasoningSummaryText(content);
              }

              const reasoningProgress = progressPreview(currentReasoningSummary);
              if (reasoningProgress) {
                emitEvent({
                  ...stageIdentity(eventStage),
                  kind: 'agent_progress',
                  message: reasoningProgress,
                });
              } else if (currentPrivateReasoningObserved) {
                emitEvent({
                  ...stageIdentity(eventStage),
                  kind: 'agent_progress',
                  message: 'Analyzing evidence and selecting the next audit action.',
                });
              }

              currentReasoningSummary = '';
              currentPrivateReasoningObserved = false;
              if (!currentMessageBlock &&
                content &&
                typeof content === 'object' &&
                content.type === 'text' &&
                typeof content.text === 'string' &&
                content.text
              ) {
                currentMessageBlock = filterPublicText(content.text);
                if (isPublicNode) {
                  emitPublicDelta(currentMessageBlock);
                }
              }

              const publicBlock = options.providerHint?.trim().toLowerCase() === 'deepseek'
                ? currentPublicSafeBlock
                : currentMessageBlock;
              if (isPublicNode && publicBlock && publicBlock !== previousPublicBlock) {
                if (!currentPublicBlockEmitted) {
                  emitPublicText(publicBlock, true);
                }

                previousPublicBlock = publicBlock;
              } else if (!isPublicNode) {
                const progress = progressPreview(currentMessageBlock);
                if (progress) {
                  emitEvent({
                    ...stageIdentity(eventStage),
                    kind: 'agent_progress',
                    message: progress,
                  });
                }
              }

              currentMessageBlock = '';
              currentPublicBlockEmitted = false;
            }
          }

          // Track tool invocations and results from 'updates' events
          if (method === 'updates' && data) {
            eventsProcessed++;
            const updates = data as Record<string, unknown>;
            const updateEntries: Array<[string, unknown]> =
              typeof updates.node === 'string' &&
              updates.values &&
              typeof updates.values === 'object' &&
              !Array.isArray(updates.values)
                ? [[updates.node, updates.values]]
                : Object.entries(updates);
            for (const [updatedNode, value] of updateEntries) {
              const stage = STAGE_NODES[updatedNode];
              if (stage) announceStage(stage);

              const nodeUpdate = value as Record<string, unknown>;
              const sastAudit = nodeUpdate?.sastAudit as
                | undefined
                | {candidates?: Array<{findingId?: unknown}>};
              if (Array.isArray(sastAudit?.candidates)) {
                candidateIds.clear();
                for (const candidate of sastAudit.candidates) {
                  if (typeof candidate.findingId === 'string' && candidate.findingId.length > 0) {
                    candidateIds.add(candidate.findingId);
                  }
                }
              }

              const verdicts = nodeUpdate?.verdicts as
                | Array<{findingId?: unknown; verdict?: unknown}>
                | undefined;
              if (Array.isArray(verdicts)) {
                for (const verdict of verdicts) {
                  if (typeof verdict.findingId !== 'string' || verdict.findingId.length === 0) continue;
                  candidateIds.delete(verdict.findingId);
                  if (verdict.verdict === 'CONFIRMED') {
                    verifiedFindingIds.add(verdict.findingId);
                  }
                }
              }

              const pipelineFindings = nodeUpdate?.pipelineFindings as
                | Array<{vulnId?: unknown}>
                | undefined;
              if (Array.isArray(pipelineFindings)) {
                for (const finding of pipelineFindings) {
                  if (typeof finding.vulnId === 'string' && finding.vulnId.length > 0) {
                    candidateIds.delete(finding.vulnId);
                    verifiedFindingIds.add(finding.vulnId);
                  }
                }
              }

              if (sastAudit || verdicts || pipelineFindings) {
                emitEvent({
                  auditTelemetry: {
                    activeStage: stage ?? eventStage ?? 'codebase_intelligence',
                    candidateIds: [...candidateIds],
                    verifiedFindingIds: [...verifiedFindingIds],
                  },
                  kind: 'audit_telemetry',
                  message: 'Audit telemetry updated.',
                });
              }

              const msgs = nodeUpdate?.messages;
              if (Array.isArray(msgs)) {
                for (const [messageIndex, msg] of msgs.entries()) {
                  const msgObj = msg as Record<string, unknown>;
                  const usage = normalizeTokenUsage(msgObj);
                  const usageId = usageMessageId(msgObj) ??
                    usageEventId(event, params, nodeName, messageIndex);
                  if (usage && usageId && !emittedUsageIds.has(usageId)) {
                    emittedUsageIds.add(usageId);
                    emitEvent({
                      ...stageIdentity(stage ?? eventStage),
                      kind: 'token_usage',
                      message: 'Model usage recorded.',
                      usage,
                    });
                  }

                  if (msgObj.tool_calls && Array.isArray(msgObj.tool_calls)) {
                    for (const tc of msgObj.tool_calls as Array<Record<string, unknown>>) {
                      const toolCallId = typeof tc.id === 'string' ? tc.id : undefined;
                      if (toolCallId && emittedToolCalls.has(toolCallId)) continue;
                      if (toolCallId) emittedToolCalls.add(toolCallId);
                      if (toolCallId) {
                        pendingToolCalls.set(toolCallId, {
                          args: tc.args,
                          name: String(tc.name),
                        });
                      }

                      const detail = toolDetail(String(tc.name), tc.args);
                      emitEvent({
                        ...stageIdentity(stage),
                        ...(detail ? { detail } : {}),
                        ...(toolCallId ? { toolCallId } : {}),
                        kind: 'tool_call',
                        message: toolActivity(String(tc.name), false),
                        toolName: tc.name as string,
                      });
                      if (recordToolEvent) {
                        await recordToolEvent({
                          data: tc.args,
                          event: 'call',
                          timestamp: new Date().toISOString(),
                          toolCallId: toolCallId ?? `anonymous-${eventsProcessed}`,
                          toolName: String(tc.name),
                        });
                      }
                    }
                  }

                  if (
                    msgObj.type === 'tool' ||
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (typeof (msgObj as any)._getType === 'function' && (msgObj as any)._getType() === 'tool')
                  ) {
                    const toolCallId = typeof msgObj.tool_call_id === 'string' ? msgObj.tool_call_id : undefined;
                    if (toolCallId && emittedToolResults.has(toolCallId)) continue;
                    if (toolCallId) emittedToolResults.add(toolCallId);
                    const pendingToolCall = toolCallId ? pendingToolCalls.get(toolCallId) : undefined;
                    const toolOutput = typeof msgObj.content === 'string' ? msgObj.content : '';
                    let toolSucceeded = toolResultSucceeded(msgObj, toolOutput);
                    const completedToolName = typeof msgObj.name === 'string'
                      ? msgObj.name
                      : pendingToolCall?.name;
                    if (completedToolName === 'report_finding') {
                      try {
                        const reportResult = JSON.parse(toolOutput) as { accepted?: unknown };
                        if (reportResult.accepted !== true) {
                          reportFindingsAccepted = false;
                          toolSucceeded = false;
                        }
                      } catch {
                        reportFindingsAccepted = false;
                        toolSucceeded = false;
                      }
                    }

                    if (completedToolName === 'finish_task' && toolSucceeded) {
                      finishTaskCompleted = true;
                    } else if (toolSucceeded && (
                      completedToolName === 'context_retrieval' ||
                      completedToolName === 'read_file_content' ||
                      completedToolName === 'search_codebase'
                    )) {
                      evidenceActions++;
                      if (completedToolName === 'read_file_content' && pendingToolCall) {
                        const filePath = (pendingToolCall.args as { filePath?: unknown }).filePath;
                        if (typeof filePath === 'string' && filePath.trim()) {
                          inspectedPaths.add(filePath.trim());
                        }
                      } else if (completedToolName === 'context_retrieval') {
                        const matchedFiles = /^Files matched: (.+)$/m.exec(toolOutput)?.[1];
                        for (const filePath of matchedFiles?.split(',') ?? []) {
                          if (filePath.trim()) inspectedPaths.add(filePath.trim());
                        }
                      } else if (completedToolName === 'search_codebase') {
                        for (const match of toolOutput.matchAll(/^📄 (.+?) — \d+ matches?$/gm)) {
                          if (match[1]?.trim()) inspectedPaths.add(match[1].trim());
                        }
                      }
                    }

                    if (toolCallId) pendingToolCalls.delete(toolCallId);

                    const resultPreview = firstOutputLine(msgObj.content);
                    emitEvent({
                      ...stageIdentity(stage),
                      ...(resultPreview ? { resultPreview } : {}),
                      ...(toolCallId ? { toolCallId } : {}),
                      kind: 'tool_result',
                      message: toolActivity(String(msgObj.name), true),
                      succeeded: toolSucceeded,
                      toolName: msgObj.name as string,
                    });
                    if (recordToolEvent && completedToolName) {
                      await recordToolEvent({
                        data: msgObj.content,
                        event: 'result',
                        timestamp: new Date().toISOString(),
                        toolCallId: toolCallId ?? `anonymous-${eventsProcessed}`,
                        toolName: completedToolName,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      } catch (streamError) {
        throw new Error(
          `Malformed ${logLabel} stream event: ${
            streamError instanceof Error ? streamError.message : String(streamError)
          }`,
          { cause: streamError },
        );
      }
    }

    // Detect silent failures
    if (eventsProcessed === 0 && !fullResponse) {
      logToStderr(
        `[${logLabel}] WARNING: No processable events in stream.`,
      );
      emitEvent({
        kind: 'status',
        message: 'No response received from the model. Check provider logs.',
      });
    }

    // Check for HumanIntervention interrupt
    const state = await getWorkflowState(workflow, lcConfig);
    for (const file of state.auditedFiles) inspectedPaths.add(file);
    evidenceActions = Math.max(evidenceActions, state.evidenceActions);
    if (state.pipelineReport.trim()) {
      finishTaskCompleted = true;
    }

    const pendingInput = state.pendingHumanInput;
    if (pendingInput) {
      emitEvent({
        humanInputRequest: {
          context: pendingInput.context,
          question: pendingInput.question,
          requestId: pendingInput.requestId,
          type: pendingInput.type,
        },
        kind: 'human_input_required',
        message: pendingInput.question,
      });

      return {
        ...auditEvidence(),
        findings: state.pipelineFindings,
        fullResponse: `[AWAITING_HUMAN_INPUT] ${pendingInput.question}`,
        humanInputRequest: pendingInput,
      };
    }

    if (state.pipelineReport) {
      const safePipelineReport = options.providerHint?.trim().toLowerCase() === 'deepseek'
        ? filterPublicText(state.pipelineReport, true)
        : state.pipelineReport;
      if (!fullResponse) {
        emitPublicText(safePipelineReport, false);
      } else if (fullResponse.trim() !== safePipelineReport.trim()) {
        throw new Error(
          'The streamed reporter response did not match the checkpointed final report.',
        );
      }
    }

    // Persist messages if the caller wants it


    const pipelineArtifacts =
      state.codebaseIntelligence &&
      state.sastAudit &&
      state.devilsAdvocate &&
      state.pipelineReport
        ? {
            adversarialReport: state.devilsAdvocate.reportMarkdown,
            codebaseReport: state.codebaseIntelligence.reportMarkdown,
            finalReport: state.pipelineReport,
            repoMap: state.codebaseIntelligence.repoMap,
            sastReport: state.sastAudit.reportMarkdown,
            verdicts: state.devilsAdvocate.verdicts,
          }
        : undefined;
    return {
      ...auditEvidence(),
      findings: state.pipelineFindings,
      fullResponse,
      ...(pipelineArtifacts ? {pipelineArtifacts} : {}),
    };
  } catch (error) {
    // The graph may have paused at HumanIntervention before the stream error
    const pendingInput = await getPendingHumanInput(workflow, lcConfig);
    if (pendingInput) {
      emitEvent({
        humanInputRequest: {
          context: pendingInput.context,
          question: pendingInput.question,
          requestId: pendingInput.requestId,
          type: pendingInput.type,
        },
        kind: 'human_input_required',
        message: pendingInput.question,
      });
      return {
        ...auditEvidence(),
        findings: [],
        fullResponse: `[AWAITING_HUMAN_INPUT] ${pendingInput.question}`,
        humanInputRequest: pendingInput,
      };
    }

    throw error;
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
