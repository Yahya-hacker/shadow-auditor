/**
 * Evidence Linker - Links findings to concrete evidence.
 */

import type { KnowledgeGraph } from '../memory/knowledge-graph.js';
import type { BaseEntity } from '../memory/memory-schema.js';
import type { CodeEvidence } from '../schema/base.js';

export interface ToolRunRef {
  toolCallId: string;
  toolName: string;
  truncated: boolean;
}

export interface EvidenceLink {
  code?: CodeEvidence[];
  entityIds: string[];
  toolRuns?: ToolRunRef[];
  totalWeight: number;
}

export interface LinkingResult {
  coverage: number;          // 0-1, how well the finding is covered by evidence
  gaps: string[];            // Areas lacking evidence
  links: EvidenceLink;
  strength: 'moderate' | 'none' | 'strong' | 'weak';
}

export interface EvidenceItem {
  description?: string;
  evidence?: CodeEvidence | ToolRunRef;
  type: 'code' | 'manual' | 'tool_run';
}

/**
 * Links findings to concrete evidence from the knowledge graph.
 */
export class EvidenceLinker {
  constructor(private readonly graph: KnowledgeGraph) {}

  /**
   * Get all evidence for an entity.
   */
  getEntityEvidence(entityId: string): EvidenceItem[] {
    const entity = this.graph.getEntity(entityId);
    if (!entity) {
      return [];
    }

    const evidence: EvidenceItem[] = [];

    // Add code evidence if available
    const codeEvidence = this.extractCodeEvidence(entity);
    if (codeEvidence) {
      evidence.push({
        evidence: codeEvidence,
        type: 'code',
      });
    }

    // Add tool run evidence from related tool_run entities
    const toolRunEdges = this.graph.getInboundEdges(entityId, 'validates');
    for (const edge of toolRunEdges) {
      const toolRun = this.graph.getEntity(edge.sourceEntityId);
      if (toolRun?.entityType === 'tool_run') {
        const props = toolRun.properties as {
          toolCallId: string;
          toolName: string;
          truncated?: boolean;
        };
        evidence.push({
          evidence: {
            toolCallId: props.toolCallId,
            toolName: props.toolName,
            truncated: props.truncated ?? false,
          },
          type: 'tool_run',
        });
      }
    }

    return evidence;
  }

  /**
   * Link a finding to available evidence.
   */
  linkFinding(
    title: string,
    entityIds: string[],
    toolRunRefs: ToolRunRef[],
  ): LinkingResult {
    const links: EvidenceLink = {
      code: [],
      entityIds: [],
      toolRuns: toolRunRefs,
      totalWeight: 0,
    };

    const gaps: string[] = [];

    // Collect evidence from entities
    for (const entityId of entityIds) {
      const entity = this.graph.getEntity(entityId);
      if (!entity) {
        gaps.push(`Entity not found: ${entityId}`);
        continue;
      }

      links.entityIds.push(entityId);

      // Extract code evidence if available
      const codeEvidence = this.extractCodeEvidence(entity);
      if (codeEvidence) {
        links.code!.push(codeEvidence);
        links.totalWeight += 0.3;
      }
    }

    // Add weight for tool runs
    links.totalWeight += Math.min(toolRunRefs.length * 0.2, 0.4);

    // Calculate coverage
    const hasCode = links.code!.length > 0;
    const hasToolRuns = toolRunRefs.length > 0;
    const hasEntities = links.entityIds.length > 0;

    let coverage = 0;
    if (hasCode) coverage += 0.4;
    if (hasToolRuns) coverage += 0.3;
    if (hasEntities) coverage += 0.3;

    // Identify gaps
    if (!hasCode) {
      gaps.push('No code evidence available');
    }

    if (!hasToolRuns) {
      gaps.push('No tool run evidence available');
    }

    if (!hasEntities) {
      gaps.push('No knowledge graph entities linked');
    }

    // Determine strength
    let strength: LinkingResult['strength'];
    if (coverage >= 0.7 && hasCode && hasToolRuns) {
      strength = 'strong';
    } else if (coverage >= 0.5) {
      strength = 'moderate';
    } else if (coverage > 0) {
      strength = 'weak';
    } else {
      strength = 'none';
    }

    return {
      coverage,
      gaps,
      links,
      strength,
    };
  }

  /**
   * Verify source-to-sink path has evidence.
   */
  verifyDataFlowEvidence(
    sourceId: string,
    sinkId: string,
    intermediateIds: string[],
  ): {
    coverage: number;
    gaps: string[];
    hasPath: boolean;
  } {
    const gaps: string[] = [];
    let coverage = 0;

    // Check source exists
    const source = this.graph.getEntity(sourceId);
    if (source) {
      coverage += 0.25;
    } else {
      gaps.push(`Source entity not found: ${sourceId}`);
    }

    // Check sink exists
    const sink = this.graph.getEntity(sinkId);
    if (sink) {
      coverage += 0.25;
    } else {
      gaps.push(`Sink entity not found: ${sinkId}`);
    }

    // Check intermediate nodes
    let intermediateFound = 0;
    for (const id of intermediateIds) {
      if (this.graph.getEntity(id)) {
        intermediateFound++;
      } else {
        gaps.push(`Intermediate entity not found: ${id}`);
      }
    }

    if (intermediateIds.length > 0) {
      coverage += 0.25 * (intermediateFound / intermediateIds.length);
    } else {
      coverage += 0.25; // No intermediates required
    }

    // Check edges exist
    if (source && sink) {
      const paths = this.graph.findPaths(sourceId, sinkId, 10);
      if (paths.length > 0) {
        coverage += 0.25;
      } else {
        gaps.push('No path found between source and sink in knowledge graph');
      }
    }

    return {
      coverage,
      gaps,
      hasPath: coverage >= 0.75,
    };
  }

  /**
   * Extract code evidence from an entity if available.
   */
  private extractCodeEvidence(entity: BaseEntity): CodeEvidence | null {
    const props = entity.properties as Record<string, unknown>;

    // Check if entity has code-related properties
    if (!props.path && !props.filePath && !props.fileCanonicalId) {
      return null;
    }

    const filePath = (props.path ?? props.filePath ?? '') as string;
    const lineStart = (props.lineStart ?? props.lineNumber ?? 1) as number;
    const lineEnd = (props.lineEnd ?? lineStart) as number;

    // We don't have the actual code snippet stored, so return minimal evidence
    return {
      codeSnippet: props.codeSnippet as string ?? `[Code at ${filePath}:${lineStart}]`,
      hash: props.codeHash as string ?? `hash_${entity.canonicalId.slice(-8)}`,
      language: props.language as string | undefined,
      location: {
        endLine: lineEnd,
        filePath,
        startLine: lineStart,
      },
    };
  }
}
