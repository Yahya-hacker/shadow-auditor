/**
 * Hybrid Retriever - Multi-strategy code retrieval with Reciprocal Rank Fusion.
 *
 * Combines three retrieval strategies:
 *   1. Graph-based: KnowledgeGraph entity/edge traversal
 *   2. Lexical: ripgrep-powered keyword search
 *   3. Semantic: Vector similarity search via SemanticIndex
 *
 * Results are merged using Reciprocal Rank Fusion (RRF) to produce a
 * unified, deduplicated ranking. Configurable weights allow tuning
 * the contribution of each strategy.
 */


import type { KnowledgeGraph } from './knowledge-graph.js';
import type { BaseEntity } from './memory-schema.js';
import type { Retrieval } from './retrieval.js';
import type { CodeChunk, SemanticIndex, SemanticSearchResult } from './semantic-index.js';

// ============================================================================
// Types
// ============================================================================

export interface HybridResult {
  /** The code chunk (present for semantic/lexical results) */
  chunk?: CodeChunk;
  /** The knowledge graph entity (present for graph results) */
  entity?: BaseEntity;
  /** Which file this result refers to */
  filePath: string;
  /** Fused score from RRF */
  fusedScore: number;
  /** Line range in the file */
  lineRange?: { end: number; start: number };
  /** Human-readable match description */
  matchDescription: string;
  /** Provenance: which strategies contributed to this result */
  provenance: HybridResultProvenance[];
  /** The actual code content */
  text: string;
}

export interface HybridResultProvenance {
  /** Rank within that strategy's results */
  rank: number;
  /** Raw score from the strategy */
  score: number;
  /** Which retrieval strategy produced this */
  strategy: RetrievalStrategy;
}

export type RetrievalStrategy = 'graph' | 'lexical' | 'semantic';

export interface HybridRetrieverOptions {
  /** Maximum results to return */
  maxResults?: number;
  /** Root path of the target repository */
  rootPath: string;
  /** RRF constant k (default: 60, standard RRF value) */
  rrfK?: number;
  /** Per-strategy weights (must sum to ~1.0) */
  weights?: Partial<Record<RetrievalStrategy, number>>;
}

export interface HybridSearchOptions {
  /** Only include results from files matching this glob/substring */
  fileFilter?: string;
  /** Maximum results */
  maxResults?: number;
  /** Only include results from specific strategies */
  strategies?: RetrievalStrategy[];
}

/**
 * Internal representation of a result from a single strategy,
 * before fusion.
 */
interface StrategyResult {
  /** Deduplication key (filePath:startLine or entityId) */
  dedupKey: string;
  filePath: string;
  lineRange?: { end: number; start: number };
  matchDescription: string;
  /** Payload references */
  payload: {
    chunk?: CodeChunk;
    entity?: BaseEntity;
  };
  /** Rank within the strategy (1-based) */
  rank: number;
  /** Raw score from the strategy */
  score: number;
  /** Which strategy */
  strategy: RetrievalStrategy;
  text: string;
}

// ============================================================================
// Lexical Search (ripgrep-style in-process)
// ============================================================================

/**
 * Simple in-process lexical search.
 * Searches code chunks by keyword matching (case-insensitive).
 */
function lexicalSearch(
  query: string,
  chunks: CodeChunk[],
  options: { fileFilter?: string; maxResults?: number } = {},
): Array<{ chunk: CodeChunk; score: number }> {
  const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (queryTerms.length === 0) {
    return [];
  }

  const results: Array<{ chunk: CodeChunk; score: number }> = [];

  for (const chunk of chunks) {
    if (options.fileFilter && !chunk.filePath.includes(options.fileFilter)) {
      continue;
    }

    const searchText = `${chunk.symbol} ${chunk.rawContent}`.toLowerCase();
    let matchCount = 0;
    let totalMatches = 0;

    for (const term of queryTerms) {
      const termMatches = countOccurrences(searchText, term);
      if (termMatches > 0) {
        matchCount++;
        totalMatches += termMatches;
      }
    }

    if (matchCount === 0) {
      continue;
    }

    // Score: combination of term coverage and match density
    const termCoverage = matchCount / queryTerms.length;
    const density = Math.min(1, totalMatches / (searchText.length / 100));
    const score = termCoverage * 0.7 + density * 0.3;

    results.push({ chunk, score });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, options.maxResults ?? 20);
}

