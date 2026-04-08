/**
 * Retrieval APIs - Lexical, semantic, and graph-based querying.
 */

import type { KnowledgeGraph, TraversalOptions } from './knowledge-graph.js';
import type { BaseEntity, EntityType, GraphEdge } from './memory-schema.js';

export interface SearchResult {
  entity: BaseEntity;
  matchType: 'exact' | 'fuzzy' | 'graph';
  score: number;
}

export interface PathResult {
  confidence: number;
  edges: GraphEdge[];
  entities: BaseEntity[];
}

/**
 * Retrieval service for knowledge graph queries.
 */
export class Retrieval {
  constructor(private readonly graph: KnowledgeGraph) {}

  /**
   * Find all sources that can reach a sink.
   */
  findContributingSources(sinkId: string, options?: TraversalOptions): BaseEntity[] {
    const reachable = this.graph.traverse(sinkId, {
      direction: 'inbound',
      edgeTypes: ['flows_to'],
      ...options,
    });

    return reachable.filter((e) => e.entityType === 'source');
  }

  /**
   * Find data flow paths from sources to sinks.
   */
  findDataFlowPaths(sourceId: string, sinkId: string, maxDepth = 10): PathResult[] {
    const paths = this.graph.findPaths(sourceId, sinkId, maxDepth);

    return paths.map((path) => {
      // Calculate path confidence as product of edge confidences
      const confidence = path.edges.reduce((acc, edge) => acc * edge.confidence, 1);
      return { ...path, confidence };
    });
  }

  /**
   * Find all sinks reachable from a source.
   */
  findReachableSinks(sourceId: string, options?: TraversalOptions): BaseEntity[] {
    const reachable = this.graph.traverse(sourceId, {
      direction: 'outbound',
      edgeTypes: ['flows_to'],
      ...options,
    });

    return reachable.filter((e) => e.entityType === 'sink');
  }

  /**
   * Get all unverified hypotheses (low confidence entities/edges).
   */
  getUnverifiedHypotheses(confidenceThreshold = 0.7): {
    edges: GraphEdge[];
    entities: BaseEntity[];
  } {
    const entities = this.graph
      .query({ minConfidence: 0 })
      .filter((e) => e.confidence < confidenceThreshold);

    // Get low-confidence edges
    const allEntities = this.graph.query({});
    const edges: GraphEdge[] = [];

    for (const entity of allEntities) {
      const outbound = this.graph.getOutboundEdges(entity.canonicalId);
      for (const edge of outbound) {
        if (edge.confidence < confidenceThreshold && !edge.validated) {
          edges.push(edge);
        }
      }
    }

    return { edges, entities };
  }

  /**
   * Get entities related to a vulnerability.
   */
  getVulnerabilityContext(vulnId: string): {
    affectedFiles: BaseEntity[];
    exploitPath: BaseEntity[];
    relatedFunctions: BaseEntity[];
    sinks: BaseEntity[];
    sources: BaseEntity[];
  } {
    const vuln = this.graph.getEntity(vulnId);
    if (!vuln || vuln.entityType !== 'vulnerability') {
      return {
        affectedFiles: [],
        exploitPath: [],
        relatedFunctions: [],
        sinks: [],
        sources: [],
      };
    }

    // Get directly connected entities
    const inbound = this.graph.getInboundEdges(vulnId);
    const outbound = this.graph.getOutboundEdges(vulnId);

    const sources: BaseEntity[] = [];
    const sinks: BaseEntity[] = [];
    const relatedFunctions: BaseEntity[] = [];
    const affectedFiles: BaseEntity[] = [];

    for (const edge of [...inbound, ...outbound]) {
      const otherId = edge.sourceEntityId === vulnId ? edge.targetEntityId : edge.sourceEntityId;
      const entity = this.graph.getEntity(otherId);
      if (!entity) continue;

      switch (entity.entityType) {
        case 'file': {
          affectedFiles.push(entity);
          break;
        }

        case 'function': {
          relatedFunctions.push(entity);
          break;
        }

        case 'sink': {
          sinks.push(entity);
          break;
        }

        case 'source': {
          sources.push(entity);
          break;
        }
      }
    }

    // Trace exploit path if source and sink are present
    const exploitPath: BaseEntity[] = [];
    if (sources.length > 0 && sinks.length > 0) {
      const paths = this.findDataFlowPaths(sources[0].canonicalId, sinks[0].canonicalId);
      if (paths.length > 0) {
        exploitPath.push(...paths[0].entities);
      }
    }

    return { affectedFiles, exploitPath, relatedFunctions, sinks, sources };
  }

  /**
   * Search entities by label with fuzzy matching.
   */
  searchByLabel(query: string, options: { entityType?: EntityType; limit?: number } = {}): SearchResult[] {
    const queryLower = query.toLowerCase();
    const candidates = this.graph.query({ entityType: options.entityType });

    const scored: SearchResult[] = candidates.map((entity) => {
      const labelLower = entity.label.toLowerCase();
      let score = 0;

      if (labelLower === queryLower) {
        score = 1; // Exact match
      } else if (labelLower.includes(queryLower)) {
        score = 0.8; // Contains match
      } else if (queryLower.includes(labelLower)) {
        score = 0.6; // Reverse contains
      } else {
        // Levenshtein-inspired simple similarity
        score = this.simpleSimilarity(queryLower, labelLower);
      }

      return {
        entity,
        matchType: score === 1 ? 'exact' : 'fuzzy',
        score: score * entity.confidence,
      };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, options.limit ?? 20);
  }

  /**
   * Simple string similarity (Jaccard-like on character bigrams).
   */
  private simpleSimilarity(a: string, b: string): number {
    if (a.length < 2 || b.length < 2) {
      return a === b ? 1 : 0;
    }

    const bigramsA = new Set<string>();
    const bigramsB = new Set<string>();

    for (let i = 0; i < a.length - 1; i++) {
      bigramsA.add(a.slice(i, i + 2));
    }

    for (let i = 0; i < b.length - 1; i++) {
      bigramsB.add(b.slice(i, i + 2));
    }

    let intersection = 0;
    for (const bg of bigramsA) {
      if (bigramsB.has(bg)) intersection++;
    }

    const union = bigramsA.size + bigramsB.size - intersection;
    return union > 0 ? intersection / union : 0;
  }
}
