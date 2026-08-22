import type { BaseMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';

import { AIMessage } from '@langchain/core/messages';
import {randomUUID} from 'node:crypto';

const DSML_MARKER = '｜｜DSML｜｜';
const DSML_MARKER_VARIANT_PATTERN = /(?:｜｜DSML｜｜|｜DSML｜)/gu;
const DSML_MARKER_VARIANT_TEST = /(?:｜｜DSML｜｜|｜DSML｜)/u;
const MAX_DSML_CONTENT_LENGTH = 1_048_576;
const DSML_TOOL_BLOCK_PATTERN =
  /<｜｜DSML｜｜tool_calls>([\s\S]*?)<\/｜｜DSML｜｜tool_calls>/gu;
const DSML_INVOKE_PATTERN =
  /<｜｜DSML｜｜invoke\b([^>]*)>([\s\S]*?)<\/｜｜DSML｜｜invoke>/gu;
const DSML_PARAMETER_PATTERN =
  /<｜｜DSML｜｜parameter\b([^>]*)>([\s\S]*?)<\/｜｜DSML｜｜parameter>/gu;
const ATTRIBUTE_PATTERN = /([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
const TOOL_NAME_PATTERN = /^[A-Za-z_][\w.-]*$/u;

interface NormalizeProviderToolCallsOptions {
  allowTextEncodedToolCalls?: boolean;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalizeJson(entry));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeJson(entry)]),
  );
}

export function toolCallSignature(call: Pick<ToolCall, 'args' | 'name'>): string {
  return `${call.name}\0${JSON.stringify(canonicalizeJson(call.args))}`;
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function parseAttributes(
  source: string,
  allowedNames: ReadonlySet<string>,
): Record<string, string> {
  const attributes: Record<string, string> = {};
  let consumed = '';
  for (const match of source.matchAll(ATTRIBUTE_PATTERN)) {
    consumed += match[0];
    const name = match[1]!;
    if (!allowedNames.has(name)) {
      throw new Error(`DeepSeek DSML contains unsupported attribute "${name}".`);
    }

    if (Object.hasOwn(attributes, name)) {
      throw new Error(`DeepSeek DSML contains duplicate attribute "${name}".`);
    }

    attributes[name] = decodeEntities(match[2] ?? match[3] ?? '');
  }

  const residue = source
    .replaceAll(ATTRIBUTE_PATTERN, '')
    .trim();
  if (residue || !consumed) {
    throw new Error(`Malformed DeepSeek DSML attributes: ${source.trim() || '(empty)'}.`);
  }

  return attributes;
}

function parseParameterValue(rawValue: string, stringEncoded: boolean): unknown {
  const value = decodeEntities(rawValue.trim());
  if (stringEncoded) return value;

  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(
      `DeepSeek DSML emitted a non-string tool parameter that is not valid JSON: ${value.slice(0, 160)}.`,
    );
  }
}

function generatedToolCallId(index: number, prefix = 'call'): string {
  return `${prefix}_${index}_${randomUUID()}`;
}

function parseInvoke(block: string, attributesSource: string, body: string, index: number): ToolCall {
  const attributes = parseAttributes(attributesSource, new Set(['name']));
  const name = attributes.name?.trim();
  if (!name || !TOOL_NAME_PATTERN.test(name)) {
    throw new Error('DeepSeek DSML emitted a tool invocation without a valid name.');
  }

  const args: Record<string, unknown> = {};
  let parameterCount = 0;
  const bodyWithoutParameters = body.replaceAll(
    DSML_PARAMETER_PATTERN,
    (_match, parameterAttributesSource: string, rawValue: string) => {
      parameterCount++;
      const parameterAttributes = parseAttributes(
        parameterAttributesSource,
        new Set(['name', 'string']),
      );
      const parameterName = parameterAttributes.name?.trim();
      if (!parameterName || !TOOL_NAME_PATTERN.test(parameterName)) {
        throw new Error(`DeepSeek DSML tool "${name}" emitted a parameter without a valid name.`);
      }

      if (Object.hasOwn(args, parameterName)) {
        throw new Error(
          `DeepSeek DSML tool "${name}" emitted duplicate parameter "${parameterName}".`,
        );
      }

      const stringEncoded = parameterAttributes.string === 'true';
      if (
        parameterAttributes.string !== undefined &&
        parameterAttributes.string !== 'true' &&
        parameterAttributes.string !== 'false'
      ) {
        throw new Error(
          `DeepSeek DSML tool "${name}" emitted invalid string metadata for "${parameterName}".`,
        );
      }

      args[parameterName] = parseParameterValue(rawValue, stringEncoded);
      return '';
    },
  );
  if (bodyWithoutParameters.trim()) {
    throw new Error(`DeepSeek DSML tool "${name}" contains unsupported invocation content.`);
  }

  if (body.includes(`<${DSML_MARKER}parameter`) && parameterCount === 0) {
    throw new Error(`DeepSeek DSML tool "${name}" contains malformed parameters.`);
  }

  const call = {
    args,
    name,
    type: 'tool_call',
  } satisfies Omit<ToolCall, 'id'>;
  return {...call, id: generatedToolCallId(index, 'dsml')};
}

