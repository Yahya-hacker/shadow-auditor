import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { CompiledStateGraph } from '@langchain/langgraph';
import type { LanguageModel, ModelMessage, StepResult, ToolSet } from 'ai';

import { HumanMessage } from '@langchain/core/messages';
import * as path from 'node:path';

import type { AgentStateType, HumanInputRequest } from './graph/state.js';
import type { MCPRawInvoker } from './mcp/types.js';
import type { MissionObjective, MissionPhase, TransitionReason } from './orchestrator/mission-state.js';
import type { TransitionContext } from './orchestrator/transitions.js';
import type { SecurityReport } from './output/report-schema.js';

import { type ShadowConfig } from '../utils/config.js';
import { getEmbeddingDefaults, getProviderBaseUrl, normalizeProviderName } from '../utils/provider-catalog.js';
import { compileWorkflow } from './graph/workflow.js';
import { SwarmCoordinator } from './hivemind/swarm-coordinator.js';
import { type SwarmStateSnapshot } from './hivemind/swarm-supervisor.js';
import { createChromeDevtoolsAdapter } from './mcp/adapters/chrome-devtools.js';
import { createKaliLinuxAdapter } from './mcp/adapters/kali-linux.js';
import { MCPManager } from './mcp/manager.js';
import { vulnerabilityCanonicalId } from './memory/entity-normalizer.js';
import { HybridRetriever } from './memory/hybrid-retriever.js';
import {
  type EmbeddingProvider,
  NullEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
  SemanticIndex,
} from './memory/semantic-index.js';
import { resolveRuntimeSettings, type RuntimeSettings } from './model-capabilities.js';
import { getLangchainModel, getModel } from './model-router.js';
import { PersistentCheckpointSaver } from './orchestrator/checkpoint-saver.js';
import { MissionEngine } from './orchestrator/mission-engine.js';
import { computeCiExitCode, type FailOnSeverity, formatCiSummary } from './output/ci-exit.js';
import { deduplicateFindings } from './output/dedup.js';
import { ReportBuilder } from './output/report-builder.js';
import { validateAndRepairReport } from './output/report-validator.js';
import { generateEnhancedSarifReport } from './output/sarif.js';
import { createPathGuard } from './policy/path-guard.js';
import { RunArtifacts } from './run-artifacts.js';
import { type StreamActivity } from './session.js';
import { buildSystemPrompt } from './system-prompt.js';
import { createBashTool } from './tools/bash.js';
import { createContextRetrievalTool } from './tools/context-retrieval.js';
import { createEditFileTool } from './tools/edit-file.js';
import { createExecuteCommandTool } from './tools/execute-command.js';
import { createFinishTaskTool } from './tools/finish-task.js';
import { createListDirectoryTool } from './tools/list-directory.js';
import { createReadFileTool } from './tools/read-file.js';
import { createSearchCodebaseTool } from './tools/search-codebase.js';

export interface AgentSessionOptions {
  /** Diff scope hint from incremental mode (pre-built string) */
  diffScopeHint?: string;
  expertUnsafe?: boolean;
  /** Name of the user — injected into the system prompt for personalization. */
  userName?: string;
}

export interface AgentStreamEvent {
  humanInputRequest?: HumanInputRequest;
  kind: 'human_input_required' | 'status' | 'swarm_state' | StreamActivity['kind'];
  message: string;
  swarmState?: SwarmStateSnapshot;
  timestamp: string;
  toolCallId?: string;
  toolName?: string;
}

const REPORT_REPAIR_SYSTEM_PROMPT = `You are a strict JSON repair engine.
Return only valid JSON for this schema:
{
  "findings": [
    {
      "vuln_id": "string",
      "title": "string",
      "severity_label": "Critical|High|Medium|Low|Info",
      "cvss_v31_score": 0.0,
      "cvss_v31_vector": "CVSS:3.1/...",
      "cvss_v40_score": null,
      "cwe": "CWE-000",
      "file_paths": ["path/to/file"]
    }
  ]
}
If no findings, return {"findings":[]}.
Do not include markdown fences or extra text.`;

function normalizeRole(role: string): 'assistant' | 'system' | 'tool' | 'user' {
  if (role === 'assistant' || role === 'tool' || role === 'user') {
    return role;
  }

  return 'system';
}

function maybeCreateHttpInvoker(endpoint?: string): MCPRawInvoker | undefined {
  const normalizedEndpoint = endpoint?.trim();
  if (!normalizedEndpoint) {
    return undefined;
  }

  return async (operation: string, input: Record<string, unknown>) => {
    const response = await fetch(normalizedEndpoint, {
      body: JSON.stringify({ input, operation }),
      headers: {
        'content-type': 'application/json',
      },
      method: 'POST',
    });

    if (!response.ok) {
      throw new Error(`MCP endpoint error (${response.status}): ${response.statusText}`);
    }

    const rawBody = await response.text();
    if (!rawBody) {
      return '';
    }

    try {
      return JSON.parse(rawBody) as unknown;
    } catch {
      return rawBody;
    }
  };
}

function toContentString(content: ModelMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }

  return JSON.stringify(content);
}

/**
 * Write to stderr without interfering with Ink's stdout rendering.
 */
