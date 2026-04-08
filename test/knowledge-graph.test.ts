import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { BaseEntity, EntityType } from '../src/core/memory/memory-schema.js';

import { generateCanonicalId } from '../src/core/memory/entity-normalizer.js';
import { KnowledgeGraph } from '../src/core/memory/knowledge-graph.js';

describe('knowledge graph', () => {
  let graph: KnowledgeGraph;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kg-test-'));
    graph = await KnowledgeGraph.create({
      runId: 'test_run_001',
      storagePath: tempDir,
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  // eslint-disable-next-line unicorn/consistent-function-scoping, max-params
  function makeEntity(
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

  describe('entity management', () => {
    it('adds entities and returns them by canonical ID', () => {
      const entity = makeEntity('file', 'auth.ts', { path: 'src/auth.ts' });
      const addResult = graph.addEntity(entity);

      expect(addResult.isNew).to.equal(true);
      const retrieved = graph.getEntity(entity.canonicalId);
      expect(retrieved).to.not.equal(undefined);
      expect(retrieved?.label).to.equal('auth.ts');
    });

    it('deduplicates entities by canonical ID and merges properties/confidence', () => {
      const canonicalId = generateCanonicalId('file', { path: 'src/auth.ts' });
      const oldEntity = makeEntity('file', 'auth.ts', { path: 'src/auth.ts' }, 0.4, canonicalId);
      const newEntity = makeEntity(
        'file',
        'auth.ts',
        { language: 'typescript', path: 'src/auth.ts' },
        0.9,
        canonicalId,
      );

      const first = graph.addEntity(oldEntity);
      const second = graph.addEntity(newEntity);

      expect(first.isNew).to.equal(true);
      expect(second.isNew).to.equal(false);

      const allFiles = graph.getEntitiesByType('file');
      expect(allFiles).to.have.length(1);
      expect(allFiles[0].confidence).to.equal(0.9);
      expect((allFiles[0].properties as Record<string, unknown>).language).to.equal('typescript');
    });

    it('indexes entities by type', () => {
      graph.addEntity(makeEntity('file', 'a.ts', { path: 'src/a.ts' }));
      graph.addEntity(makeEntity('function', 'validateInput'));
      graph.addEntity(makeEntity('function', 'sanitizeInput'));

      expect(graph.getEntitiesByType('file')).to.have.length(1);
      expect(graph.getEntitiesByType('function')).to.have.length(2);
    });
  });

  describe('edge management', () => {
    let fileId: string;
    let functionAId: string;
    let functionBId: string;

    beforeEach(() => {
      fileId = generateCanonicalId('file', { path: 'src/auth.ts' });
      functionAId = generateCanonicalId('function', { lineStart: 10, name: 'validateUser' });
      functionBId = generateCanonicalId('function', { lineStart: 30, name: 'checkPassword' });

      graph.addEntity(makeEntity('file', 'auth.ts', { path: 'src/auth.ts' }, 0.9, fileId));
      graph.addEntity(makeEntity('function', 'validateUser', {}, 0.9, functionAId));
      graph.addEntity(makeEntity('function', 'checkPassword', {}, 0.9, functionBId));
    });

    it('adds edges between existing entities', () => {
      const edge = graph.addEdge('contains', fileId, functionAId);
      expect(edge.ok).to.equal(true);

      const outbound = graph.getOutboundEdges(fileId);
      expect(outbound).to.have.length(1);
      expect(outbound[0].edgeType).to.equal('contains');
      expect(outbound[0].sourceEntityId).to.equal(fileId);
      expect(outbound[0].targetEntityId).to.equal(functionAId);
    });

    it('updates existing edge instead of duplicating', () => {
      const first = graph.addEdge('calls', functionAId, functionBId, { confidence: 0.2 });
      const second = graph.addEdge('calls', functionAId, functionBId, { confidence: 0.8 });

      expect(first.ok).to.equal(true);
      expect(second.ok).to.equal(true);

      const outbound = graph.getOutboundEdges(functionAId, 'calls');
      expect(outbound).to.have.length(1);
      expect(outbound[0].confidence).to.equal(0.8);
    });

    it('supports multiple edge types between the same entities', () => {
      graph.addEdge('calls', functionAId, functionBId);
      graph.addEdge('depends_on', functionAId, functionBId);

      const outbound = graph.getOutboundEdges(functionAId);
      expect(outbound).to.have.length(2);
      expect(outbound.map((edge) => edge.edgeType)).to.include.members(['calls', 'depends_on']);
    });

    it('returns an error when source or target does not exist', () => {
      const result = graph.addEdge('calls', functionAId, generateCanonicalId('function', { name: 'missing' }));
      expect(result.ok).to.equal(false);
    });
  });

  describe('traversal and path finding', () => {
    let sourceId: string;
    let processId: string;
    let transformId: string;
    let sinkId: string;

    beforeEach(() => {
      sourceId = generateCanonicalId('source', { name: 'request.body.email' });
      processId = generateCanonicalId('function', { lineStart: 20, name: 'processInput' });
      transformId = generateCanonicalId('function', { lineStart: 35, name: 'transformInput' });
      sinkId = generateCanonicalId('sink', { lineNumber: 50, name: 'db.query' });

      graph.addEntity(makeEntity('source', 'request.body.email', {}, 0.95, sourceId));
      graph.addEntity(makeEntity('function', 'processInput', {}, 0.95, processId));
      graph.addEntity(makeEntity('function', 'transformInput', {}, 0.95, transformId));
      graph.addEntity(makeEntity('sink', 'db.query', {}, 0.95, sinkId));

      graph.addEdge('flows_to', sourceId, processId);
      graph.addEdge('calls', processId, transformId);
      graph.addEdge('flows_to', transformId, sinkId);
    });

    it('traverses outbound graph with depth limits', () => {
      const oneHop = graph.traverse(sourceId, { direction: 'outbound', maxDepth: 1 });
      expect(oneHop.map((entity) => entity.canonicalId)).to.not.include(sinkId);

      const fullPath = graph.traverse(sourceId, { direction: 'outbound', maxDepth: 3 });
      expect(fullPath.map((entity) => entity.canonicalId)).to.include.members([
        sourceId,
        processId,
        transformId,
        sinkId,
      ]);
    });

    it('traverses inbound graph', () => {
      const inbound = graph.traverse(sinkId, { direction: 'inbound', maxDepth: 3 });
      expect(inbound.map((entity) => entity.canonicalId)).to.include.members([
        sinkId,
        transformId,
        processId,
        sourceId,
      ]);
    });

    it('filters traversal by edge type', () => {
      const dataFlowOnly = graph.traverse(sourceId, {
        direction: 'outbound',
        edgeTypes: ['flows_to'],
        maxDepth: 3,
      });

      expect(dataFlowOnly.map((entity) => entity.canonicalId)).to.deep.equal([
        sourceId,
        processId,
      ]);
    });

    it('finds explicit paths between source and sink', () => {
      const paths = graph.findPaths(sourceId, sinkId, 4);
      expect(paths).to.have.length(1);
      expect(paths[0].entities.map((entity) => entity.canonicalId)).to.deep.equal([
        sourceId,
        processId,
        transformId,
        sinkId,
      ]);
      expect(paths[0].edges.map((edge) => edge.edgeType)).to.deep.equal([
        'flows_to',
        'calls',
        'flows_to',
      ]);
    });
  });

  describe('query and persistence', () => {
    it('queries by type, confidence, label, and properties', () => {
      graph.addEntity(makeEntity('vulnerability', 'SQL Injection', { cwe: 'CWE-89' }, 0.95));
      graph.addEntity(makeEntity('vulnerability', 'Reflected XSS', { cwe: 'CWE-79' }, 0.8));
      graph.addEntity(makeEntity('vulnerability', 'Info Leak', { cwe: 'CWE-200' }, 0.2));

      const highConfidence = graph.query({ entityType: 'vulnerability', minConfidence: 0.8 });
      expect(highConfidence).to.have.length(2);

      const sqlByLabel = graph.query({ entityType: 'vulnerability', labelContains: 'sql' });
      expect(sqlByLabel).to.have.length(1);
      expect(sqlByLabel[0].label).to.equal('SQL Injection');

      const byCwe = graph.query({
        entityType: 'vulnerability',
        propertyMatches: { cwe: 'CWE-79' },
      });
      expect(byCwe).to.have.length(1);
      expect(byCwe[0].label).to.equal('Reflected XSS');
    });

    it('saves and restores graph snapshots', async () => {
      const fileId = generateCanonicalId('file', { path: 'src/app.ts' });
      const functionId = generateCanonicalId('function', { lineStart: 12, name: 'main' });

      graph.addEntity(makeEntity('file', 'app.ts', { path: 'src/app.ts' }, 0.9, fileId));
      graph.addEntity(makeEntity('function', 'main', {}, 0.9, functionId));
      graph.addEdge('contains', fileId, functionId);

      await graph.saveSnapshot();

      const reloaded = await KnowledgeGraph.create({
        runId: 'test_run_001',
        storagePath: tempDir,
      });

      expect(reloaded.getEntity(fileId)?.label).to.equal('app.ts');
      expect(reloaded.getOutboundEdges(fileId, 'contains')).to.have.length(1);

      const stats = reloaded.stats();
      expect(stats.entityCount).to.equal(2);
      expect(stats.edgeCount).to.equal(1);
    });
  });
});
