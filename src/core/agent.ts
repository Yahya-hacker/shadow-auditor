import { generateText, type LanguageModel, type ModelMessage, type StepResult, type ToolSet } from 'ai';
import * as path from 'node:path';

import type { ShadowConfig } from '../utils/config.js';
import type { MCPRawInvoker } from './mcp/types.js';

import { createChromeDevtoolsAdapter } from './mcp/adapters/chrome-devtools.js';
import { createKaliLinuxAdapter } from './mcp/adapters/kali-linux.js';
import { MCPManager } from './mcp/manager.js';
import { resolveRuntimeSettings, type RuntimeSettings } from './model-capabilities.js';
import { getModel } from './model-router.js';
import { validateAndRepairReport } from './output/report-validator.js';
import { generateSarifReport } from './output/sarif.js';
import { createPathGuard } from './policy/path-guard.js';
import { RunArtifacts } from './run-artifacts.js';
import { streamWithContinuation } from './session.js';
import { buildSystemPrompt } from './system-prompt.js';
import { createEditFileTool } from './tools/edit-file.js';
import { createExecuteCommandTool } from './tools/execute-command.js';
import { createListDirectoryTool } from './tools/list-directory.js';
import { createReadFileTool } from './tools/read-file.js';
import { createSearchCodebaseTool } from './tools/search-codebase.js';

export interface AgentSessionOptions {
  expertUnsafe?: boolean;
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
  private expertUnsafe: boolean;
  private initialized: Promise<void>;
  private mcpManager: MCPManager | null = null;
  private messages: ModelMessage[] = [];
  private model: LanguageModel;
  private runtime: RuntimeSettings;
  private runtimeWarnings: string[] = [];
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
    this.runtime = resolveRuntimeSettings(config, (warning) => {
      this.runtimeWarnings.push(warning);
      console.warn(warning);
    });

    const resolvedTargetPath = path.resolve(targetPath);
    this.messages = [
      {
        content: `## REPOSITORY ARCHITECTURE MAP

The following is a compressed architectural map of the target codebase at \`${resolvedTargetPath}\`.
It contains structural signatures (imports, declarations, type surfaces), not implementation bodies.

\`\`\`
${repoMap}
\`\`\`

Use your tools to inspect implementation details, verify assumptions, and produce precise security findings.`,
        role: 'user',
      },
      {
        content: `Repository map ingested. Ready for autonomous security analysis with controlled tooling and machine-readable reporting.`,
        role: 'assistant',
      },
    ];

    this.initialized = this.initialize();
  }

  async sendMessage(userMessage: string, onChunk: (text: string) => void): Promise<string> {
    await this.initialized;
    if (!this.artifacts) {
      throw new Error('Run artifacts are not initialized.');
    }

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

    const streamResult = await streamWithContinuation({
      maxContinuations: this.config.continuation?.maxContinuations ?? 2,
      maxOutputTokens: this.runtime.maxOutputTokens,
      maxToolSteps: this.runtime.maxToolSteps,
      messages: this.messages,
      model: this.model,
      onChunk,
      systemPrompt: this.systemPrompt,
      tools: this.tools as ToolSet,
    });

    this.messages.push(...streamResult.messagesDelta);
    await this.persistMessages(streamResult.messagesDelta);
    await this.persistToolEvents(streamResult.steps);

    await this.artifacts.writeReportMarkdown(streamResult.text);

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

      await this.artifacts.writeReportJson(validation.report);
      if (validation.report.findings.length > 0) {
        await this.artifacts.writeReportSarif(generateSarifReport(validation.report));
      }
    } catch (error) {
      const fallbackReport = { findings: [] as [] };
      await this.artifacts.writeReportJson(fallbackReport);
      this.runtimeWarnings.push(`Report validation fallback applied: ${(error as Error).message}`);
    }

    await this.artifacts.updateMeta({
      warnings: [...this.runtimeWarnings],
    });

    return streamResult.text;
  }

  private async initialize(): Promise<void> {
    const pathGuard = await createPathGuard(this.targetPath);
    const resolvedTargetPath = pathGuard.rootRealPath;

    const mcpEnabled = this.isMcpEnabled();
    const mcpTools = await this.initializeMcpTools(resolvedTargetPath, mcpEnabled);

    this.tools = {
      edit_file: createEditFileTool(pathGuard),
      execute_command: createExecuteCommandTool({
        commandPolicy: {
          additionalAllowedCommandPatterns: this.config.commandPolicy?.additionalAllowedCommandPatterns,
          additionalDeniedPatterns: this.config.commandPolicy?.additionalDeniedPatterns,
          allowPnpmYarn: this.config.commandPolicy?.allowPnpmYarn ?? true,
          expertUnsafe: this.expertUnsafe,
        },
        workingDirectory: resolvedTargetPath,
      }),
      list_directory: createListDirectoryTool(pathGuard),
      read_file_content: createReadFileTool(pathGuard),
      search_codebase: createSearchCodebaseTool(pathGuard),
      ...mcpTools,
    };

    this.systemPrompt = buildSystemPrompt({
      auditMode: this.config.auditMode ?? this.runtime.capabilities.preferredAuditMode,
      mcpEnabled: Object.keys(mcpTools).length > 0,
    });

    this.artifacts = await RunArtifacts.create(resolvedTargetPath, {
      maxOutputTokens: this.runtime.maxOutputTokens,
      maxToolSteps: this.runtime.maxToolSteps,
      mcpEnabled: Object.keys(mcpTools).length > 0,
      model: this.config.model,
      provider: this.config.provider,
      targetPath: resolvedTargetPath,
      warnings: [...this.runtimeWarnings],
    });

    await this.artifacts.recordMessage({
      content: {
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
}