function logToStderr(message: string): void {
  process.stderr.write(`[ShadowAuditor] ${message}\n`);
}

export class AgentSession {
  private artifacts: null | RunArtifacts = null;
  private compiledWorkflow: null | ReturnType<typeof compileWorkflow> = null;
  private diffScopeHint: string;
  private expertUnsafe: boolean;
  private initialized: Promise<void>;
  private langchainModel: BaseChatModel | null = null;
  private mcpManager: MCPManager | null = null;
  private messages: ModelMessage[] = [];
  private missionEngine: MissionEngine | null = null;
  private model: LanguageModel;
  private runtime: RuntimeSettings;
  private reportBuilder: null | ReportBuilder = null;
  private runtimeWarnings: string[] = [];
  private semanticIndex: null | SemanticIndex = null;
  private swarmCoordinator: null | SwarmCoordinator = null;
  private systemPrompt = '';
  private threadCounter = 0;
  private tools: ToolSet = {};
  private userName: string;

  constructor(
    private readonly config: ShadowConfig,
    private readonly repoMap: string,
    private readonly targetPath: string,
    options: AgentSessionOptions = {},
  ) {
    this.model = getModel(config);
    this.expertUnsafe = options.expertUnsafe ?? config.expertUnsafe ?? false;
    this.diffScopeHint = options.diffScopeHint ?? '';
    this.userName = options.userName ?? 'User';
    this.runtime = resolveRuntimeSettings(
      config,
      (warning: string) => {
        this.runtimeWarnings.push(warning);
        logToStderr(warning);
      },
      config.auditMode,
    );

    const resolvedTargetPath = path.resolve(targetPath);
    this.messages = [
      {
        content: `## REPOSITORY ARCHITECTURE MAP

The following is a compressed architectural map of the target codebase at \`${resolvedTargetPath}\`.
It contains structural signatures (imports, declarations, type surfaces), not implementation bodies.

\`\`\`
${repoMap}
\`\`\`

You also have access to a \`context_retrieval\` tool that provides semantic, lexical, and graph-based code search.
Use \`context_retrieval\` to find specific code patterns, vulnerability-related functions, or data flow paths on-demand
rather than reading entire files. This is more efficient for large codebases.

Use your tools to inspect implementation details, verify assumptions, and produce precise security findings.`,
        role: 'user',
      },
      {
        content: `Repository map ingested. Semantic code retrieval is available via context_retrieval. Ready for autonomous security analysis with controlled tooling and machine-readable reporting.`,
        role: 'assistant',
      },
    ];

    this.initialized = this.initialize();
  }

  /**
   * Check if the workflow is currently paused awaiting human input.
   */
  async isPausedAwaitingHumanInput(): Promise<boolean> {
    await this.initialized;
    if (!this.compiledWorkflow) return false;

    const config = {
      configurable: { thread_id: 'session_main' },
      version: 'v3' as const,
    };

    try {
      const stateSnapshot = await this.compiledWorkflow.getState(config);
      return stateSnapshot?.values?.pendingHumanInput != null;
    } catch {
      return false;
    }
  }

  /**
   * Generate the final security report from all collected findings.
   *
   * Runs the complete report pipeline: deduplication, SARIF generation,
   * JSON export, and Markdown export. Returns paths to all generated files.
   */
  async generateReport(): Promise<{
    jsonPath?: string;
    markdownPath?: string;
    sarifPath?: string;
  } | null> {
    await this.initialized;
    if (!this.reportBuilder || !this.artifacts) return null;

    // Set coverage stats before building
    const indexedFiles = this.semanticIndex?.getIndexedFilePaths().length ?? 0;
    this.reportBuilder.setCoverage(indexedFiles);

    const generated = await this.reportBuilder.generate();
    logToStderr(`[Report] Generated: ${[
      generated.jsonPath,
      generated.markdownPath,
      generated.sarifPath,
    ].filter(Boolean).join(', ')}`);

    // Persist report metadata to artifacts
    await this.artifacts.recordMessage({
      content: {
        reportId: generated.report.metadata.reportId,
        summary: generated.report.summary,
        totalFindings: generated.report.findings.length,
      },
      role: 'system',
      timestamp: new Date().toISOString(),
    });

    return {
      jsonPath: generated.jsonPath,
      markdownPath: generated.markdownPath,
      sarifPath: generated.sarifPath,
    };
  }

  /**
   * Get the report builder (for adding findings during analysis).
   */
  getReportBuilder(): ReportBuilder | null {
    return this.reportBuilder;
  }

