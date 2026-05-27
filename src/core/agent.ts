import { generateText, type LanguageModel, type ModelMessage, type StepResult, type ToolSet } from 'ai';
import * as path from 'node:path';

import type { ShadowConfig } from '../utils/config.js';
import type { MCPRawInvoker } from './mcp/types.js';
import type { MissionObjective, MissionPhase, TransitionReason } from './orchestrator/mission-state.js';
import type { TransitionContext } from './orchestrator/transitions.js';
import type { SecurityReport } from './output/report-schema.js';

import { SwarmCoordinator } from './hivemind/swarm-coordinator.js';
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
import { getModel } from './model-router.js';
import { MissionEngine } from './orchestrator/mission-engine.js';
import { computeCiExitCode, type FailOnSeverity, formatCiSummary } from './output/ci-exit.js';
import { deduplicateFindings } from './output/dedup.js';
import { validateAndRepairReport } from './output/report-validator.js';
import { generateSarifReport } from './output/sarif.js';
import { createPathGuard } from './policy/path-guard.js';
import { RunArtifacts } from './run-artifacts.js';
import { type StreamActivity, streamWithContinuation } from './session.js';
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
}

export interface AgentStreamEvent {
  kind: 'status' | StreamActivity['kind'];
  message: string;
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

export class AgentSession {
  private artifacts: null | RunArtifacts = null;
  private diffScopeHint: string;
  private expertUnsafe: boolean;
  private initialized: Promise<void>;
  private mcpManager: MCPManager | null = null;
  private messages: ModelMessage[] = [];
  private missionEngine: MissionEngine | null = null;
  private model: LanguageModel;
  private runtime: RuntimeSettings;
  private runtimeWarnings: string[] = [];
  private semanticIndex: null | SemanticIndex = null;
  private systemPrompt = '';
  private tools: ToolSet = {};