function normalizeStructuredToolCalls(message: AIMessage, providerHint?: string): AIMessage {
  const provider = providerHint?.trim().toLowerCase();
  let changed = false;
  const toolCalls = message.tool_calls?.map((call, index) => {
    let args: unknown = call.args;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args) as unknown;
      } catch (error) {
        throw new TypeError(
          `${provider || 'Provider'} tool "${call.name}" emitted invalid JSON arguments.`,
          {cause: error},
        );
      }

      changed = true;
    }

    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new TypeError(
        `${provider || 'Provider'} tool "${call.name}" arguments must be a JSON object.`,
      );
    }

    const normalized = {...call, args: {...args as Record<string, unknown>}};
    if (!normalized.id?.trim()) {
      normalized.id = generatedToolCallId(index);
      changed = true;
    }

    return normalized;
  });
  if (!changed) return message;

  return new AIMessage({
    additional_kwargs: message.additional_kwargs,
    content: message.content,
    id: message.id,
    invalid_tool_calls: message.invalid_tool_calls,
    name: message.name,
    response_metadata: message.response_metadata,
    tool_calls: toolCalls,
    usage_metadata: message.usage_metadata,
  });
}

function parseDsmlToolCalls(content: string): {content: string; toolCalls: ToolCall[]} {
  const canonicalContent = content.replaceAll(DSML_MARKER_VARIANT_PATTERN, DSML_MARKER);
  const toolCalls: ToolCall[] = [];
  let blockIndex = 0;
  const remainingContent = canonicalContent.replaceAll(
    DSML_TOOL_BLOCK_PATTERN,
    (block, body: string) => {
      const callsBeforeBlock = toolCalls.length;
      const bodyWithoutInvocations = body.replaceAll(
        DSML_INVOKE_PATTERN,
        (invokeBlock, attributesSource: string, invokeBody: string) => {
          toolCalls.push(parseInvoke(invokeBlock, attributesSource, invokeBody, blockIndex++));
          return '';
        },
      );
      if (bodyWithoutInvocations.trim()) {
        throw new Error('DeepSeek DSML tool-call block contains unsupported content.');
      }

      if (toolCalls.length === callsBeforeBlock) {
        throw new Error('DeepSeek emitted an empty DSML tool-call block.');
      }

      return '';
    },
  );

  if (remainingContent.includes(DSML_MARKER)) {
    throw new Error('DeepSeek emitted malformed or unsupported DSML tool-call syntax.');
  }

  if (toolCalls.length === 0) {
    throw new Error('DeepSeek emitted an empty DSML tool-call block.');
  }

  return {content: remainingContent.trim(), toolCalls};
}

/**
 * Converts DeepSeek's text-encoded DSML fallback into LangChain's canonical
 * tool-call contract before graph routing. The adapter is deliberately strict:
 * malformed protocol output is never rendered as a handoff or executed.
 */
export function normalizeProviderToolCalls(
  message: BaseMessage,
  providerHint?: string,
  options: NormalizeProviderToolCallsOptions = {},
): BaseMessage {
  // Check the semantic message role rather than class identity. Checkpoint
  // restoration and some provider adapters can return AI-message-compatible
  // objects from a different module instance.
  if (message._getType() !== 'ai') {
    return message;
  }

  const normalizedMessage = normalizeStructuredToolCalls(message as AIMessage, providerHint);
  if (providerHint?.trim().toLowerCase() !== 'deepseek') return normalizedMessage;

  const content = typeof normalizedMessage.content === 'string'
    ? normalizedMessage.content
    : normalizedMessage.content
      .map((part) => typeof part === 'string'
        ? part
        : 'text' in part && typeof part.text === 'string'
          ? part.text
          : '')
      .join('');
  if (!DSML_MARKER_VARIANT_TEST.test(content)) return normalizedMessage;
  if (content.length > MAX_DSML_CONTENT_LENGTH) {
    throw new Error(
      `DeepSeek DSML exceeds the ${MAX_DSML_CONTENT_LENGTH}-character safety limit.`,
    );
  }

  if (options.allowTextEncodedToolCalls === false) {
    // After finish_task succeeded, tools are disabled: the reporter should
    // only emit the final prose report. DeepSeek sometimes re-emits DSML
    // protocol noise instead. Hard-throwing here sits outside withRetry in
    // the reporting node and would discard the entire audit after all
    // evidence was collected. Strip the DSML envelope and fall through to
    // the same no-tool-calls path as stream-processor, so any real prose
    // still reaches the report.
    const stripped = content.replace(DSML_TOOL_BLOCK_PATTERN, '');
    if (stripped.trim()) {
      return new AIMessage({
        additional_kwargs: normalizedMessage.additional_kwargs,
        content: stripped,
        id: normalizedMessage.id,
        invalid_tool_calls: normalizedMessage.invalid_tool_calls,
        name: normalizedMessage.name,
        response_metadata: normalizedMessage.response_metadata,
        tool_calls: normalizedMessage.tool_calls,
        usage_metadata: normalizedMessage.usage_metadata,
      });
    }
    throw new Error(
      'DeepSeek emitted only a DSML tool call with no prose after tools were disabled for stage finalization.',
    );
  }

  const parsed = parseDsmlToolCalls(content);
  const existingCalls = normalizedMessage.tool_calls ?? [];
  const signatures = new Set(existingCalls.map((call) => toolCallSignature(call)));
  const additionalCalls = parsed.toolCalls.filter((call) => {
    const signature = toolCallSignature(call);
    if (signatures.has(signature)) return false;
    signatures.add(signature);
    return true;
  });

  return new AIMessage({
    additional_kwargs: normalizedMessage.additional_kwargs,
    content: parsed.content,
    id: normalizedMessage.id,
    invalid_tool_calls: normalizedMessage.invalid_tool_calls,
    name: normalizedMessage.name,
    response_metadata: normalizedMessage.response_metadata,
    tool_calls: [...existingCalls, ...additionalCalls],
    usage_metadata: normalizedMessage.usage_metadata,
  });
}
