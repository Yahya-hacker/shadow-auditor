export interface NormalizedTokenUsage {
  completion: number;
  prompt: number;
  total: number;
  totalSource: 'derived' | 'provider';
  unclassified: number;
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
  const componentTotal = prompt + completion;
  const total = Math.max(reportedTotal, componentTotal);
  return total > 0 ? {
    completion,
    prompt,
    total,
    totalSource: reportedTotal >= componentTotal && reportedTotal > 0 ? 'provider' : 'derived',
    unclassified: Math.max(0, total - prompt - completion),
  } : undefined;
}

export function normalizeTokenUsage(message: unknown): NormalizedTokenUsage | undefined {
  const value = record(message);
  if (!value) return;
  const responseMetadata = record(value.response_metadata ?? value.responseMetadata);
  const usageValues = [
    value.usage_metadata,
    value.usageMetadata,
    value.usage,
    responseMetadata?.usage_metadata,
    responseMetadata?.usageMetadata,
    responseMetadata?.token_usage,
    responseMetadata?.tokenUsage,
    responseMetadata?.usage,
  ];
  let largest: NormalizedTokenUsage | undefined;

  for (const usageValue of usageValues) {
    const usage = parseUsage(usageValue);
    if (usage && (!largest || usage.total > largest.total)) largest = usage;
  }

  return largest;
}