/**
 * Count non-overlapping occurrences of a substring.
 */
function countOccurrences(text: string, term: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(term, pos)) !== -1) {
    count++;
    pos += term.length;
  }

  return count;
}

// ============================================================================
// Reciprocal Rank Fusion
// ============================================================================

/**
 * Compute Reciprocal Rank Fusion score.
 * RRF(d) = Σ 1 / (k + rank_i(d))
 * where k is a constant (default 60) and rank_i is the rank from strategy i.
 */
function computeRRFScore(
  ranks: Array<{ rank: number; weight: number }>,
  k: number,
): number {
  return ranks.reduce((sum, { rank, weight }) => sum + weight / (k + rank), 0);
}

// ============================================================================
// Hybrid Retriever
// ============================================================================

/**
 * Multi-strategy code retriever with Reciprocal Rank Fusion.
 */
export class HybridRetriever {
  private readonly graph: KnowledgeGraph;
  private readonly maxResults: number;
  private readonly retrieval: Retrieval;
  private readonly rootPath: string;
  private readonly rrfK: number;
  private readonly semanticIndex: SemanticIndex;
  private readonly weights: Record<RetrievalStrategy, number>;

  constructor(
    graph: KnowledgeGraph,
    retrieval: Retrieval,
    semanticIndex: SemanticIndex,
    options: HybridRetrieverOptions,
  ) {
    this.graph = graph;
    this.retrieval = retrieval;
    this.semanticIndex = semanticIndex;
    this.rootPath = options.rootPath;
    this.maxResults = options.maxResults ?? 15;
    this.rrfK = options.rrfK ?? 60;
    this.weights = {
      graph: options.weights?.graph ?? 0.3,
      lexical: options.weights?.lexical ?? 0.2,
      semantic: options.weights?.semantic ?? 0.5,
    };
  }

  /**
   * Get all indexed chunks (for lexical search access).
   */
  getAllChunks(): CodeChunk[] {
    return this.semanticIndex.getAllChunks();
  }

  /**
   * Execute a hybrid search across all strategies and fuse results.
   */
  async search(
    query: string,
    options: HybridSearchOptions = {},
  ): Promise<HybridResult[]> {
    const strategies = options.strategies ?? ['semantic', 'lexical', 'graph'];
    const maxResults = options.maxResults ?? this.maxResults;
    const perStrategyLimit = maxResults * 3; // Fetch more per strategy for better fusion

    // Execute enabled strategies in parallel
    const strategyResults: StrategyResult[] = [];

    const promises: Array<Promise<StrategyResult[]>> = [];

    if (strategies.includes('semantic')) {
      promises.push(this.executeSemanticStrategy(query, perStrategyLimit, options.fileFilter));
    }

    if (strategies.includes('lexical')) {
      promises.push(this.executeLexicalStrategy(query, perStrategyLimit, options.fileFilter));
    }

    if (strategies.includes('graph')) {
      promises.push(this.executeGraphStrategy(query, perStrategyLimit));
    }

    const results = await Promise.allSettled(promises);

    for (const result of results) {
      if (result.status === 'fulfilled') {
        strategyResults.push(...result.value);
      }
    }

    // Fuse results using RRF
    return this.fuseResults(strategyResults, maxResults);
  }

  // ==========================================================================
  // Strategy Implementations
  // ==========================================================================

