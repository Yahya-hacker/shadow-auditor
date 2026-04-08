/**
 * Chain Builder - Constructs attack chains from knowledge graph analysis.
 */

import * as crypto from 'node:crypto';

import type { KnowledgeGraph } from '../memory/knowledge-graph.js';
import type { BaseEntity, VulnerabilityEntity } from '../memory/memory-schema.js';
import type { Retrieval } from '../memory/retrieval.js';
import type { AttackCategory, AttackChain, AttackStep } from './planner-schema.js';

import { err, ok, type Result } from '../schema/base.js';
import { AttackChainManager, type AttackStepInput, AttackStepManager } from './attack-chain.js';

/**
 * CWE to attack category mapping.
 */
const CWE_CATEGORY_MAP: Record<string, AttackCategory> = {
  'CWE-22': 'access_control', // Path Traversal
  'CWE-78': 'injection',   // OS Command Injection
  'CWE-79': 'xss',         // XSS
  'CWE-89': 'injection',   // SQL Injection
  'CWE-94': 'injection',   // Code Injection
  'CWE-200': 'sensitive_data', // Information Exposure
  'CWE-287': 'broken_auth',   // Improper Authentication
  'CWE-306': 'broken_auth',   // Missing Auth for Critical Function
  'CWE-312': 'sensitive_data', // Cleartext Storage
  'CWE-319': 'sensitive_data', // Cleartext Transmission
  'CWE-327': 'security_misconfig', // Broken Crypto
  'CWE-352': 'broken_auth',   // CSRF
  'CWE-434': 'access_control', // Unrestricted Upload
  'CWE-502': 'deserialization', // Deserialization
  'CWE-611': 'xxe',           // XXE
  'CWE-798': 'security_misconfig', // Hardcoded Credentials
  'CWE-918': 'ssrf',          // SSRF
  'CWE-1104': 'components',    // Vulnerable Components
};

/**
 * Get attack category from CWE.
 */
export function cweToCategory(cwe: string): AttackCategory {
  return CWE_CATEGORY_MAP[cwe] ?? 'other';
}

export interface ChainBuilderOptions {
  maxChainLength?: number;
  minConfidence?: number;
}

/**
 * Builds attack chains from knowledge graph data.
 */
export class ChainBuilder {
  private readonly chainManager: AttackChainManager;
  private readonly graph: KnowledgeGraph;
  private readonly options: Required<ChainBuilderOptions>;
  private readonly retrieval: Retrieval;
  private readonly stepManager: AttackStepManager;

  constructor(
    graph: KnowledgeGraph,
    retrieval: Retrieval,
    options: ChainBuilderOptions = {},
  ) {
    this.graph = graph;
    this.retrieval = retrieval;
    this.options = {
      maxChainLength: options.maxChainLength ?? 10,
      minConfidence: options.minConfidence ?? 0.3,
    };

    this.stepManager = new AttackStepManager();
    this.chainManager = new AttackChainManager(this.stepManager);
  }

