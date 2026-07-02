import { DynamicStructuredTool } from '@langchain/core/tools';
import { type ToolSet } from 'ai';
import { z } from 'zod';

type AITool = ToolSet[string];

function resolveSchema(tool: AITool) {
  const candidate = (tool as { inputSchema?: z.ZodTypeAny; parameters?: z.ZodTypeAny }).inputSchema ??
    (tool as { inputSchema?: z.ZodTypeAny; parameters?: z.ZodTypeAny }).parameters;

  return candidate ?? z.object({}).passthrough();
}

function resolveDescription(tool: AITool): string {
  const rawDescription = tool.description;
  if (typeof rawDescription === 'string') {
    return rawDescription;
  }

  return 'Wrapped AI SDK tool.';
}

export function wrapTool(aiTool: AITool, name: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    description: resolveDescription(aiTool),
    async func(input: unknown) {
      const result = await aiTool.execute?.(input as never, {} as never);
      if (typeof result === 'string') {
        return result;
      }

      return JSON.stringify(result);
    },
    name,
    schema: resolveSchema(aiTool),
  });
}