  private async executeGraphStrategy(
    query: string,
    limit: number,
  ): Promise<StrategyResult[]> {
    try {
      // Search the knowledge graph for entities matching the query
      const searchResults = this.retrieval.searchByLabel(query, { limit });

      return searchResults.map((r, index) => {
        // Extract file path from entity properties
        const props = r.entity.properties as Record<string, unknown>;
        const filePath = (props.path as string) ?? (props.fileCanonicalId as string) ?? '';

        return {
          dedupKey: r.entity.canonicalId,
          filePath,
          matchDescription: `Graph match: ${r.entity.label} (${r.entity.entityType})`,
          payload: { entity: r.entity },
          rank: index + 1,
          score: r.score,
          strategy: 'graph' as RetrievalStrategy,
          text: `// ${r.entity.entityType}: ${r.entity.label}\n${JSON.stringify(r.entity.properties, null, 2)}`,
        };
      });
    } catch (error) {
      console.warn(`[HybridRetriever] Graph search failed: ${(error as Error).message}`);
      return [];
    }
  }

  private async executeLexicalStrategy(
    query: string,
    limit: number,
    fileFilter?: string,
  ): Promise<StrategyResult[]> {
    try {
      const allChunks = this.getAllChunks();
      const results = lexicalSearch(query, allChunks, { fileFilter, maxResults: limit });

      return results.map((r, index) => ({
        dedupKey: `${r.chunk.filePath}:${r.chunk.startLine}`,
        filePath: r.chunk.filePath,
        lineRange: { end: r.chunk.endLine, start: r.chunk.startLine },
        matchDescription: `Lexical match: ${r.chunk.symbol} (${r.chunk.structuralType})`,
        payload: { chunk: r.chunk },
        rank: index + 1,
        score: r.score,
        strategy: 'lexical' as RetrievalStrategy,
        text: r.chunk.rawContent,
      }));
    } catch (error) {
      console.warn(`[HybridRetriever] Lexical search failed: ${(error as Error).message}`);
      return [];
    }
  }

  private async executeSemanticStrategy(
    query: string,
    limit: number,
    fileFilter?: string,
  ): Promise<StrategyResult[]> {
    try {
      const results = await this.semanticIndex.search(query, {
        fileFilter,
        topK: limit,
      });

      return results.map((r, index) => ({
        dedupKey: `${r.chunk.filePath}:${r.chunk.startLine}`,
        filePath: r.chunk.filePath,
        lineRange: { end: r.chunk.endLine, start: r.chunk.startLine },
        matchDescription: `Semantic match: ${r.chunk.symbol} (${r.chunk.structuralType})`,
        payload: { chunk: r.chunk },
        rank: index + 1,
        score: r.score,
        strategy: 'semantic' as RetrievalStrategy,
        text: r.chunk.parentContext
          ? `${r.chunk.parentContext}\n\n${r.chunk.rawContent}`
          : r.chunk.rawContent,
      }));
    } catch (error) {
      console.warn(`[HybridRetriever] Semantic search failed: ${(error as Error).message}`);
      return [];
    }
  }

  // ==========================================================================
  // Fusion
  // ==========================================================================

  /**
   * Fuse results from multiple strategies using Reciprocal Rank Fusion.
   */
  private fuseResults(
    allResults: StrategyResult[],
    maxResults: number,
  ): HybridResult[] {
    // Group by dedup key
    const grouped = new Map<string, StrategyResult[]>();

    for (const result of allResults) {
      const existing = grouped.get(result.dedupKey) ?? [];
      existing.push(result);
      grouped.set(result.dedupKey, existing);
    }

    // Compute RRF score for each unique result
    const fused: HybridResult[] = [];

    for (const [dedupKey, results] of grouped) {
      const ranks = results.map((r) => ({
        rank: r.rank,
        weight: this.weights[r.strategy],
      }));

      const fusedScore = computeRRFScore(ranks, this.rrfK);
      const provenance: HybridResultProvenance[] = results.map((r) => ({
        rank: r.rank,
        score: r.score,
        strategy: r.strategy,
      }));

      // Use the highest-ranked result's data as the canonical representation
      const primary = results.sort((a, b) => a.rank - b.rank)[0];

      fused.push({
        chunk: primary.payload.chunk,
        entity: primary.payload.entity,
        filePath: primary.filePath,
        fusedScore,
        lineRange: primary.lineRange,
        matchDescription: primary.matchDescription,
        provenance,
        text: primary.text,
      });
    }

    // Sort by fused score descending
    fused.sort((a, b) => b.fusedScore - a.fusedScore);
    return fused.slice(0, maxResults);
  }

}