  /**
   * Resume a paused LangGraph workflow with the human's answer.
   *
   * Called by the TUI after the user responds to a `human_input_required`
   * event. Injects the answer as a HumanMessage, clears pendingHumanInput,
   * and re-runs the graph from the checkpoint. The stream processing is
   * identical to sendSingleAgentMessage, including interrupt detection
   * (a subsequent tool may also need confirmation).
   */
  async resumeWithHumanInput(
    answer: boolean | string,
    onChunk: (text: string) => void,
    onEvent?: (event: AgentStreamEvent) => void,
  ): Promise<string> {
    await this.initialized;
    if (!this.compiledWorkflow) {
      throw new Error('Workflow not compiled.');
    }

    const emitEvent = (event: Omit<AgentStreamEvent, 'timestamp'>) => {
      onEvent?.({ ...event, timestamp: new Date().toISOString() });
    };

    // Use the same stable thread ID as sendSingleAgentMessage so the
    // checkpointer can find the paused state and resume from it.
    const config = {
      configurable: { thread_id: 'session_main' },
      version: 'v3' as const,
    };

    const answerText = typeof answer === 'boolean'
      ? (answer ? 'Yes, approved.' : 'No, denied.')
      : answer;

    const inputs = {
      messages: [new HumanMessage({ content: answerText })],
      pendingHumanInput: null,
    };

    emitEvent({
      kind: 'status',
      message: `Resuming with human input: ${answerText}`,
    });

    let fullResponse = '';
    let eventsProcessed = 0;

    try {
      const stream = await this.compiledWorkflow.streamEvents(inputs, config);

      for await (const event of stream) {
        try {
          // ── LangGraph v2 ProtocolEvent format ──────────────────────────
          if (event.type === 'event') {
            const method = event.method;
            const params = event.params ?? {};
            const data = params.data;
            const nodeName = params.node;

            if (method === 'messages' && data) {
              eventsProcessed++;
              const msgData = data as Record<string, unknown>;
	              const msgEvent = msgData.event as string | undefined;

	              if (msgEvent === 'content-block-delta') {
	                const delta = msgData.delta as Record<string, unknown> | undefined;
	                if (delta && typeof delta === 'object') {
	                  if (delta.type === 'text-delta' && typeof delta.text === 'string') {
	                    onChunk(delta.text);
	                    fullResponse += delta.text;
	                  }
	                }
	              } else if (msgEvent === 'content-block-start' || msgEvent === 'content-block-finish') {
	                const content = msgData.content as Record<string, unknown> | undefined;
	                if (
	                  content &&
	                  typeof content === 'object' &&
	                  content.type === 'text' &&
	                  typeof content.text === 'string' &&
	                  content.text
	                ) {
	                  if (!fullResponse.includes(content.text)) {
	                    onChunk(content.text);
	                    fullResponse += content.text;
	                  }
	                }
	              }
	            }

	            if (method === 'updates' && data) {
	              const updates = data as Record<string, unknown>;
	              for (const [, value] of Object.entries(updates)) {
	                const nodeUpdate = value as Record<string, unknown>;
	                const msgs = nodeUpdate?.messages;
	                if (Array.isArray(msgs)) {
	                  for (const msg of msgs) {
	                    const msgObj = msg as Record<string, unknown>;
	                    if (msgObj.tool_calls && Array.isArray(msgObj.tool_calls)) {
	                      for (const tc of msgObj.tool_calls as Array<Record<string, unknown>>) {
	                        emitEvent({
	                          kind: 'tool_call',
	                          message: `[${nodeName ?? 'agent'}] Executing tool: ${tc.name}`,
	                          toolCallId: tc.id as string,
	                          toolName: tc.name as string,
	                        });
	                      }
	                    }

	                    if (
	                      msgObj.type === 'tool' ||
	                      (typeof (msgObj as any)._getType === 'function' && (msgObj as any)._getType() === 'tool')
	                    ) {
	                      emitEvent({
	                        kind: 'tool_result',
	                        message: `[${nodeName ?? 'agent'}] Completed tool: ${msgObj.name}`,
	                        toolCallId: msgObj.tool_call_id as string,
	                        toolName: msgObj.name as string,
	                      });
	                    }
	                  }
	                }
	              }
	            }
          }
        } catch (streamError) {
          logToStderr(
            `[streamEvents] Error processing resume event: ${
              streamError instanceof Error ? streamError.message : String(streamError)
            }`,
          );
        }
      }

      // Check for another interrupt (nested confirmation)

      // Detect silent failures in resume path too.
      if (eventsProcessed === 0 && !fullResponse) {
        logToStderr(
          `[resumeWithHumanInput] WARNING: No processable events in resumed stream.`,
        );
        emitEvent({
          kind: 'status',
          message: 'No response received on resume. Check provider logs.',
        });
      }

      const stateSnapshot = await this.compiledWorkflow.getState(config);
      const pendingInput = stateSnapshot?.values?.pendingHumanInput;
      if (pendingInput) {
        emitEvent({
          humanInputRequest: {
            context: pendingInput.context,
            question: pendingInput.question,
            type: pendingInput.type,
          },
          kind: 'human_input_required',
          message: pendingInput.question,
        });
        return `[AWAITING_HUMAN_INPUT] ${pendingInput.question}`;
      }

      await this.persistMessages([{ content: answerText, role: 'user' }]);
      await this.persistMessages([{ content: fullResponse, role: 'assistant' }]);
      return fullResponse;
    } catch (error) {
      this.runtimeWarnings.push(`Resume failed: ${error instanceof Error ? error.message : String(error)}`);
      emitEvent({ kind: 'status', message: 'Resume aborted due to error.' });

      // The graph may have paused at HumanIntervention again (nested
      // confirmation) before the stream error occurred. Check the
      // checkpointed state so the TUI can show the nested question.
      try {
        const stateSnapshot = await this.compiledWorkflow!.getState(config);
        const pendingInput = stateSnapshot?.values?.pendingHumanInput;
        if (pendingInput) {
          emitEvent({
            humanInputRequest: {
              context: pendingInput.context,
              question: pendingInput.question,
              type: pendingInput.type,
            },
            kind: 'human_input_required',
            message: pendingInput.question,
          });
          return `[AWAITING_HUMAN_INPUT] ${pendingInput.question}`;
        }
      } catch {
        // getState itself failed — the checkpoint may be corrupt.
      }

      return '[Resume Failed]';
    }
  }