  /**
   * Build an attack chain from a single vulnerability.
   */
  async buildChainFromVulnerability(vuln: BaseEntity): Promise<Result<AttackChain | null, string>> {
    const props = vuln.properties as VulnerabilityEntity['properties'];
    const cwe = props.cwe;
    const category = cweToCategory(cwe);

    // Create the main vulnerability step
    const mainStepResult = this.stepManager.createStep({
      attackCategory: category,
      cwe,
      description: `Exploit vulnerability: ${props.title}`,
      entityIds: [vuln.canonicalId],
      feasibility: vuln.confidence,
      impact: this.estimateImpact(category),
      title: props.title,
    });

    if (!mainStepResult.ok) {
      return err(mainStepResult.error);
    }

    const mainStep = mainStepResult.value;

    // Update confidence if verified
    if (props.verified) {
      this.stepManager.updateStepStatus(mainStep.stepId, 'verified');
      this.stepManager.updateStepConfidence(mainStep.stepId, 0.9);
    }

    // Get vulnerability context for additional steps
    const context = this.retrieval.getVulnerabilityContext(vuln.canonicalId);
    const stepIds: string[] = [mainStep.stepId];

    // Add prerequisite steps for sources if available
    if (context.sources.length > 0) {
      const sourceStep = this.stepManager.createStep({
        attackCategory: category,
        cwe,
        description: `Provide malicious input via ${context.sources[0].label}`,
        entityIds: context.sources.map((s) => s.canonicalId),
        feasibility: 0.8, // Sources are usually accessible
        impact: 0.3,
        title: `Input via ${context.sources[0].label}`,
      });

      if (sourceStep.ok) {
        stepIds.unshift(sourceStep.value.stepId);
        // Main step depends on source step
        this.stepManager.getStep(mainStep.stepId)!.prerequisites.push(sourceStep.value.stepId);
      }
    }

    // Add post-exploitation step if high impact
    if (this.estimateImpact(category) >= 0.7) {
      const postExploitStep = this.stepManager.createStep({
        attackCategory: category,
        cwe,
        description: `Leverage ${props.title} for further access`,
        feasibility: 0.5,
        impact: 0.9,
        prerequisites: [mainStep.stepId],
        title: `Post-exploitation: ${category}`,
      });

      if (postExploitStep.ok) {
        stepIds.push(postExploitStep.value.stepId);
      }
    }

    // Create the chain
    const chainResult = this.chainManager.createChain(
      `${category.toUpperCase()} Attack Chain: ${props.title}`,
      `Attack chain exploiting ${cwe}: ${props.title}`,
      stepIds,
    );

    if (!chainResult.ok) {
      return err(chainResult.error);
    }

    return ok(chainResult.value);
  }

  /**
   * Build chains from data flow paths (source -> sink).
   */
  async buildFromDataFlows(): Promise<Result<AttackChain[], string>> {
    const sources = this.graph.getEntitiesByType('source');
    const sinks = this.graph.getEntitiesByType('sink');

    if (sources.length === 0 || sinks.length === 0) {
      return ok([]);
    }

    const chains: AttackChain[] = [];

    // Find data flow paths between sources and sinks
    for (const source of sources) {
      for (const sink of sinks) {
        const paths = this.retrieval.findDataFlowPaths(source.canonicalId, sink.canonicalId);

        if (paths.length === 0) continue;

        // Use highest confidence path
        const bestPath = paths.sort((a, b) => b.confidence - a.confidence)[0];

        if (bestPath.confidence < this.options.minConfidence) continue;

        const chainResult = await this.buildChainFromDataFlow(source, sink, bestPath);
        if (chainResult.ok && chainResult.value) {
          chains.push(chainResult.value);
        }
      }
    }

    return ok(chains);
  }

  /**
   * Build attack chains from discovered vulnerabilities.
   */
  async buildFromVulnerabilities(): Promise<Result<AttackChain[], string>> {
    const vulnEntities = this.graph.getEntitiesByType('vulnerability');

    if (vulnEntities.length === 0) {
      return ok([]);
    }

    const chains: AttackChain[] = [];

    for (const vuln of vulnEntities) {
      const result = await this.buildChainFromVulnerability(vuln);
      if (result.ok && result.value) {
        chains.push(result.value);
      }
    }

    return ok(chains);
  }

  /**
   * Get the chain manager.
   */
  getChainManager(): AttackChainManager {
    return this.chainManager;
  }

  /**
   * Get the step manager.
   */
  getStepManager(): AttackStepManager {
    return this.stepManager;
  }

