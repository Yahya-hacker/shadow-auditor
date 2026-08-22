export const MAX_PARALLEL_TOOL_CALLS = 8;
export const MAX_TOOL_CALLS_PER_RESPONSE = 128;

const PARALLEL_READ_ONLY_TOOLS = new Set([
  'check_oast_logs',
  'context_retrieval',
  'git_diff',
  'list_directory',
  'read_file',
  'read_file_content',
  'sandbox_status',
  'search_codebase',
]);

export function canRunToolBatchConcurrently(toolNames: readonly string[]): boolean {
  return toolNames.length > 1 && toolNames.every((name) => PARALLEL_READ_ONLY_TOOLS.has(name));
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = values.length;
  let nextIndex = 0;
  const workers = Array.from(
    {length: Math.min(concurrency, values.length)},
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await operation(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
