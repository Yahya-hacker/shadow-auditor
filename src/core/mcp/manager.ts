import { tool, type ToolSet } from 'ai';

import type { HumanInteractionService } from '../../utils/human-in-loop.js';
import type { MCPAdapter, MCPExecutionContext, MCPToolDefinition } from './types.js';

import { evaluateMcpPolicy } from '../policy/mcp-policy.js';

export interface MCPManagerOptions {
  expertUnsafe: boolean;
  humanInteraction: HumanInteractionService;
  targetPath: string;
}

export interface MCPDiscoveredCapability {
  adapterId: string;
  available: boolean;
  capabilities: string[];
  displayName: string;
  tools: string[];
}

function createAgentToolName(adapterId: string, toolName: string): string {
  return `mcp_${adapterId}_${toolName}`.replaceAll(/[^a-zA-Z0-9_]/g, '_');
}

function formatMcpOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }

  return JSON.stringify(output, null, 2);
}

export class MCPManager {
  private readonly adapters = new Map<string, MCPAdapter>();

  constructor(private readonly options: MCPManagerOptions) {}

  buildAgentTools(): ToolSet {
    const tools: ToolSet = {};

    for (const adapter of this.adapters.values()) {
      if (adapter.isAvailable && !adapter.isAvailable()) {
        continue;
      }

      const executionContext: MCPExecutionContext = {
        expertUnsafe: this.options.expertUnsafe,
        targetPath: this.options.targetPath,
      };

      for (const definition of adapter.listTools()) {
        const toolName = createAgentToolName(adapter.id, definition.name);
        tools[toolName] = this.wrapTool(adapter.id, definition, executionContext);
      }
    }

    return tools;
  }

  discoverCapabilities(): MCPDiscoveredCapability[] {
    return [...this.adapters.values()].map((adapter) => ({
      adapterId: adapter.id,
      available: adapter.isAvailable ? adapter.isAvailable() : true,
      capabilities: adapter.capabilities,
      displayName: adapter.displayName,
      tools: adapter.listTools().map((toolDefinition) => toolDefinition.name),
    }));
  }

  async initialize(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      if (adapter.initialize) {
        await adapter.initialize();
      }
    }
  }

  registerAdapter(adapter: MCPAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  async shutdown(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      if (adapter.shutdown) {
        await adapter.shutdown();
      }
    }
  }

  private wrapTool(
    adapterId: string,
    definition: MCPToolDefinition,
    context: MCPExecutionContext,
  ): ToolSet[string] {
    const humanInteraction = this.options.humanInteraction;

    return tool({
      description: `[MCP:${adapterId}] ${definition.description}`,
      async execute(input: Record<string, unknown>, executionOptions) {
        const invocationContext = {
          ...context,
          signal: executionOptions.abortSignal,
        };
        const policyDecision = evaluateMcpPolicy(adapterId, definition, context.expertUnsafe);
        if (!policyDecision.allowed) {
          return policyDecision.reason;
        }

        const {warning} = policyDecision;
        if (definition.requiresConfirmation || policyDecision.requiresConfirmation || warning) {
          const confirmed = await humanInteraction.confirmMcpToolExecution(
            adapterId,
            definition.name,
            input,
            warning,
          );

          if (!confirmed) {
            return `[DENIED] User denied MCP tool execution for ${adapterId}.${definition.name}.`;
          }
        }

        const output = await definition.execute(input, invocationContext);
        return formatMcpOutput(output);
      },
      inputSchema: definition.inputSchema,
    });
  }
}
