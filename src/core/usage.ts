export interface NormalizedTokenUsage {
  completion: number;
  prompt: number;
  total: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function parseUsage(value: unknown): NormalizedTokenUsage | undefined {
  const usage = record(value);
  if (!usage) return;
  const prompt = tokenCount(
    usage.input_tokens ??
    usage.inputTokens ??
    usage.inputTokenCount ??
    usage.prompt_tokens ??
    usage.promptTokens ??
    usage.promptTokenCount,
  );
  const completion = tokenCount(
    usage.candidatesTokenCount ??
    usage.completion_tokens ??
    usage.completionTokens ??
    usage.output_tokens ??
    usage.outputTokens ??
    usage.outputTokenCount,
  );
  const reportedTotal = tokenCount(
    usage.total_tokens ?? usage.totalTokens ?? usage.totalTokenCount,
  );
  const total = reportedTotal || prompt + completion;
  return total > 0 ? {completion, prompt, total} : undefined;
}

export function normalizeTokenUsage(message: unknown): NormalizedTokenUsage | undefined {
  const value = record(message);
  if (!value) return;
  const responseMetadata = record(value.response_metadata ?? value.responseMetadata);
  for (const candidate of [
    value.usage_metadata,
    value.usageMetadata,
    value.usage,
    responseMetadata?.usage_metadata,
    responseMetadata?.usageMetadata,
    responseMetadata?.token_usage,
    responseMetadata?.tokenUsage,
    responseMetadata?.usage,
  ]) {
    const usage = parseUsage(candidate);
    if (usage) return usage;
  }
}
