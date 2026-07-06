/**
 * Context Retrieval Tool - On-demand hybrid code retrieval for the agent.
 *
 * Replaces the static repo-map context window dump with a dynamic tool
 * that the agent can invoke to pull relevant code chunks on-demand.
 * Uses the HybridRetriever (semantic + lexical + graph) to find the
 * most relevant code for the agent's current analysis task.
 */

import * as path from 'node:path';
import { z } from 'zod';

import type { HybridRetriever, RetrievalStrategy } from '../memory/hybrid-retriever.js';

export interface ContextRetrievalToolOptions {
  retriever: HybridRetriever;
  rootPath: string;
}

/**
 * Format a search result into a compact, agent-digestible block.
 * Strips provenance metadata (strategy, rank, scores) and focuses on
 * what the agent actually needs: file path, line range, and code.
 */
function formatResult(
  result: {
    filePath: string;
    lineRange?: { start: number; end: number };
    text: string;
    matchDescription: string;
  },
  rootPath: string,
  index: number,
): string {
  const relativePath = path.relative(rootPath, result.filePath);
  const lineInfo = result.lineRange
    ? `:${result.lineRange.start}-${result.lineRange.end}`
    : '';

  // Trim code to a reasonable snippet size
  const code = result.text.length > 1500
    ? result.text.slice(0, 1500) + '\n... (truncated, use read_file_content with startLine/endLine for full context)'
    : result.text;

  return [
    `── Result ${index + 1} ── ${relativePath}${lineInfo}`,
    `   ${result.matchDescription}`,
    '',
    code,
  ].join('\n');
}

export function createContextRetrievalTool(options: ContextRetrievalToolOptions) {
  const { retriever, rootPath } = options;

  return {
    description:
      'Searches the codebase using hybrid retrieval (semantic similarity, keyword matching, and knowledge graph traversal). ' +
      'Use this to find code relevant to your current analysis task without reading entire files. ' +
      'Returns ranked code chunks with file paths, line numbers, and relevance scores. ' +
      'Prefer this over reading full files when you need to find specific patterns, functions, or vulnerability-related code.\n\n' +
      'USAGE EXAMPLES:\n' +
      '- { query: "SQL query construction without parameterized statements", strategy: "hybrid" }\n' +
      '- { query: "user authentication logic with session tokens", maxResults: 15 }\n' +
      '- { query: "file upload handling without extension validation" }\n' +
      '- { query: "crypto.randomBytes or Math.random for token generation", strategy: "semantic" }\n' +
      'CHAIN: After context_retrieval finds relevant chunks, use read_file_content with startLine/endLine to see full surrounding context.\n' +
      'TIP: Be specific. "JWT verification without signature validation" is better than "auth bug".',
    async execute({
      fileFilter,
      maxResults,
      query,
      strategy,
    }: {
      fileFilter?: string;
      maxResults?: number;
      query: string;
      strategy?: string;
    }) {
      try {
        const strategies = strategy
          ? [strategy as RetrievalStrategy]
          : undefined;

        const results = await retriever.search(query, {
          fileFilter,
          maxResults: maxResults ?? 10,
          strategies,
        });

        if (results.length === 0) {
          return `── context_retrieval ── 0 results ──\n\nNo results found for query: "${query}"\n\nSuggestions:\n- Try broader terms or a different strategy (e.g., strategy: "lexical" for keywords)\n- Remove fileFilter if one was applied\n- Check the query for typos`;
        }

        // Show the top result count and grouped file paths
        const filePaths = [...new Set(results.map((r) => path.relative(rootPath, r.filePath)))];
        const header = [
          `── context_retrieval ── ${results.length} results for "${query}" ──`,
          `Files matched: ${filePaths.join(', ')}`,
          ``,
        ];

        // Format individual results compactly
        const formatted = results.map((r, i) => formatResult(r, rootPath, i));

        // Add chaining hint
        const chainingHint = [
          ``,
          `── Next steps ──`,
          `• To inspect a result: read_file_content({ filePath: "<path>", startLine: <line>, endLine: <line+50> })`,
          `• To find more like this: context_retrieval({ query: "<refined query>", maxResults: 15 })`,
          `• To search for exact patterns: search_codebase({ regexPattern: "<pattern>" })`,
        ];

        return [...header, ...formatted, ...chainingHint].join('\n');
      } catch (error) {
        return `[ERROR] Context retrieval failed: ${(error as Error).message}`;
      }
    },
    inputSchema: z.object({
      fileFilter: z
        .string()
        .optional()
        .describe('Optional file path substring filter (e.g., "controllers/" or ".ts").'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe('Maximum number of results to return (default: 10).'),
      query: z
        .string()
        .min(3)
        .describe(
          'Natural language query describing what code you are looking for. ' +
            'Be specific: "SQL query construction without parameterization" is better than "SQL".',
        ),
      strategy: z
        .enum(['semantic', 'lexical', 'graph', 'hybrid'])
        .optional()
        .describe(
          'Retrieval strategy. "semantic" for meaning-based search, "lexical" for keyword matching, ' +
            '"graph" for knowledge graph traversal. Default: hybrid (all strategies combined).',
        ),
    }),
  };
}
