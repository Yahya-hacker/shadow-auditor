/**
 * Hybrid Retriever tests.
 */

import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { HybridRetriever } from '../src/core/memory/hybrid-retriever.js';
import { KnowledgeGraph } from '../src/core/memory/knowledge-graph.js';
import { Retrieval } from '../src/core/memory/retrieval.js';
import {
  NullEmbeddingProvider,
  SemanticIndex,
} from '../src/core/memory/semantic-index.js';

describe('HybridRetriever', () => {
  let tmpDir: string;
  let repoDir: string;
  let storageDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hr-test-'));
    repoDir = path.join(tmpDir, 'repo');
    storageDir = path.join(tmpDir, 'storage');
    await fs.mkdir(repoDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { force: true, recursive: true });
  });

  async function writeFile(relativePath: string, content: string): Promise<void> {
    const fullPath = path.join(repoDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf8');
  }

  async function createRetriever(): Promise<{
    graph: KnowledgeGraph;
    retrieval: Retrieval;
    retriever: HybridRetriever;
    semanticIndex: SemanticIndex;
  }> {
    // Create semantic index
    const semanticIndex = new SemanticIndex({
      provider: new NullEmbeddingProvider(64),
      rootPath: repoDir,
      storagePath: path.join(storageDir, 'semantic'),
    });
    await semanticIndex.initialize();

    // Create knowledge graph
    const graph = await KnowledgeGraph.create({
      runId: 'test-run-001',
      storagePath: path.join(storageDir, 'graph'),
    });
    const retrieval = new Retrieval(graph);

    // Create hybrid retriever
    const retriever = new HybridRetriever(
      graph,
      retrieval,
      semanticIndex,
      { rootPath: repoDir },
    );

    return { graph, retrieval, retriever, semanticIndex };
  }

  describe('multi-strategy search', () => {
    it('should return results from semantic strategy', async () => {
      await writeFile('src/auth.ts', `
export function validateToken(token: string): boolean {
  return token.startsWith('Bearer ');
}

export function hashPassword(password: string): string {
  return password; // INSECURE
}
`);

      const { retriever, semanticIndex } = await createRetriever();
      await semanticIndex.indexRepository();

      const results = await retriever.search('token validation', {
        strategies: ['semantic'],
      });

      expect(results.length).to.be.greaterThan(0);
      expect(results[0].provenance.some((p) => p.strategy === 'semantic')).to.be.true;
    });

    it('should return results from lexical strategy', async () => {
      await writeFile('src/db.ts', `
export function executeQuery(sql: string): void {
  // Direct SQL execution without parameterization
  db.query(sql);
}
`);

      const { retriever, semanticIndex } = await createRetriever();
      await semanticIndex.indexRepository();

      const results = await retriever.search('SQL query parameterization', {
        strategies: ['lexical'],
      });

      expect(results.length).to.be.greaterThan(0);
      expect(results[0].provenance.some((p) => p.strategy === 'lexical')).to.be.true;
    });

    it('should fuse results from multiple strategies', async () => {
      await writeFile('src/api.ts', `
export function processUserInput(input: string): string {
  // No sanitization applied
  return eval(input);
}
`);

      const { retriever, semanticIndex } = await createRetriever();
      await semanticIndex.indexRepository();

      const results = await retriever.search('user input eval injection');

      // Results should exist and have fused scores
      expect(results.length).to.be.greaterThan(0);
      for (const result of results) {
        expect(result.fusedScore).to.be.greaterThan(0);
      }
    });
  });

  describe('Reciprocal Rank Fusion', () => {
    it('should boost results found by multiple strategies', async () => {
      await writeFile('src/vuln.ts', `
export function unsafeEval(code: string): unknown {
  return eval(code);
}

export function safeCompute(x: number): number {
  return x * 2;
}
`);

      const { retriever, semanticIndex } = await createRetriever();
      await semanticIndex.indexRepository();

      const results = await retriever.search('eval code injection vulnerability');

      if (results.length > 1) {
        // Results should be sorted by fused score descending
        for (let i = 0; i < results.length - 1; i++) {
          expect(results[i].fusedScore).to.be.greaterThanOrEqual(results[i + 1].fusedScore);
        }
      }
    });

    it('should respect maxResults limit', async () => {
      // Create many files
      for (let i = 0; i < 10; i++) {
        await writeFile(`src/mod${i}.ts`, `export function func${i}() { return ${i}; }`);
      }

      const { retriever, semanticIndex } = await createRetriever();
      await semanticIndex.indexRepository();

      const results = await retriever.search('function', { maxResults: 3 });
      expect(results.length).to.be.lessThanOrEqual(3);
    });
  });

  describe('strategy weights', () => {
    it('should allow customizing strategy weights', async () => {
      await writeFile('src/test.ts', `
export function testFunc(): void {
  console.log('test');
}
`);

      const semanticIndex = new SemanticIndex({
        provider: new NullEmbeddingProvider(64),
        rootPath: repoDir,
        storagePath: path.join(storageDir, 'semantic'),
      });
      await semanticIndex.initialize();
      await semanticIndex.indexRepository();

      const graph = await KnowledgeGraph.create({
        runId: 'test-run-002',
        storagePath: path.join(storageDir, 'graph2'),
      });
      const retrieval = new Retrieval(graph);

      // Create retriever with heavy semantic weight
      const retriever = new HybridRetriever(
        graph,
        retrieval,
        semanticIndex,
        {
          rootPath: repoDir,
          weights: { graph: 0.1, lexical: 0.1, semantic: 0.8 },
        },
      );

      const results = await retriever.search('test function');
      expect(results.length).to.be.greaterThan(0);
    });
  });

  describe('file filtering', () => {
    it('should filter results by file path', async () => {
      await writeFile('src/controllers/auth.ts', 'export function login() {}');
      await writeFile('src/services/math.ts', 'export function add() {}');

      const { retriever, semanticIndex } = await createRetriever();
      await semanticIndex.indexRepository();

      const results = await retriever.search('function', {
        fileFilter: 'controllers',
        strategies: ['semantic', 'lexical'],
      });

      // All results should be from the controllers directory
      for (const result of results) {
        if (result.filePath) {
          expect(result.filePath).to.include('controllers');
        }
      }
    });
  });

  describe('deduplication', () => {
    it('should deduplicate results across strategies', async () => {
      await writeFile('src/unique.ts', `
export function uniqueFunction(): string {
  return 'unique';
}
`);

      const { retriever, semanticIndex } = await createRetriever();
      await semanticIndex.indexRepository();

      const results = await retriever.search('unique function');

      // Check no duplicate file:line entries
      const dedupKeys = new Set<string>();
      for (const result of results) {
        const key = `${result.filePath}:${result.lineRange?.start}`;
        expect(dedupKeys.has(key)).to.be.false;
        dedupKeys.add(key);
      }
    });
  });

  describe('error handling', () => {
    it('should handle empty index gracefully', async () => {
      const { retriever } = await createRetriever();

      const results = await retriever.search('nonexistent query');
      expect(results).to.be.an('array');
    });
  });
});
