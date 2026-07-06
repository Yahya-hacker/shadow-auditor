import { DynamicStructuredTool } from '@langchain/core/tools';
import { type ToolSet } from 'ai';
import { z } from 'zod';

type AITool = ToolSet[string];

function resolveSchema(tool: AITool) {
  const candidate =
    (tool as { inputSchema?: z.ZodTypeAny; parameters?: z.ZodTypeAny }).inputSchema ??
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

function normalizeToolName(name: string, providerHint?: string): string {
  // Anthropic enforces a 64-character limit on tool names.
  if (providerHint === 'anthropic' && name.length > 64) {
    return name.slice(0, 64);
  }

  return name;
}

function normalizeSchema(schema: z.ZodTypeAny, providerHint?: string): z.ZodTypeAny {
  if (providerHint === 'anthropic') {
    // Anthropic rejects fully empty parameter objects. Ensure at least a
    // passthrough shape is present so the tool can be called without arguments.
    return schema ?? z.object({}).passthrough();
  }

  return schema;
}

export interface WrapToolOptions {
  /** Optional provider hint used to apply schema/name quirks. */
  providerHint?: string;
}

export function wrapTool(aiTool: AITool, name: string, options: WrapToolOptions = {}): DynamicStructuredTool {
  const description = resolveDescription(aiTool);
  const schema = normalizeSchema(resolveSchema(aiTool), options.providerHint);

  return new DynamicStructuredTool({
    description,
    async func(input: unknown) {
      const result = await aiTool.execute?.(input as never, {} as never);
      const raw = typeof result === 'string' ? result : JSON.stringify(result);

      // Post-process large tool results to prevent context overflow.
      // Tools like read_file and search_codebase can return massive outputs
      // that waste tokens and distract the model. We truncate with a summary
      // and add continuation hints for pagination.
      const MAX_TOOL_RESULT_CHARS = 8000;
      if (raw.length > MAX_TOOL_RESULT_CHARS) {
        const truncated = raw.slice(0, MAX_TOOL_RESULT_CHARS);
        const omitted = raw.length - MAX_TOOL_RESULT_CHARS;
        const lineCount = raw.split('\n').length;
        const truncatedLines = truncated.split('\n').length;

        return [
          truncated,
          '',
          `── ✂️ TRUNCATED (${omitted} chars, ~${lineCount - truncatedLines} lines omitted) ──`,
          `Full result: ${raw.length} chars, ${lineCount} lines total.`,
          `💡 TIP: Use more specific queries or file path filters to narrow results.`,
          `    For search_codebase: add fileExtension filter or more precise regex.`,
          `    For read_file: use context_retrieval to find relevant sections instead.`,
        ].join('\n');
      }

      return raw;
    },
    name: normalizeToolName(name, options.providerHint),
    schema,
  });
}
