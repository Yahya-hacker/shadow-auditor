import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { DynamicStructuredTool } from '@langchain/core/tools';

import {convertToOpenAITool} from '@langchain/core/utils/function_calling';

type JsonObject = Record<string, unknown>;

const GOOGLE_UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$anchor',
  '$comment',
  '$defs',
  '$id',
  '$schema',
  'definitions',
  'exclusiveMaximum',
  'exclusiveMinimum',
]);

function resolveJsonPointer(root: unknown, reference: string): unknown {
  if (!reference.startsWith('#/')) {
    throw new Error(`Gemini tool schemas cannot use external reference "${reference}".`);
  }

  let current = root;
  for (const rawSegment of reference.slice(2).split('/')) {
    const segment = rawSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (
      !current ||
      typeof current !== 'object' ||
      Array.isArray(current) ||
      !Object.hasOwn(current, segment)
    ) {
      throw new Error(`Gemini tool schema contains an unresolved reference "${reference}".`);
    }

    current = (current as JsonObject)[segment];
  }

  return current;
}

function sanitizeGoogleSchemaValue(
  value: unknown,
  root: unknown,
  references: ReadonlySet<string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeGoogleSchemaValue(item, root, references));
  }

  if (!value || typeof value !== 'object') return value;

  const source = value as JsonObject;
  if (typeof source.$ref === 'string') {
    if (references.has(source.$ref)) {
      throw new Error(`Gemini tool schema contains a recursive reference "${source.$ref}".`);
    }

    const target = resolveJsonPointer(root, source.$ref);
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      throw new Error(`Gemini tool schema reference "${source.$ref}" does not resolve to an object.`);
    }

    const nextReferences = new Set(references).add(source.$ref);
    const siblings = Object.fromEntries(
      Object.entries(source).filter(([key]) => key !== '$ref'),
    );
    return sanitizeGoogleSchemaValue(
      {...target as JsonObject, ...siblings},
      root,
      nextReferences,
    );
  }

  const sanitized: JsonObject = {};
  for (const [key, child] of Object.entries(source)) {
    if (GOOGLE_UNSUPPORTED_SCHEMA_KEYS.has(key) || key === '$ref') continue;

    sanitized[key] = sanitizeGoogleSchemaValue(child, root, references);
  }

  // Gemini accepts inclusive OpenAPI bounds, not JSON Schema's numeric
  // exclusive bounds. Preserve the closest model-side hint; the executable
  // Zod schema remains authoritative and rejects the excluded boundary.
  if (typeof source.exclusiveMinimum === 'number' && sanitized.minimum === undefined) {
    sanitized.minimum = source.exclusiveMinimum;
  }

  if (typeof source.exclusiveMaximum === 'number' && sanitized.maximum === undefined) {
    sanitized.maximum = source.exclusiveMaximum;
  }

  return sanitized;
}

function googleToolDefinition(tool: DynamicStructuredTool): ReturnType<typeof convertToOpenAITool> {
  const definition = convertToOpenAITool(tool);
  return {
    ...definition,
    function: {
      ...definition.function,
      parameters: sanitizeGoogleToolSchema(definition.function.parameters) as JsonObject,
    },
  };
}

/**
 * Bind executable tools using the provider's accepted declaration dialect.
 * Execution still uses the original DynamicStructuredTool instances, so local
 * Zod validation remains stricter than any provider-side schema subset.
 */
export function bindToolsForProvider(
  model: BaseChatModel,
  tools: DynamicStructuredTool[],
  providerHint?: string,
) {
  if (!model.bindTools) {
    throw new Error('The configured model does not support the required tool contract.');
  }

  const provider = providerHint?.trim().toLowerCase();
  return model.bindTools(
    provider === 'google'
      ? tools.map((tool) => googleToolDefinition(tool))
      : tools,
  );
}

export function sanitizeGoogleToolSchema(schema: unknown): unknown {
  return sanitizeGoogleSchemaValue(schema, schema, new Set());
}
