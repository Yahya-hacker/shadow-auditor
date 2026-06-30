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

export function createContextRetrievalTool(options: ContextRetrievalToolOptions) {
  const { retriever, rootPath } = options;

  return {
    description:
      'Searches the codebase using hybrid retrieval (semantic similarity, keyword matching, and knowledge graph traversal). ' +
      'Use this to find code relevant to your current analysis task without reading entire files. ' +
      'Returns ranked code chunks with file paths, line numbers, and relevance scores. ' +
      'Prefer this over reading full files when you need to find specific patterns, functions, or vulnerability-related code.',
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
          return `No results found for query: "${query}"`;
        }

        // Format results for the agent
        const formatted = results.map((r, index) => {
          const relativePath = path.relative(rootPath, r.filePath);
          const lineInfo = r.lineRange
            ? `:${r.lineRange.start}-${r.lineRange.end}`
            : '';
          const provenanceInfo = r.provenance
            .map((p) => `${p.strategy}(rank=${p.rank}, score=${p.score.toFixed(3)})`)
            .join(', ');

          return [
            `── Result ${index + 1} ──────────────────────────────────────`,
            `File: ${relativePath}${lineInfo}`,
            `Match: ${r.matchDescription}`,
            `Fused Score: ${r.fusedScore.toFixed(4)}`,
            `Provenance: ${provenanceInfo}`,
            ``,
            r.text,
            ``,
          ].join('\n');
        });

        return [
          `Found ${results.length} results for: "${query}"`,
          ``,
          ...formatted,
        ].join('\n');
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
          '"graph" for knowledge graph traversal. Default: hybrid (all strategies combined via RRF).',
        ),
    }),
  };
}