  /**
   * Build a chain from a specific data flow path.
   */
  private async buildChainFromDataFlow(
    source: BaseEntity,
    sink: BaseEntity,
    path: { confidence: number; edges: unknown[]; entities: BaseEntity[] },
  ): Promise<Result<AttackChain | null, string>> {
    const sinkProps = sink.properties as { category: string; name: string };
    const sourceProps = source.properties as { category: string; name: string };

    // Determine attack category from sink
    const category = this.sinkCategoryToAttackCategory(sinkProps.category);
    const cwe = this.getCweForSinkCategory(sinkProps.category);

    const stepIds: string[] = [];

    // Step 1: Input injection at source
    const inputStep = this.stepManager.createStep({
      attackCategory: category,
      cwe,
      description: `Inject malicious data via ${sourceProps.name}`,
      entityIds: [source.canonicalId],
      feasibility: 0.8,
      impact: 0.3,
      title: `Input: ${sourceProps.name}`,
    });

    if (inputStep.ok) {
      stepIds.push(inputStep.value.stepId);
    }

    // Step 2: Flow through intermediate functions (simplified)
    const intermediateCount = Math.min(path.entities.length - 2, 2);
    for (let i = 1; i <= intermediateCount; i++) {
      const entity = path.entities[i];
      if (entity.entityType === 'function') {
        const previousStepId = stepIds.at(-1);
        const flowStep = this.stepManager.createStep({
          attackCategory: category,
          cwe,
          description: `Data flows through ${entity.label}`,
          entityIds: [entity.canonicalId],
          feasibility: 0.7,
          impact: 0.2,
          prerequisites: previousStepId ? [previousStepId] : [],
          title: `Flow: ${entity.label}`,
        });

        if (flowStep.ok) {
          stepIds.push(flowStep.value.stepId);
        }
      }
    }

    // Step 3: Exploit at sink
    const previousStepId = stepIds.at(-1);
    const exploitStep = this.stepManager.createStep({
      attackCategory: category,
      cwe,
      description: `Exploit ${category} at ${sinkProps.name}`,
      entityIds: [sink.canonicalId],
      feasibility: path.confidence,
      impact: this.estimateImpact(category),
      prerequisites: previousStepId ? [previousStepId] : [],
      title: `Exploit: ${sinkProps.name}`,
    });

    if (exploitStep.ok) {
      stepIds.push(exploitStep.value.stepId);

      // Update confidence based on path confidence
      this.stepManager.updateStepConfidence(exploitStep.value.stepId, path.confidence);
    }

    if (stepIds.length === 0) {
      return ok(null);
    }

    // Create the chain
    const chainResult = this.chainManager.createChain(
      `Data Flow Attack: ${sourceProps.name} → ${sinkProps.name}`,
      `Taint flow from ${sourceProps.category} source to ${sinkProps.category} sink`,
      stepIds,
    );

    return chainResult.ok ? ok(chainResult.value) : err(chainResult.error);
  }

  /**
   * Estimate impact score for attack category.
   */
  private estimateImpact(category: AttackCategory): number {
    switch (category) {
      case 'access_control': {
        return 0.8;
      }

      case 'broken_auth': {
        return 0.85;
      }

      case 'components': {
        return 0.6;
      }

      case 'deserialization': {
        return 0.9;
      }

      case 'injection': {
        return 0.9;
      }

      case 'logging': {
        return 0.3;
      }

      case 'security_misconfig': {
        return 0.5;
      }

      case 'sensitive_data': {
        return 0.7;
      }

      case 'ssrf': {
        return 0.7;
      }

      case 'xss': {
        return 0.6;
      }

      case 'xxe': {
        return 0.7;
      }

      default: {
        return 0.5;
      }
    }
  }

  /**
   * Get CWE for sink category.
   */
  private getCweForSinkCategory(sinkCategory: string): string {
    switch (sinkCategory) {
      case 'dom': {
        return 'CWE-79';
      }

      case 'execution': {
        return 'CWE-94';
      }

      case 'file': {
        return 'CWE-22';
      }

      case 'network': {
        return 'CWE-918';
      }

      case 'sql': {
        return 'CWE-89';
      }

      default: {
        return 'CWE-20';
      } // Improper Input Validation
    }
  }

  /**
   * Map sink category to attack category.
   */
  private sinkCategoryToAttackCategory(sinkCategory: string): AttackCategory {
    switch (sinkCategory) {
      case 'dom': {
        return 'xss';
      }

      case 'execution': {
        return 'injection';
      }

      case 'file': {
        return 'access_control';
      }

      case 'network': {
        return 'ssrf';
      }

      case 'sql': {
        return 'injection';
      }

      default: {
        return 'other';
      }
    }
  }
}
