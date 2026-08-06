import { DynamicStructuredTool } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { type ToolSet } from 'ai';
import { createHash } from 'node:crypto';
import { z } from 'zod';

type AITool = ToolSet[string];
const MAX_TOOL_RESULT_CHARS = 8000;

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
    const suffix = createHash('sha256').update(name).digest('hex').slice(0, 8);
    return `${name.slice(0, 55)}_${suffix}`;
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

function resolveToolCallId(config: unknown, fallback: string): string {
  if (config && typeof config === 'object' && 'toolCall' in config) {
    const toolCall = config.toolCall;
    if (toolCall && typeof toolCall === 'object' && 'id' in toolCall && typeof toolCall.id === 'string') {
      return toolCall.id;
    }
  }

  return fallback;
}

export interface WrapToolOptions {
  /** Optional provider hint used to apply schema/name quirks. */
  providerHint?: string;
}

export function wrapTool(aiTool: AITool, name: string, options: WrapToolOptions = {}): DynamicStructuredTool {
  if (typeof aiTool.execute !== 'function') {
    throw new TypeError(`Tool "${name}" does not provide an executable implementation.`);
  }

  const execute = aiTool.execute;

  const description = resolveDescription(aiTool);
  const schema = normalizeSchema(resolveSchema(aiTool), options.providerHint);

  return new DynamicStructuredTool({
    description,
    async func(input: unknown, _runManager, config) {
      let result: unknown;
      try {
        result = await execute(input as never, {
          abortSignal: config?.signal,
          messages: [],
          toolCallId: resolveToolCallId(config, name),
        } as never);
      } catch (error) {
        if (error instanceof Command) return error;
        throw error;
      }

      if (result instanceof Command) return result;
      let raw: string;
      if (typeof result === 'string') {
        raw = result;
      } else if (result === undefined) {
        throw new TypeError(`Tool "${name}" returned undefined.`);
      } else {
        try {
          raw = JSON.stringify(result);
        } catch (error) {
          throw new TypeError(
            `Tool "${name}" returned a non-serializable result: ${
              error instanceof Error ? error.message : String(error)
            }`,
            {cause: error},
          );
        }
      }

      // Post-process large tool results to prevent context overflow.
      // Tools like read_file and search_codebase can return massive outputs
      // that waste tokens and distract the model. We truncate with a summary
      // and add continuation hints for pagination.
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