  constructor(
    private readonly config: ShadowConfig,
    repoMap: string,
    private readonly targetPath: string,
    options: AgentSessionOptions = {},
  ) {
    this.model = getModel(config);
    this.expertUnsafe = options.expertUnsafe ?? config.expertUnsafe ?? false;
    this.diffScopeHint = options.diffScopeHint ?? '';
    this.runtime = resolveRuntimeSettings(
      config,
      (warning) => {
        this.runtimeWarnings.push(warning);
        console.warn(warning);
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

    const timestamp = new Date().toISOString();
    this.messages.push({
      content: userMessage,
      role: 'user',
    });
    await this.artifacts.recordMessage({
      content: userMessage,
      role: 'user',
      timestamp,
    });

    if (this.config.swarm?.enabled) {
      emitEvent({ kind: 'status', message: 'Planning Swarm analysis mission' });
      const missionActionId = await this.startMissionCycle(userMessage);
      emitEvent({ kind: 'status', message: 'Spawning and coordinating Swarm Intelligence workers' });
      
      const runDirectory = this.artifacts.getRunDirectory();
      const coordinator = new SwarmCoordinator({
        allTools: this.tools,
        auditMode: this.config.auditMode ?? this.runtime.capabilities.preferredAuditMode,
        config: this.config,
        diffScopeHint: this.diffScopeHint,
        model: this.model,
        runId: path.basename(runDirectory),
        storagePath: runDirectory,
      });

      const swarmResultText = await coordinator.executeMission(userMessage, (role, act) => {
        emitEvent({
          kind: act.kind as 'tool_call' | 'tool_result',
          message: `[${role.toUpperCase()}] ${act.message}`,
          toolName: act.toolName,
        });
      });

      emitEvent({ kind: 'status', message: 'Validating and writing report artifacts' });
      await this.artifacts.writeReportMarkdown(swarmResultText);

      let validatedReport: SecurityReport = { findings: [] };
      try {
        const validation = await validateAndRepairReport({
          maxRetries: this.config.reportValidation?.maxRepairRetries ?? 2,
          repair: async ({ attempt, lastCandidate, validationError }) => {
            const prompt = `Original response:
${swarmResultText}

Last invalid candidate:
${lastCandidate ?? '<none>'}

Validation error:
${validationError}

Repair attempt:
${attempt}

Return corrected JSON now.`;

            const repaired = await generateText({
              maxOutputTokens: Math.min(this.runtime.maxOutputTokens, 4096),
              model: this.model,
              prompt,
              system: REPORT_REPAIR_SYSTEM_PROMPT,
              temperature: 0,
            });

            return repaired.text;
          },
          responseText: swarmResultText,
        });

        validatedReport = validation.report;

        // Apply finding deduplication before writing artifacts
        const dedupedReport: SecurityReport = {
          findings: deduplicateFindings(validation.report.findings),
        };

        await this.artifacts.writeReportJson(dedupedReport);
        if (dedupedReport.findings.length > 0) {
          await this.artifacts.writeReportSarif(generateSarifReport(dedupedReport));
        }

        // CI mode: emit summary and trigger exit if threshold is met
        if (this.config.ci?.enabled) {
          const failOn = (this.config.ci.failOn ?? 'high') as FailOnSeverity;
          const ciResult = computeCiExitCode({ failOn, findings: dedupedReport.findings });
          const summary = formatCiSummary(ciResult, failOn);
          emitEvent({ kind: 'status', message: summary });
          if (ciResult.code !== 0) {
            process.exitCode = ciResult.code;
          }
        }

        validatedReport = dedupedReport;
      } catch (error) {
        const fallbackReport = { findings: [] as [] };
        await this.artifacts.writeReportJson(fallbackReport);
        this.runtimeWarnings.push(`Report validation fallback applied: ${(error as Error).message}`);
      }

      await this.completeMissionCycle(missionActionId, validatedReport, swarmResultText.length);

      await this.artifacts.updateMeta({
        warnings: [...this.runtimeWarnings],
      });
      emitEvent({ kind: 'status', message: 'Analysis complete' });

      return swarmResultText;
    }

    emitEvent({ kind: 'status', message: 'Planning analysis mission' });
    const missionActionId = await this.startMissionCycle(userMessage);
    emitEvent({ kind: 'status', message: 'Streaming model output and tool activity' });

    const streamResult = await streamWithContinuation({
      maxContinuations: this.config.continuation?.maxContinuations ?? 2,
      maxOutputTokens: this.runtime.maxOutputTokens,
      maxToolSteps: this.runtime.maxToolSteps,
      messages: this.messages,
      model: this.model,
      onActivity(activity) {
        emitEvent({
          kind: activity.kind,
          message: activity.summary,
          toolCallId: activity.toolCallId,
          toolName: activity.toolName,
        });
      },
      onChunk,
      systemPrompt: this.systemPrompt,
      tools: this.tools as ToolSet,
    });

    this.messages.push(...streamResult.messagesDelta);
    await this.persistMessages(streamResult.messagesDelta);
    await this.persistToolEvents(streamResult.steps);
    emitEvent({ kind: 'status', message: 'Validating and writing report artifacts' });

    await this.artifacts.writeReportMarkdown(streamResult.text);

    let validatedReport: SecurityReport = { findings: [] };
    try {
      const validation = await validateAndRepairReport({
        maxRetries: this.config.reportValidation?.maxRepairRetries ?? 2,
        repair: async ({ attempt, lastCandidate, validationError }) => {
          const prompt = `Original response:
${streamResult.text}

Last invalid candidate:
${lastCandidate ?? '<none>'}

Validation error:
${validationError}

Repair attempt:
${attempt}

Return corrected JSON now.`;

          const repaired = await generateText({
            maxOutputTokens: Math.min(this.runtime.maxOutputTokens, 4096),
            model: this.model,
            prompt,
            system: REPORT_REPAIR_SYSTEM_PROMPT,
            temperature: 0,
          });

          return repaired.text;
        },
        responseText: streamResult.text,
      });

      validatedReport = validation.report;

      // Apply finding deduplication before writing artifacts
      const dedupedReport: SecurityReport = {
        findings: deduplicateFindings(validation.report.findings),
      };

      await this.artifacts.writeReportJson(dedupedReport);
      if (dedupedReport.findings.length > 0) {
        await this.artifacts.writeReportSarif(generateSarifReport(dedupedReport));
      }

      // CI mode: emit summary and trigger exit if threshold is met
      if (this.config.ci?.enabled) {
        const failOn = (this.config.ci.failOn ?? 'high') as FailOnSeverity;
        const ciResult = computeCiExitCode({ failOn, findings: dedupedReport.findings });
        const summary = formatCiSummary(ciResult, failOn);
        emitEvent({ kind: 'status', message: summary });
        if (ciResult.code !== 0) {
          process.exitCode = ciResult.code;
        }
      }

      validatedReport = dedupedReport;
    } catch (error) {
      const fallbackReport = { findings: [] as [] };
      await this.artifacts.writeReportJson(fallbackReport);
      this.runtimeWarnings.push(`Report validation fallback applied: ${(error as Error).message}`);
    }

    await this.completeMissionCycle(missionActionId, validatedReport, streamResult.text.length);

    await this.artifacts.updateMeta({
      warnings: [...this.runtimeWarnings],
    });
    emitEvent({ kind: 'status', message: 'Analysis complete' });

    return streamResult.text;
  }

  private async completeMissionCycle(
    actionId: null | string,
    report: SecurityReport,
    tokensUsed: number,
  ): Promise<void> {
    if (!this.missionEngine) {
      return;
    }

    await this.transitionMission('VERIFY', 'action_executed', {
      completedActionId: actionId ?? undefined,
      tokensUsed,
    });

    await this.ingestReportFindings(report);

    await this.transitionMission(
      'REPORT',
      report.findings.length > 0 ? 'verification_passed' : 'verification_failed',
      {},
    );
    await this.missionEngine.saveCheckpoint();
    await this.missionEngine.getGraph().saveSnapshot();
    await this.transitionMission('OBSERVE', 'evidence_collected', {});
  }

  private createEmbeddingProvider(): EmbeddingProvider {
    const providerType = this.config.indexing?.embeddingProvider ?? 'ollama';
    const model = this.config.indexing?.embeddingModel;

    switch (providerType) {
      case 'openai': {
        if (!this.config.apiKey) {
          console.warn('[SemanticIndex] OpenAI embeddings require an API key. Falling back to null provider.');
          return new NullEmbeddingProvider();
        }

        return new OpenAIEmbeddingProvider({
          apiKey: this.config.apiKey,
          model: model ?? 'text-embedding-3-small',
        });
      }

      case 'ollama':
      default: {
        return new OllamaEmbeddingProvider({
          model: model ?? 'nomic-embed-text',
        });
      }
    }
  }

  private async ingestReportFindings(report: SecurityReport): Promise<void> {
    if (!this.missionEngine || report.findings.length === 0) {
      return;
    }

    const graph = this.missionEngine.getGraph();
    const now = new Date().toISOString();

    for (const finding of report.findings) {
      const vulnerabilityId = vulnerabilityCanonicalId(
        finding.cwe,
        undefined,
        undefined,
        finding.title,
      );

      graph.addEntity({
        canonicalId: vulnerabilityId,
        confidence: Math.min(1, finding.cvss_v31_score / 10),
        createdAt: now,
        entityType: 'vulnerability',
        label: finding.title,
        properties: {
          cvssV31Score: finding.cvss_v31_score,
          cvssV31Vector: finding.cvss_v31_vector,
          cwe: finding.cwe,
          title: finding.title,
          verified: true,
        },
        updatedAt: now,
      });

      this.missionEngine.addHypothesis({
        confidence: Math.min(1, Math.max(0.3, finding.cvss_v31_score / 10)),
        description: `${finding.title} (${finding.cwe})`,
        evidenceIds: [],
        status: 'verified',
        type: 'finding',
      });
    }
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
    });

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
      const provider = this.createEmbeddingProvider();

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

      // Index the repository
      const { chunksIndexed, filesIndexed } = await this.semanticIndex.indexRepository(
        (progress) => {
          if (progress.filesIndexed % 50 === 0 || progress.filesIndexed === progress.totalFiles) {
            console.log(
              `[SemanticIndex] Indexed ${progress.filesIndexed}/${progress.totalFiles} files (${progress.currentFile})`,
            );
          }
        },
      );

      console.log(
        `[SemanticIndex] Indexing complete: ${filesIndexed} files, ${chunksIndexed} chunks`,
      );

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
    } catch (error) {
      this.runtimeWarnings.push(
        `Semantic indexing failed (falling back to repo-map only): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.semanticIndex = null;
      return {};
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