  /**
   * Send a message to the agent and stream responses back.
   * Routes to either single-agent LangGraph or multi-agent Swarm mode.
   */
  async sendMessage(
    userMessage: string,
    onChunk: (text: string) => void,
    onEvent?: (event: AgentStreamEvent) => void,
  ): Promise<string> {
    await this.initialized;
    if (!this.artifacts) {
      throw new Error('Run artifacts are not initialized.');
    }

    const emitEvent = (event: Omit<AgentStreamEvent, 'timestamp'>) => {
      onEvent?.({
        ...event,
        timestamp: new Date().toISOString(),
      });
    };

    // Route to swarm mode if enabled
    if (this.config.swarm?.enabled && this.swarmCoordinator) {
      return this.sendSwarmMessage(userMessage, onChunk, onEvent, emitEvent);
    }

    return this.sendSingleAgentMessage(userMessage, onChunk, onEvent, emitEvent);
  }

  private createEmbeddingProvider(): EmbeddingProvider {
    const indexingConfig = this.config.indexing;
    const providerDefaults = getEmbeddingDefaults(this.config.provider);
    const embeddingProvider = indexingConfig?.embeddingProvider ?? providerDefaults.embeddingProvider;
    const embeddingModel = indexingConfig?.embeddingModel ?? providerDefaults.embeddingModel;

    if (embeddingProvider === 'ollama') {
      return new OllamaEmbeddingProvider({
        model: embeddingModel,
      });
    }

    if (!this.config.apiKey) {
      throw new Error(
        `[SemanticIndex] Embedding provider "${embeddingProvider}" requires an API key for "${this.config.provider}".`,
      );
    }

    const normalizedProvider = normalizeProviderName(this.config.provider);
    const baseUrl = getProviderBaseUrl(normalizedProvider, this.config.customBaseUrl);

    return new OpenAIEmbeddingProvider({
      apiKey: this.config.apiKey,
      baseUrl,
      model: embeddingModel,
      providerName: normalizedProvider,
    });
  }

  private async initialize(): Promise<void> {
    const pathGuard = await createPathGuard(this.targetPath);
    const resolvedTargetPath = pathGuard.rootRealPath;

    const mcpEnabled = this.isMcpEnabled();
    const mcpTools = await this.initializeMcpTools(resolvedTargetPath, mcpEnabled);

    const commandPolicyConfig = {
      additionalAllowedCommandPatterns: this.config.commandPolicy?.additionalAllowedCommandPatterns,
      additionalDeniedPatterns: this.config.commandPolicy?.additionalDeniedPatterns,
      allowPnpmYarn: this.config.commandPolicy?.allowPnpmYarn ?? true,
      expertUnsafe: this.expertUnsafe,
    };

    // Initialize artifacts and mission runtime first (needed for semantic index graph integration)
    this.artifacts = await RunArtifacts.create(resolvedTargetPath, {
      maxOutputTokens: this.runtime.maxOutputTokens,
      maxToolSteps: this.runtime.maxToolSteps,
      mcpEnabled: Object.keys(mcpTools).length > 0,
      model: this.config.model,
      provider: this.config.provider,
      targetPath: resolvedTargetPath,
      warnings: [...this.runtimeWarnings],
    });

    // Initialize the report builder — findings collected during analysis
    // will be fed through deduplication and SARIF/JSON/Markdown generation.
    this.reportBuilder = new ReportBuilder({
      outputDir: this.artifacts.getRunDirectory(),
      runId: path.basename(this.artifacts.getRunDirectory()),
      scanMode: this.config.auditMode,
      targetName: path.basename(resolvedTargetPath),
      toolVersion: '1.0.0',
    });
    this.reportBuilder.setStartTime(Date.now());

    await this.initializeMissionRuntime(resolvedTargetPath);

    // Initialize semantic indexing after MissionEngine (needs KnowledgeGraph for HybridRetriever)
    const contextRetrievalTools = await this.initializeSemanticIndex(resolvedTargetPath);

    this.tools = {
      bash: createBashTool({
        commandPolicy: commandPolicyConfig,
        workingDirectory: resolvedTargetPath,
      }),
      edit_file: createEditFileTool(pathGuard),
      execute_command: createExecuteCommandTool({
        commandPolicy: commandPolicyConfig,
        workingDirectory: resolvedTargetPath,
      }),
      finish_task: createFinishTaskTool(),
      list_directory: createListDirectoryTool(pathGuard),
      read_file_content: createReadFileTool(pathGuard),
      search_codebase: createSearchCodebaseTool(pathGuard),
      ...contextRetrievalTools,
      ...mcpTools,
    };

    this.systemPrompt = buildSystemPrompt({
      auditMode: this.config.auditMode ?? this.runtime.capabilities.preferredAuditMode,
      diffScope: this.diffScopeHint || undefined,
      mcpEnabled: Object.keys(mcpTools).length > 0,
      userName: this.userName,
      // Working memory starts empty; it's updated dynamically by the
      // workflow nodes as analysis progresses.
      workingMemory: '',
    });

    // Compile the LangGraph workflow ONCE for reuse across messages
    this.langchainModel = getLangchainModel(this.config);
    const toolsArray = Object.entries(this.tools).map(([name, tool]) => ({ name, tool }));

    // Create a persistent checkpointer for state management and human interrupts
    const runDirectory = this.artifacts.getRunDirectory();
    const checkpointer = new PersistentCheckpointSaver({ storagePath: runDirectory });
    await checkpointer.initialize();

    this.compiledWorkflow = compileWorkflow({
      checkpointer,
      model: this.langchainModel,
      providerHint: this.config.provider,
      systemPrompt: this.systemPrompt,
      tools: toolsArray,
    });

    // Initialize swarm coordinator if enabled
    if (this.config.swarm?.enabled) {
      await this.initializeSwarmCoordinator(resolvedTargetPath);
    }

    await this.artifacts.recordMessage({
      content: {
        indexing: this.semanticIndex ? this.semanticIndex.stats() : null,
        mission: this.missionEngine?.getState() ?? null,
        model: this.config.model,
        provider: this.config.provider,
        runtime: this.runtime,
      },
      role: 'system',
      timestamp: new Date().toISOString(),
    });
  }

