import { z } from 'zod';

export type MCPRiskLevel = 'high' | 'low' | 'medium';

export interface MCPExecutionContext {
  expertUnsafe: boolean;
  targetPath: string;
}

export interface MCPToolDefinition<TOutput = unknown> {
  description: string;
  execute: (input: Record<string, unknown>, context: MCPExecutionContext) => Promise<TOutput>;
  inputSchema: z.ZodTypeAny;
  name: string;
  requiresConfirmation: boolean;
  riskLevel: MCPRiskLevel;
}

export interface MCPAdapter {
  capabilities: string[];
  displayName: string;
  id: string;
  initialize?: () => Promise<void>;
  isAvailable?: () => boolean;
  listTools: () => MCPToolDefinition[];
  shutdown?: () => Promise<void>;
}

export type MCPRawInvoker = (operation: string, input: Record<string, unknown>) => Promise<unknown>;
