import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { BaseEntity, EntityType } from '../src/core/memory/memory-schema.js';

import { generateCanonicalId } from '../src/core/memory/entity-normalizer.js';
import { KnowledgeGraph } from '../src/core/memory/knowledge-graph.js';
import { CONFIDENCE_THRESHOLDS } from '../src/core/verify/confidence.js';
import { type FindingCandidate, VerificationGates } from '../src/core/verify/gates.js';

describe('verification gates', () => {
  let graph: KnowledgeGraph;
  let gates: VerificationGates;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-gates-test-'));
    graph = await KnowledgeGraph.create({
      runId: 'verify_run_001',
      storagePath: tempDir,
    });
    gates = new VerificationGates(graph);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  // eslint-disable-next-line unicorn/consistent-function-scoping, max-params
  function entity(
    entityType: EntityType,
    label: string,
    properties: Record<string, unknown> = {},
    confidence = 0.9,
    canonicalId?: string,
  ): BaseEntity {
    const now = new Date().toISOString();
    return {
      canonicalId: canonicalId ?? generateCanonicalId(entityType, { label, ...properties }),
      confidence,
      createdAt: now,
      entityType,
      label,
      properties,
      updatedAt: now,
    };
  }

  describe('code evidence gate', () => {
    it('fails when no linked entities are provided', () => {
      const candidate: FindingCandidate = {
        cwe: 'CWE-79',
        entityIds: [],
        title: 'XSS candidate without evidence',
      };

      const result = gates.verify(candidate);
      expect(result.gateResults.code_evidence.passed).to.equal(false);
    });

    it('passes when linked entity carries code-location properties', () => {
      const functionId = generateCanonicalId('function', { lineStart: 12, name: 'renderUnsafe' });
      graph.addEntity(
        entity(
          'function',
          'renderUnsafe',
          {
            codeSnippet: 'return <div dangerouslySetInnerHTML={{__html: input}} />',
            filePath: 'src/ui/render.tsx',
            lineStart: 12,
          },
          0.9,
          functionId,
        ),
      );

      const candidate: FindingCandidate = {
        cwe: 'CWE-79',
        entityIds: [functionId],
        title: 'Reflected XSS candidate',
        toolRunRefs: [
          {
            timestamp: new Date().toISOString(),
            toolCallId: 'toolcall01',
            toolName: 'semgrep',
            truncated: false,
          },
        ],
      };

      const result = gates.verify(candidate);
      expect(result.gateResults.code_evidence.passed).to.equal(true);
    });
  });

  describe('data flow gate', () => {
    it('passes for non-injection CWE without source/sink', () => {
      const candidate: FindingCandidate = {
        cwe: 'CWE-798',
        entityIds: [],
        title: 'Hardcoded credentials',
      };

      const result = gates.verify(candidate);
      expect(result.gateResults.data_flow.passed).to.equal(true);
      expect(result.gateResults.data_flow.reason).to.include('not required');
    });

    it('fails for injection CWE when source/sink are missing', () => {
      const candidate: FindingCandidate = {
        cwe: 'CWE-89',
        entityIds: [],
        title: 'SQL injection',
      };

      const result = gates.verify(candidate);
      expect(result.gateResults.data_flow.passed).to.equal(false);
    });

    it('passes for injection CWE when a source-to-sink path exists', () => {
      const sourceId = generateCanonicalId('source', { name: 'request.query.id' });
      const sinkId = generateCanonicalId('sink', { lineNumber: 55, name: 'db.query' });

      graph.addEntity(
        entity(
          'source',
          'request.query.id',
          { fileCanonicalId: generateCanonicalId('file', { path: 'src/api/user.ts' }), lineNumber: 20 },
          0.95,
          sourceId,
        ),
      );
      graph.addEntity(
        entity(
          'sink',
          'db.query',
          {
            fileCanonicalId: generateCanonicalId('file', { path: 'src/db/user-repo.ts' }),
            filePath: 'src/db/user-repo.ts',
            lineNumber: 55,
          },
          0.95,
          sinkId,
        ),
      );
      graph.addEdge('flows_to', sourceId, sinkId, { confidence: 0.9 });

      const candidate: FindingCandidate = {
        cwe: 'CWE-89',
        entityIds: [sinkId],
        sinkId,
        sourceId,
        title: 'SQL injection path from request to query',
        toolRunRefs: [
          {
            timestamp: new Date().toISOString(),
            toolCallId: 'toolcall02',
            toolName: 'codeql',
            truncated: false,
          },
        ],
      };

      const result = gates.verify(candidate);
      expect(result.gateResults.data_flow.passed).to.equal(true);
    });

    it('fails for injection CWE when source and sink exist but no path connects them', () => {
      const sourceId = generateCanonicalId('source', { name: 'request.query.param' });
      const sinkId = generateCanonicalId('sink', { lineNumber: 55, name: 'db.query' });

      graph.addEntity(
        entity(
          'source',
          'request.query.param',
          { fileCanonicalId: generateCanonicalId('file', { path: 'src/api/user.ts' }), lineNumber: 20 },
          0.95,
          sourceId,
        ),
      );
      graph.addEntity(
        entity(
          'sink',
          'db.query',
          {
            fileCanonicalId: generateCanonicalId('file', { path: 'src/db/user-repo.ts' }),
            filePath: 'src/db/user-repo.ts',
            lineNumber: 55,
          },
          0.95,
          sinkId,
        ),
      );
      // Deliberately no edge between source and sink.

      const candidate: FindingCandidate = {
        cwe: 'CWE-89',
        entityIds: [sinkId],
        sinkId,
        sourceId,
        title: 'SQL injection with no connecting data-flow path',
      };

      const result = gates.verify(candidate);
      expect(result.gateResults.data_flow.passed).to.equal(false);
      expect(result.gateResults.data_flow.reason).to.include('No path found');
    });
  });

  describe('assumptions and truncation gates', () => {
    it('preserves explicit assumptions in verification result', () => {
      const candidate: FindingCandidate = {
        assumptions: ['User input originates from HTTP request body'],
        cwe: 'CWE-79',
        entityIds: [],
        title: 'Assumption test',
        toolRunRefs: [
          {
            timestamp: new Date().toISOString(),
            toolCallId: 'toolcall_assumption',
            toolName: 'scanner',
            truncated: false,
          },
        ],
      };

      const result = gates.verify(candidate);
      expect(result.gateResults.assumptions_flagged.passed).to.equal(true);
      expect(result.assumptions).to.include('User input originates from HTTP request body');
    });

    it('flags truncated tool output as incomplete coverage warning', () => {
      const candidate: FindingCandidate = {
        cwe: 'CWE-79',
        entityIds: [],
        title: 'Truncation test',
        toolRunRefs: [
          {
            timestamp: new Date().toISOString(),
            toolCallId: 'toolcall03',
            toolName: 'scanner',
            truncated: true,
          },
        ],
      };

      const result = gates.verify(candidate);
      expect(result.gateResults.truncation_flagged.passed).to.equal(true);
      expect(result.gateResults.truncation_flagged.reason).to.include('truncated');
    });
  });

  describe('confidence and emission decision', () => {
    it('fails minimum confidence gate when evidence is absent', () => {
      const candidate: FindingCandidate = {
        cwe: 'CWE-79',
        entityIds: [],
        title: 'Low-confidence candidate',
        toolRunRefs: [],
      };

      const result = gates.verify(candidate);
      expect(result.confidence).to.be.below(CONFIDENCE_THRESHOLDS.reportInclusion);
      expect(result.gateResults.minimum_confidence.passed).to.equal(false);
      // Code evidence is absent too, which remains a hard default gate.
      expect(result.canEmit).to.equal(false);
      expect(result.failedGates).to.include('code_evidence');
    });

    it('allows emission when required gates pass with sufficient confidence', () => {
      const sourceId = generateCanonicalId('source', { name: 'request.body.q' });
      const sinkId = generateCanonicalId('sink', { lineNumber: 88, name: 'dangerousExec' });

      graph.addEntity(
        entity(
          'source',
          'request.body.q',
          { fileCanonicalId: generateCanonicalId('file', { path: 'src/http.ts' }), lineNumber: 15 },
          0.95,
          sourceId,
        ),
      );
      graph.addEntity(
        entity(
          'sink',
          'dangerousExec',
          {
            codeSnippet: 'exec(userControlled)',
            fileCanonicalId: generateCanonicalId('file', { path: 'src/system.ts' }),
            filePath: 'src/system.ts',
            lineNumber: 88,
          },
          0.95,
          sinkId,
        ),
      );
      graph.addEdge('flows_to', sourceId, sinkId, { confidence: 0.95 });

      const candidate: FindingCandidate = {
        cwe: 'CWE-78',
        entityIds: [sinkId],
        sinkId,
        sourceId,
        title: 'Command injection path is reachable',
        toolRunRefs: [
          {
            timestamp: new Date().toISOString(),
            toolCallId: 'toolcall04',
            toolName: 'codeql',
            truncated: false,
          },
        ],
      };

      const result = gates.verify(candidate);
      expect(result.gateResults.code_evidence.passed).to.equal(true);
      expect(result.gateResults.data_flow.passed).to.equal(true);
      expect(result.gateResults.minimum_confidence.passed).to.equal(true);
      expect(result.canEmit).to.equal(true);
    });
  });

  describe('contradiction gate', () => {
    it('blocks emission when an entity is marked both vulnerable and protected', () => {
      const protectedEntityId = generateCanonicalId('file', { path: 'src/route.ts' });
      const attackerId = generateCanonicalId('source', { name: 'attacker_input' });
      const guardId = generateCanonicalId('credential', { name: 'rate_limiter' });

      graph.addEntity(entity('file', 'src/route.ts', {}, 0.9, protectedEntityId));
      graph.addEntity(entity('source', 'attacker_input', {}, 0.9, attackerId));
      graph.addEntity(entity('credential', 'rate_limiter', {}, 0.9, guardId));

      graph.addEdge('exploits', attackerId, protectedEntityId, { confidence: 0.85 });
      graph.addEdge('guards', guardId, protectedEntityId, { confidence: 0.85 });

      const candidate: FindingCandidate = {
        cwe: 'CWE-79',
        entityIds: [protectedEntityId],
        title: 'Contradictory XSS finding',
        toolRunRefs: [],
      };

      const result = gates.verify(candidate);
      expect(result.gateResults.no_contradictions.passed).to.equal(false);
      expect(result.canEmit).to.equal(false);
      expect(result.failedGates).to.include('no_contradictions');
    });
  });

  describe('minimum confidence gate opt-in', () => {
    it('lets low-confidence candidates pass by default and emit when no hard gate fails', () => {
      // Mirror the production policy: evidence gates advisory, contradictions hard.
      const advisoryGates = new VerificationGates(graph, {
        requireCodeEvidence: false,
        requireDataFlow: false,
      });
      const sinkId = generateCanonicalId('sink', { lineNumber: 42, name: 'exec' });
      graph.addEntity(
        entity(
          'sink',
          'exec',
          {
            codeSnippet: 'exec(userInput)',
            fileCanonicalId: generateCanonicalId('file', { path: 'src/cmd.ts' }),
            lineNumber: 42,
          },
          0.95,
          sinkId,
        ),
      );

      const candidate: FindingCandidate = {
        cwe: 'CWE-78',
        entityIds: [sinkId],
        title: 'Command injection with minimal evidence',
        toolRunRefs: [],
      };

      const result = advisoryGates.verify(candidate);
      expect(result.confidence).to.be.below(CONFIDENCE_THRESHOLDS.reportInclusion);
      expect(result.gateResults.minimum_confidence.passed).to.equal(false);
      // Advisory-only by default: evidence-linked finding still emits.
      expect(result.canEmit).to.equal(true);
    });

    it('blocks emission when requireMinimumConfidence is enabled', () => {
      const strictGates = new VerificationGates(graph, { requireMinimumConfidence: true });
      const sinkId = generateCanonicalId('sink', { lineNumber: 7, name: 'eval' });
      graph.addEntity(
        entity(
          'sink',
          'eval',
          {
            codeSnippet: 'eval(userInput)',
            fileCanonicalId: generateCanonicalId('file', { path: 'src/evil.ts' }),
            lineNumber: 7,
          },
          0.95,
          sinkId,
        ),
      );

      const candidate: FindingCandidate = {
        cwe: 'CWE-95',
        entityIds: [sinkId],
        title: 'Eval injection with minimal evidence',
        toolRunRefs: [],
      };

      const result = strictGates.verify(candidate);
      expect(result.gateResults.minimum_confidence.passed).to.equal(false);
      expect(result.canEmit).to.equal(false);
      expect(result.failedGates).to.include('minimum_confidence');
    });
  });

  describe('minimum evidence helper', () => {
    it('returns true when entities are linked', () => {
      expect(
        gates.hasMinimumEvidence({
          cwe: 'CWE-79',
          entityIds: [generateCanonicalId('function', { name: 'renderUnsafe' })],
          title: 'Finding with entity evidence',
        }),
      ).to.equal(true);
    });

    it('returns true when tool runs are linked', () => {
      expect(
        gates.hasMinimumEvidence({
          cwe: 'CWE-79',
          title: 'Finding with tool evidence',
          toolRunRefs: [
            {
              timestamp: new Date().toISOString(),
              toolCallId: 'toolcall05',
              toolName: 'semgrep',
              truncated: false,
            },
          ],
        }),
      ).to.equal(true);
    });

    it('returns false with no linked entities or tool runs', () => {
      expect(
        gates.hasMinimumEvidence({
          cwe: 'CWE-79',
          title: 'No evidence',
        }),
      ).to.equal(false);
    });
  });
});