  private async initializeMcpTools(targetPath: string, enabled: boolean): Promise<ToolSet> {
    if (!enabled) {
      return {};
    }

    const manager = new MCPManager({
      expertUnsafe: this.expertUnsafe,
      targetPath,
    });

    const chromeInvoker = maybeCreateHttpInvoker(
      this.config.mcp?.chromeDevtoolsEndpoint ?? process.env.SHADOW_AUDITOR_MCP_CHROME_ENDPOINT,
    );
    const kaliInvoker = maybeCreateHttpInvoker(
      this.config.mcp?.kaliLinuxEndpoint ?? process.env.SHADOW_AUDITOR_MCP_KALI_ENDPOINT,
    );

    const enabledAdapters = new Set(this.config.mcp?.adapters ?? ['chrome-devtools', 'kali-linux']);
    if (enabledAdapters.has('chrome-devtools')) {
      manager.registerAdapter(createChromeDevtoolsAdapter({ invoker: chromeInvoker }));
    }

    if (enabledAdapters.has('kali-linux')) {
      manager.registerAdapter(createKaliLinuxAdapter({ invoker: kaliInvoker }));
    }

    await manager.initialize();
    this.mcpManager = manager;
    return manager.buildAgentTools();
  }

  private async initializeMissionRuntime(resolvedTargetPath: string): Promise<void> {
    if (!this.artifacts) {
      return;
    }

    try {
      const runDirectory = this.artifacts.getRunDirectory();
      const runId = path.basename(runDirectory);
      const objective: MissionObjective = {
        constraints: [],
        description: `Perform autonomous security analysis for ${resolvedTargetPath}`,
        objectiveId: 'objective01',
        priority: 'high',
        scope: {
          excludePaths: [],
          includePaths: [resolvedTargetPath],
          targetTypes: ['repository'],
        },
        status: 'in_progress',
      };

      this.missionEngine = new MissionEngine({
        maxTokens: this.runtime.maxOutputTokens * Math.max(1, this.runtime.maxToolSteps),
        maxToolCalls: this.runtime.maxToolSteps,
        runId,
        storagePath: runDirectory,
      });

      await this.missionEngine.initialize([objective]);
    } catch (error) {
      this.missionEngine = null;
      this.runtimeWarnings.push(
        `Mission engine initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async initializeSemanticIndex(resolvedTargetPath: string): Promise<ToolSet> {
    const indexingConfig = this.config.indexing;

    // Skip semantic indexing if explicitly disabled
    if (indexingConfig?.enabled === false) {
      return {};
    }

    try {
      // Create embedding provider based on configuration
      let provider = this.createEmbeddingProvider();

      // Preflight: test the embedding provider connection before committing
      // to a full repository indexing pass. This prevents the 400-error spam
      // that occurs when a non-OpenAI provider hits the OpenAI embeddings endpoint.
      if (provider.testConnection) {
        const isHealthy = await provider.testConnection();
        if (!isHealthy) {
          logToStderr(
            `[SemanticIndex] Embedding provider "${provider.name}" failed health check. ` +
            'Attempting fallback...',
          );

          // Try Ollama as fallback
          const ollamaFallback = new OllamaEmbeddingProvider();
          const ollamaHealthy = await ollamaFallback.testConnection();
          if (ollamaHealthy) {
            logToStderr(
              '[SemanticIndex] Falling back to local Ollama embeddings.',
            );
            provider = ollamaFallback;
          } else {
            logToStderr(
              '[SemanticIndex] Embeddings unavailable or misconfigured. ' +
              'Disabling semantic search for this session.',
            );
            this.semanticIndex = null;
            this.runtimeWarnings.push(
              'Semantic indexing disabled: no working embedding provider available. ' +
              'Install Ollama and pull nomic-embed-text for local embeddings.',
            );
            return {};
          }
        }
      }

      // Create semantic index
      const storagePath = this.artifacts
        ? path.join(this.artifacts.getRunDirectory(), 'semantic-index')
        : path.join(resolvedTargetPath, '.shadow-auditor', 'semantic-index');

      this.semanticIndex = new SemanticIndex({
        maxChunkChars: indexingConfig?.maxChunkChars ?? 4000,
        provider,
        rootPath: resolvedTargetPath,
        storagePath,
      });

      await this.semanticIndex.initialize();

      // Index the repository — wrapped in its own try/catch so that
      // embedding failures during indexing are caught cleanly
      try {
        const { chunksIndexed, filesIndexed } = await this.semanticIndex.indexRepository(
          (progress) => {
            if (progress.filesIndexed % 50 === 0 || progress.filesIndexed === progress.totalFiles) {
              logToStderr(
                `[SemanticIndex] Indexed ${progress.filesIndexed}/${progress.totalFiles} files (${progress.currentFile})`,
              );
            }
          },
        );

        logToStderr(
          `[SemanticIndex] Indexing complete: ${filesIndexed} files, ${chunksIndexed} chunks`,
        );
      } catch (indexError) {
        // Embedding API failed during indexing — disable gracefully
        logToStderr(
          '[SemanticIndex] Embeddings unavailable or misconfigured. ' +
          'Disabling semantic search for this session.',
        );
        this.semanticIndex = null;
        this.runtimeWarnings.push(
          `Semantic indexing disabled after embedding error: ${
            indexError instanceof Error ? indexError.message : String(indexError)
          }`,
        );
        return {};
      }

      // Build HybridRetriever if MissionEngine graph is available
      if (this.missionEngine) {
        const graph = this.missionEngine.getGraph();
        const retrieval = this.missionEngine.getRetrieval();

        const hybridRetriever = new HybridRetriever(
          graph,
          retrieval,
          this.semanticIndex,
          { rootPath: resolvedTargetPath },
        );

        // Attach hybrid retriever to the retrieval service
        retrieval.setHybridRetriever(hybridRetriever);

        // Create context retrieval tool
        return {
          context_retrieval: createContextRetrievalTool({
            retriever: hybridRetriever,
            rootPath: resolvedTargetPath,
          }),
        };
      }

      // Fallback: create a minimal hybrid retriever without graph
      // (MissionEngine may not be initialized yet)
      return {};
    } catch {
      // Top-level catch for any unexpected errors (initialization, etc.)
      logToStderr(
        '[SemanticIndex] Embeddings unavailable or misconfigured. ' +
        'Disabling semantic search for this session.',
      );
      this.semanticIndex = null;
      return {};
    }
  }

  private async initializeSwarmCoordinator(resolvedTargetPath: string): Promise<void> {
    if (!this.artifacts) {
      return;
    }

    try {
      const runDirectory = this.artifacts.getRunDirectory();
      const runId = path.basename(runDirectory);

      this.swarmCoordinator = new SwarmCoordinator({
        allTools: this.tools,
        auditMode: this.config.auditMode ?? 'balanced',
        config: this.config,
        diffScopeHint: this.diffScopeHint,
        model: this.model,
        runId,
        storagePath: path.join(runDirectory, 'swarm'),
      });

      logToStderr('[SwarmCoordinator] Multi-agent swarm mode enabled.');
    } catch (error) {
      this.swarmCoordinator = null;
      this.runtimeWarnings.push(
        `Swarm coordinator initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private isMcpEnabled(): boolean {
    if (typeof this.config.mcp?.enabled === 'boolean') {
      return this.config.mcp.enabled;
    }

    return process.env.SHADOW_AUDITOR_ENABLE_MCP === '1';
  }

  private async persistMessages(messages: ModelMessage[]): Promise<void> {
    if (!this.artifacts) {
      return;
    }

    for (const message of messages) {
      await this.artifacts.recordMessage({
        content: toContentString(message.content),
        role: normalizeRole(message.role),
        timestamp: new Date().toISOString(),
      });
    }
  }

  private async persistToolEvents(steps: Array<StepResult<ToolSet>>): Promise<void> {
    if (!this.artifacts) {
      return;
    }

    for (const step of steps) {
      for (const toolCall of step.toolCalls) {
        await this.artifacts.recordToolEvent({
          data: toolCall.input,
          event: 'call',
          timestamp: new Date().toISOString(),
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
        });
      }

      for (const toolResult of step.toolResults) {
        await this.artifacts.recordToolEvent({
          data: toolResult.output,
          event: 'result',
          timestamp: new Date().toISOString(),
          toolCallId: toolResult.toolCallId,
          toolName: toolResult.toolName,
        });
      }
    }
  }

  /**
   * Send message through the single-agent LangGraph workflow.
   *
   * Uses a persistent thread ID so the checkpointer maintains conversation
   * state across messages. This lets the model see prior turns and the
   * initial system context (repo map, tool descriptions) that was seeded
   * into the first invocation.
   */
  private async sendSingleAgentMessage(
    userMessage: string,
    onChunk: (text: string) => void,
    onEvent: ((event: AgentStreamEvent) => void) | undefined,
    emitEvent: (event: Omit<AgentStreamEvent, 'timestamp'>) => void,
  ): Promise<string> {
    emitEvent({
      kind: 'status',
      message: 'Processing mission sequence...',
    });

    // Declare outside try so they're accessible in catch for state recovery.
    const threadId = `session_main`;
    this.threadCounter++;
    const lcConfig = {
      configurable: { thread_id: threadId },
      version: 'v3' as const,
    };
    const inputs = {
      messages: [new HumanMessage({ content: userMessage })],
    };

    try {
      if (!this.compiledWorkflow) {
        throw new Error('Workflow not compiled. Initialization may have failed.');
      }

      let fullResponse = '';
      let eventsProcessed = 0;

      // Stream events from the LangGraph execution.
      // LangGraph v2 emits ProtocolEvent objects: { type: "event", method: "...", params: { ... } }
      // Older LangChain versions emit: { event: "on_...", data: { ... }, run_id, name }
      const stream = await this.compiledWorkflow.streamEvents(inputs, lcConfig);

      for await (const event of stream) {
        try {
        // ── LangGraph v2 ProtocolEvent format ──────────────────────────
          if (event.type === 'event') {
            const method = event.method;
            const params = event.params ?? {};
            const data = params.data;
            const nodeName = params.node;

            // Stream message content chunks from 'messages' events.
            // v3 ProtocolEvent MessagesData is a discriminated union on
            // `event`: "message-start", "content-block-start",
            // "content-block-delta", "content-block-finish",
            // "message-finish", "error".
            if (method === 'messages' && data) {
              eventsProcessed++;
              const msgData = data as Record<string, unknown>;
	              const msgEvent = msgData.event as string | undefined;

	              if (msgEvent === 'content-block-delta') {
	                // Streaming text chunks arrive via text-delta deltas.
	                const delta = msgData.delta as Record<string, unknown> | undefined;
	                if (delta && typeof delta === 'object') {
	                  if (delta.type === 'text-delta' && typeof delta.text === 'string') {
	                    onChunk(delta.text);
	                    fullResponse += delta.text;
	                  }
	                }
	              } else if (msgEvent === 'content-block-start' || msgEvent === 'content-block-finish') {
	                // Finalized text content block (content-block-finish) or
	                // initial block from non-streaming providers.
	                const content = msgData.content as Record<string, unknown> | undefined;
	                if (
	                  content &&
	                  typeof content === 'object' &&
	                  content.type === 'text' &&
	                  typeof content.text === 'string' &&
	                  content.text
	                ) {
	                  // Avoid emitting duplicates: if deltas already streamed
	                  // this content, fullResponse already contains it.
	                  if (!fullResponse.includes(content.text)) {
	                    onChunk(content.text);
	                    fullResponse += content.text;
	                  }
	                }
	              }
	              // "message-start", "message-finish", "error" are metadata-only
	            }

	            // Track tool invocations and results from 'updates' events.
	            // Each node update carries the messages produced during that
	            // step, including AIMessages with tool_calls and ToolMessages
	            // with tool results.
	            if (method === 'updates' && data) {
              const updates = data as Record<string, unknown>;
              for (const [, value] of Object.entries(updates)) {
                const nodeUpdate = value as Record<string, unknown>;
                const msgs = nodeUpdate?.messages;
                if (Array.isArray(msgs)) {
                  for (const msg of msgs) {
                    const msgObj = msg as Record<string, unknown>;
                    // AIMessage with tool calls
                    if (msgObj.tool_calls && Array.isArray(msgObj.tool_calls)) {
                      for (const tc of msgObj.tool_calls as Array<Record<string, unknown>>) {
                        emitEvent({
                          kind: 'tool_call',
                          message: `[${nodeName ?? 'agent'}] Executing tool: ${tc.name}`,
                          toolCallId: tc.id as string,
                          toolName: tc.name as string,
                        });
                      }
                    }

                    // ToolMessage with results
                    if (
                      msgObj.type === 'tool' ||
                      (typeof (msgObj as any)._getType === 'function' && (msgObj as any)._getType() === 'tool')
                    ) {
                      emitEvent({
                        kind: 'tool_result',
                        message: `[${nodeName ?? 'agent'}] Completed tool: ${msgObj.name}`,
                        toolCallId: msgObj.tool_call_id as string,
                        toolName: msgObj.name as string,
                      });
                    }
                  }
                }
              }
            }
          }
        } catch (streamError) {
          // Don't let a single malformed event kill the entire stream.
          // Log and continue processing subsequent events.
          logToStderr(
            `[streamEvents] Error processing event: ${
              streamError instanceof Error ? streamError.message : String(streamError)
            }`,
          );
        }
      }

      // After the stream ends, check if the graph paused at HumanIntervention
      // (interruptBefore). This happens when a tool threw a Command to request
      // human confirmation. The stream completes gracefully (no error), but the
      // checkpointed state has pendingHumanInput set.

      // Detect silent failures: if the stream produced zero processable events
      // (no messages, no tool calls, nothing), the model may have failed
      // silently or the provider returned an unrecognized event format.
      if (eventsProcessed === 0 && !fullResponse) {
        logToStderr(
          `[sendSingleAgentMessage] WARNING: No processable events in stream. ` +
          'The provider may have returned an unrecognized response format, ' +
          'or the model failed silently.',
        );
        emitEvent({
          kind: 'status',
          message: 'No response received from the model. Check provider logs.',
        });
      }

      const stateSnapshot = await this.compiledWorkflow.getState(lcConfig);
      const pendingInput = stateSnapshot?.values?.pendingHumanInput;
      if (pendingInput) {
        emitEvent({
          humanInputRequest: {
            context: pendingInput.context,
            question: pendingInput.question,
            type: pendingInput.type,
          },
          kind: 'human_input_required',
          message: pendingInput.question,
        });

        // Don't persist yet — the conversation is incomplete until the human
        // responds. Return a marker so the TUI knows the run is paused.
        return `[AWAITING_HUMAN_INPUT] ${pendingInput.question}`;
      }

      await this.persistMessages([{ content: userMessage, role: 'user' }]);
      await this.persistMessages([{ content: fullResponse, role: 'assistant' }]);

      return fullResponse;
    } catch (error) {
      this.runtimeWarnings.push(`Workflow execution failed: ${error instanceof Error ? error.message : String(error)}`);
      emitEvent({
        kind: 'status',
        message: 'Workflow execution aborted due to error.',
      });

      // The graph may have paused at HumanIntervention before the stream
      // error occurred (e.g., a tool threw a Command, then the stream
      // connection broke). Check the checkpointed state so the TUI can
      // still show the question instead of silently discarding the pause.
      try {
        const stateSnapshot = await this.compiledWorkflow!.getState(lcConfig);
        const pendingInput = stateSnapshot?.values?.pendingHumanInput;
        if (pendingInput) {
          emitEvent({
            humanInputRequest: {
              context: pendingInput.context,
              question: pendingInput.question,
              type: pendingInput.type,
            },
            kind: 'human_input_required',
            message: pendingInput.question,
          });
          return `[AWAITING_HUMAN_INPUT] ${pendingInput.question}`;
        }
      } catch {
        // getState itself failed — the checkpoint may be corrupt. Continue
        // to return the failure marker below.
      }

      return '[Workflow Failed]';
    }
  }

  /**
   * Send message through the multi-agent swarm coordinator.
   */
  private async sendSwarmMessage(
    userMessage: string,
    onChunk: (text: string) => void,
    onEvent: ((event: AgentStreamEvent) => void) | undefined,
    emitEvent: (event: Omit<AgentStreamEvent, 'timestamp'>) => void,
  ): Promise<string> {
    emitEvent({
      kind: 'status',
      message: 'Dispatching to swarm coordinator...',
    });

    try {
      const result = await this.swarmCoordinator!.executeMission(
        userMessage,
        (workerRole, activity) => {
          if (activity.kind === 'swarm_state' && activity.swarmState) {
            // Structured swarm snapshot for the live panel / status bar.
            emitEvent({
              kind: 'swarm_state',
              message: activity.message,
              swarmState: activity.swarmState,
            });
            return;
          }

          emitEvent({
            kind: activity.kind === 'tool_call' ? 'tool_call' : activity.kind === 'tool_result' ? 'tool_result' : 'status',
            message: `[${workerRole}] ${activity.message}`,
            toolName: activity.toolName,
          });
        },
      );

      onChunk(result);
      await this.persistMessages([
        { content: userMessage, role: 'user' },
        { content: result, role: 'assistant' },
      ]);

      return result;
    } catch (error) {
      this.runtimeWarnings.push(`Swarm execution failed: ${error instanceof Error ? error.message : String(error)}`);
      emitEvent({
        kind: 'status',
        message: 'Swarm execution aborted due to error.',
      });
      return '[Swarm Failed]';
    }
  }

  private async startMissionCycle(userMessage: string): Promise<null | string> {
    if (!this.missionEngine) {
      return null;
    }

    const hypothesis = this.missionEngine.addHypothesis({
      confidence: 0.35,
      description: userMessage.slice(0, 1000),
      evidenceIds: [],
      status: 'investigating',
      type: 'user-request',
    });

    await this.transitionMission('ORIENT', 'evidence_collected', {
      hypothesesUpdated: [hypothesis],
    });
    await this.transitionMission('DECIDE', 'hypotheses_formed', {});

    const action = this.missionEngine.queueAction({
      estimatedTokens: Math.min(4096, this.runtime.maxOutputTokens),
      parameters: {
        promptPreview: userMessage.slice(0, 240),
      },
      priority: 1,
      rationale: 'Drive the next OODA ACT phase from the latest user request.',
      toolName: 'llm_orchestrator',
    });

    await this.transitionMission('ACT', 'action_selected', {
      newActions: [action],
    });

    return action.actionId;
  }

  private async transitionMission(
    targetPhase: MissionPhase,
    reason: TransitionReason,
    context: TransitionContext,
  ): Promise<void> {
    if (!this.missionEngine) {
      return;
    }

    const currentState = this.missionEngine.getState();
    if (currentState.currentPhase === targetPhase) {
      return;
    }

    const result = await this.missionEngine.transition(targetPhase, reason, context);
    if (!result.ok) {
      this.runtimeWarnings.push(
        `Mission transition ${currentState.currentPhase}→${targetPhase} blocked: ${result.error}`,
      );
    }
  }
}
