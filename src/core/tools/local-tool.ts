import { z } from 'zod';

import type { JsonObject, JsonValue, ToolDescriptor } from '../../protocol/generated.js';

import { sha256Digest } from '../../protocol/canonical-json.js';

export interface LocalTool {
  descriptor: ToolDescriptor;
  execute(input: JsonObject): Promise<JsonValue>;
  parse(input: JsonObject): JsonObject;
}

export type LocalToolRisk = 'execute' | 'network' | 'privileged' | 'read' | 'write';

export interface ToolDefinition<TSchema extends z.ZodTypeAny> {
  description: string;
  execute(input: z.infer<TSchema>): Promise<unknown>;
  inputSchema: TSchema;
}

export type LocalToolSet = Record<string, ToolDefinition<z.ZodTypeAny>>;

export function localTool<TSchema extends z.ZodTypeAny>(
  definition: ToolDefinition<TSchema>,
): ToolDefinition<TSchema> {
  return definition;
}

export function toJsonValue(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON numbers must be finite');
    return value;
  }

  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported non-JSON value: ${typeof value}`);
  }

  if (seen.has(value)) throw new TypeError('Circular values are not JSON-serializable');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Class instances are not JSON-serializable protocol values');
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => toJsonValue(item, seen));
    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) result[key] = toJsonValue(child, seen);
    return result;
  } finally {
    seen.delete(value);
  }
}

export function defineLocalTool<TSchema extends z.ZodTypeAny>(options: {
  inputJsonSchema: JsonObject;
  maxResultBytes?: number;
  name: string;
  risk: LocalToolRisk;
  tool: ToolDefinition<TSchema>;
}): LocalTool {
  return {
    descriptor: {
      description: options.tool.description,
      inputSchemaDigest: sha256Digest(options.inputJsonSchema),
      maxResultBytes: options.maxResultBytes ?? 256 * 1024,
      name: options.name,
      risk: options.risk,
    },
    async execute(input) {
      const parsed = options.tool.inputSchema.parse(input) as z.infer<TSchema>;
      return toJsonValue(await options.tool.execute(parsed));
    },
    parse(input) {
      return toJsonValue(options.tool.inputSchema.parse(input)) as JsonObject;
    },
  };
}

export function jsonObjectSchema(properties: JsonObject, required: string[] = []): JsonObject {
  return {
    additionalProperties: false,
    properties,
    required,
    type: 'object',
  };
}
