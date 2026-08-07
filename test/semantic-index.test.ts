/**
 * Semantic Index tests.
 */

import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { EmbeddingProvider } from '../src/core/memory/semantic-index.js';

import { KnowledgeGraph } from '../src/core/memory/knowledge-graph.js';
import {
  NullEmbeddingProvider,
  SemanticIndex,
} from '../src/core/memory/semantic-index.js';
import { populateIndexKnowledgeGraph } from '../src/core/services/semantic-index-initializer.js';

class CountingEmbeddingProvider implements EmbeddingProvider {
  readonly dimension = 2;
  fail = false;
  readonly fingerprint = 'counting:v1:2';
  readonly name = 'counting';
  textsEmbedded = 0;

  async embed(texts: string[]): Promise<number[][]> {
    if (this.fail) throw new Error('Embedding provider unavailable');
    this.textsEmbedded += texts.length;
    return texts.map(() => [1, 0]);
  }
}

class BlockingEmbeddingProvider implements EmbeddingProvider {
  readonly dimension = 2;
  readonly fingerprint = 'blocking:v1:2';
  readonly name = 'blocking';

  async embed(_texts: string[], signal?: AbortSignal): Promise<number[][]> {
    signal?.throwIfAborted();
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), {once: true});
    });
  }
}

class RankingEmbeddingProvider implements EmbeddingProvider {
  readonly dimension = 2;
  readonly fingerprint = 'ranking:v1:2';
  readonly name = 'ranking';

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      if (text === 'find vulnerability') return [1, 0];
      if (text.includes('globally-strong')) return [1, 0];
      return [0.5, Math.sqrt(0.75)];
    });
  }
}

describe('SemanticIndex', () => {
  let tmpDir: string;
  let storageDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'si-test-'));
    storageDir = path.join(tmpDir, 'storage');
    repoDir = path.join(tmpDir, 'repo');
    await fs.mkdir(repoDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { force: true, recursive: true });
  });

  function writeFile(relativePath: string, content: string): Promise<void> {
    const fullPath = path.join(repoDir, relativePath);
    return fs.mkdir(path.dirname(fullPath), { recursive: true }).then(() =>
      fs.writeFile(fullPath, content, 'utf8'),
    );
  }

  async function createIndex(): Promise<SemanticIndex> {
    const index = new SemanticIndex({
      provider: new NullEmbeddingProvider(64),
      rootPath: repoDir,
      storagePath: storageDir,
    });
    await index.initialize();
    return index;
  }

  describe('chunking', () => {
    it('should chunk a file with functions', async () => {
      await writeFile('utils.ts', `
import { z } from 'zod';

export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`);
      const index = await createIndex();
      const count = await index.indexFile(path.join(repoDir, 'utils.ts'));

      expect(count).to.be.greaterThan(0);

      const chunks = index.getChunksForFile(path.join(repoDir, 'utils.ts'));
      expect(chunks.length).to.be.greaterThan(0);

      // Each function should become a separate chunk
      const functionChunks = chunks.filter((c) => c.structuralType === 'function');
      expect(functionChunks.length).to.be.greaterThanOrEqual(2);
    });

    it('should chunk a class into methods', async () => {
      await writeFile('service.ts', `
import { EventEmitter } from 'node:events';

export class SecurityService extends EventEmitter {
  private db: any;

  constructor(db: any) {
    super();
    this.db = db;
  }

  async scanFile(filePath: string): Promise<void> {
    const content = await this.db.read(filePath);
    this.emit('scan', content);
  }

  async reportVuln(title: string): Promise<void> {
    this.emit('vuln', { title });
  }
}
`);
      const index = await createIndex();
      const count = await index.indexFile(path.join(repoDir, 'service.ts'));

      expect(count).to.be.greaterThan(0);

      const chunks = index.getChunksForFile(path.join(repoDir, 'service.ts'));
      const methodChunks = chunks.filter((c) => c.structuralType === 'method');
      expect(methodChunks.length).to.be.greaterThanOrEqual(2);

      // Methods should include class context in parentContext
      for (const chunk of methodChunks) {
        expect(chunk.parentContext).to.include('SecurityService');
      }
    });

    it('uses Tree-sitter AST chunking across guaranteed production languages', async () => {
      const fixtures = [
        ['sample.c', 'int parse_input(void) { return 1; }'],
        ['Sample.cs', 'class Sample { int Scan() { return 1; } }'],
        ['sample.cpp', 'int parse_input() { return 1; }'],
        ['sample.ex', 'defmodule Audit do\n  def scan(value), do: value\nend'],
        ['sample.go', 'package audit\nfunc Scan() int { return 1 }'],
        ['sample.hs', 'scan :: Int -> Int\nscan value = value'],
        ['sample.html', '<main><h1>Security audit</h1></main>'],
        ['Sample.java', 'class Sample { int scan() { return 1; } }'],
        ['sample.js', 'export function scan() { return 1; }'],
        ['sample.json', '{"audit": {"enabled": true}}'],
        ['README.md', '# Security architecture\n\nRepository threat model.'],
        ['sample.php', '<?php function scan($value) { return $value; }'],
        ['sample.py', 'def scan(value):\n    return value'],
        ['sample.rb', 'def scan(value)\n  value\nend'],
        ['sample.rs', 'fn scan(value: i32) -> i32 { value }'],
        ['Sample.scala', 'object Sample { def scan(value: Int): Int = value }'],
        ['sample.toml', '[audit]\nenabled = true'],
        ['sample.ts', 'export function scan(value: number): number { return value; }'],
        ['sample.yaml', 'audit:\n  enabled: true'],
      ] as const;
      const index = await createIndex();

      for (const [fileName, source] of fixtures) {
        await writeFile(fileName, source);
        const filePath = path.join(repoDir, fileName);
        expect(await index.indexFile(filePath), fileName).to.be.greaterThan(0);
        expect(index.getChunksForFile(filePath), fileName).not.to.be.empty;
        expect(
          index.getIndexingDiagnostics().some((entry) => entry.filePath === filePath),
          fileName,
        ).to.equal(false);
      }
    });

    for (const size of [32_766, 32_767, 32_768, 102_400]) {
      it(`parses a ${size}-character TypeScript source on Node 24`, async () => {
        const prefix = 'export function scan() { return "';
        const suffix = '"; }';
        const source = `${prefix}${'a'.repeat(size - prefix.length - suffix.length)}${suffix}`;
        await writeFile('large.ts', source);
        const index = await createIndex();

        expect(await index.indexFile(path.join(repoDir, 'large.ts'))).to.be.greaterThan(0);
        expect(index.getIndexingDiagnostics()).to.be.empty;
      });
    }

    it('should include file imports as parent context', async () => {
      await writeFile('handler.ts', `
import express from 'express';
import { sanitize } from './sanitize';

export function handleRequest(req: express.Request): string {
  return sanitize(req.body.input);
}
`);
      const index = await createIndex();
      await index.indexFile(path.join(repoDir, 'handler.ts'));

      const chunks = index.getChunksForFile(path.join(repoDir, 'handler.ts'));
      expect(chunks.length).to.be.greaterThan(0);

      // Function chunks should have import context
      const fnChunk = chunks.find((c) => c.symbol.includes('handleRequest'));
      expect(fnChunk).to.not.be.undefined;
      expect(fnChunk!.parentContext).to.include('express');
      expect(fnChunk!.parentContext).to.include('sanitize');
    });

    it('splits oversized AST nodes without dropping their tail', async () => {
      const source = `export function large() {\n${'  const value = "payload";\n'.repeat(40)}  return "tail-marker";\n}`;
      await writeFile('large-node.ts', source);
      const index = new SemanticIndex({
        maxChunkChars: 200,
        provider: new NullEmbeddingProvider(64),
        rootPath: repoDir,
        storagePath: storageDir,
      });
      await index.initialize();
      await index.indexFile(path.join(repoDir, 'large-node.ts'));

      const chunks = index.getChunksForFile(path.join(repoDir, 'large-node.ts'));
      expect(chunks.length).to.be.greaterThan(1);
      expect(chunks.every((chunk) => chunk.rawContent.length <= 200)).to.equal(true);
      expect(chunks.some((chunk) => chunk.rawContent.includes('tail-marker'))).to.equal(true);
    });

    it('indexes meaningful top-level ranges not claimed by AST chunks', async () => {
      await writeFile('residual.ts', [
        'export function scanned() { return true; }',
        'console.log("top-level-security-marker");',
      ].join('\n'));
      const index = await createIndex();
      await index.indexFile(path.join(repoDir, 'residual.ts'));

      const chunks = index.getChunksForFile(path.join(repoDir, 'residual.ts'));
      expect(chunks.some((chunk) =>
        chunk.structuralType === 'file_fragment' &&
        chunk.rawContent.includes('top-level-security-marker'),
      )).to.equal(true);
    });

    it('re-embeds unchanged source blocks when their semantic context changes', async () => {
      const filePath = path.join(repoDir, 'context.ts');
      const provider = new CountingEmbeddingProvider();
      await writeFile('context.ts', [
        'import { sanitize } from "./safe.js";',
        'export function handle(value: string) { return sanitize(value); }',
      ].join('\n'));
      const index = new SemanticIndex({provider, rootPath: repoDir, storagePath: storageDir});
      await index.initialize();
      await index.indexFile(filePath);
      const firstEmbeddingCount = provider.textsEmbedded;

      await writeFile('context.ts', [
        'import { sanitize } from "./unsafe.js";',
        'export function handle(value: string) { return sanitize(value); }',
      ].join('\n'));
      await index.indexFile(filePath);

      expect(provider.textsEmbedded).to.be.greaterThan(firstEmbeddingCount);
    });

    it('should handle empty files gracefully', async () => {
      await writeFile('empty.ts', '');
      const index = await createIndex();
      const count = await index.indexFile(path.join(repoDir, 'empty.ts'));
      expect(count).to.equal(0);
    });

    describe('search filtering', () => {
      it('applies file filtering before top-K ranking', async () => {
        await writeFile('unrelated.ts', 'export const marker = "globally-strong";');
        await writeFile('controllers/target.ts', 'export const marker = "filtered-target";');
        const index = new SemanticIndex({
          provider: new RankingEmbeddingProvider(),
          rootPath: repoDir,
          storagePath: storageDir,
        });
        await index.initialize();
        await index.indexRepository();

        const results = await index.search('find vulnerability', {
          fileFilter: 'controllers',
          minScore: -1,
          topK: 1,
        });

        expect(results).to.have.length(1);
        expect(results[0]!.chunk.filePath).to.include('controllers');
      });
    });

    it('removes stale chunks when an indexed file becomes empty', async () => {
      await writeFile('emptied.ts', 'export const value = 1;');
      const filePath = path.join(repoDir, 'emptied.ts');
      const index = await createIndex();
      expect(await index.indexFile(filePath)).to.be.greaterThan(0);
      expect(index.getChunksForFile(filePath)).not.to.be.empty;

      await fs.writeFile(filePath, '');
      expect(await index.indexFile(filePath)).to.equal(0);
      expect(index.getChunksForFile(filePath)).to.be.empty;
    });

    it('indexes Markdown files with the bundled grammar', async () => {
      await writeFile('readme.md', '# Hello');
      const index = await createIndex();
      const count = await index.indexFile(path.join(repoDir, 'readme.md'));
      expect(count).to.be.greaterThan(0);
      expect(index.getChunksForFile(path.join(repoDir, 'readme.md'))).not.to.be.empty;
    });

    it('counts bundled Markdown grammar files as indexed', async () => {
      await writeFile('README.md', '# Security architecture');
      const index = await createIndex();

      const stats = await index.indexRepository();

      expect(stats).to.include({
        filesDiscovered: 1,
        filesIndexed: 1,
        filesSkipped: 0,
      });
      expect(index.getIndexingDiagnostics()).to.be.empty;
    });

    it('keeps recognized languages lexically indexable when an optional grammar is unavailable', async () => {
      const filePath = path.join(repoDir, 'query.sql');
      await writeFile('query.sql', 'SELECT password FROM users;');
      const index = await createIndex();

      expect(await index.indexFile(filePath)).to.be.greaterThan(0);
      expect(await index.indexFile(filePath)).to.be.greaterThan(0);
      expect(index.getChunksForFile(filePath)).not.to.be.empty;
      const diagnostic = index.getIndexingDiagnostics().find((entry) => entry.filePath === filePath);
      expect(diagnostic?.reason).to.match(
        /^Tree-sitter grammar "sql" (?:unavailable|failed \(.+\)); indexed with whole-file lexical chunks$/,
      );
    });
  });

  describe('indexing', () => {
    it('populates the production knowledge graph from indexed AST chunks', async () => {
      await writeFile('repository.ts', `
export function loadUser(id: string): string {
  return id;
}
`);
      await writeFile('service.ts', `
import { loadUser } from './repository.js';
export class UserService {
  findUser(id: string): string {
    return loadUser(id);
  }
}
`);
      await writeFile('unrelated.ts', `
export function unresolvedReference(id: string): string {
  return loadUser(id);
}
`);
      const index = await createIndex();
      await index.indexRepository();
      const graph = await KnowledgeGraph.create({
        runId: 'graph-population-test',
        storagePath: path.join(tmpDir, 'graph'),
      });

      await populateIndexKnowledgeGraph(graph, index, repoDir);

      const files = graph.getEntitiesByType('file');
      const functions = graph.getEntitiesByType('function');
      const classes = graph.getEntitiesByType('class');
      const chunks = graph.getEntitiesByType('chunk');
      expect(files.some((entity) => entity.properties.path === 'service.ts')).to.equal(true);
      expect(functions.some((entity) => entity.label === 'UserService.findUser')).to.equal(true);
      expect(classes.some((entity) => entity.label === 'export UserService')).to.equal(true);
      expect(chunks).not.to.be.empty;
      expect(graph.getEdges().some((edge) => edge.edgeType === 'contains')).to.equal(true);
      expect(graph.getEdges().some((edge) => edge.edgeType === 'embeds')).to.equal(true);
      expect(graph.getEdges().some((edge) => edge.edgeType === 'depends_on')).to.equal(true);
      const callEdges = graph.getEdges().filter((edge) => edge.edgeType === 'calls');
      expect(callEdges).to.have.length(1);
      expect(graph.getEntity(callEdges[0].sourceEntityId)?.label).to.equal('UserService.findUser');
      expect(graph.getEntity(callEdges[0].targetEntityId)?.label).to.equal('export loadUser');

      const restored = await KnowledgeGraph.create({
        runId: 'graph-population-test',
        storagePath: path.join(tmpDir, 'graph'),
      });
      expect(restored.getEntitiesByType('function')
        .some((entity) => entity.label === 'UserService.findUser'))
        .to.equal(true);
    });

    it('does not guess between ambiguous same-file call targets', async () => {
      await writeFile('ambiguous.ts', `
class First {
  get(): number { return 1; }
}
class Second {
  get(): number { return 2; }
  run(): number { return this.get(); }
}
`);
      const index = await createIndex();
      await index.indexRepository();
      const graph = await KnowledgeGraph.create({
        runId: 'ambiguous-call-test',
        storagePath: path.join(tmpDir, 'ambiguous-graph'),
      });

      await populateIndexKnowledgeGraph(graph, index, repoDir);

      const run = graph.getEntitiesByType('function')
        .find((entity) => entity.label === 'Second.run');
      expect(run).not.to.equal(undefined);
      expect(graph.getOutboundEdges(run!.canonicalId)
        .filter((edge) => edge.edgeType === 'calls')).to.be.empty;
    });

    it('resolves local C header dependencies and calls', async () => {
      await writeFile('native/helper.h', 'int helper(void) { return 1; }\n');
      await writeFile('native/main.c', `
#include "helper.h"
int main(void) { return helper(); }
`);
      const index = await createIndex();
      await index.indexRepository();
      const graph = await KnowledgeGraph.create({
        runId: 'c-header-dependency-test',
        storagePath: path.join(tmpDir, 'c-header-graph'),
      });

      await populateIndexKnowledgeGraph(graph, index, repoDir);

      const dependencyEdge = graph.getEdges().find((edge) => edge.edgeType === 'depends_on');
      expect(
        dependencyEdge,
        'missing local C header dependency edge',
      ).not.to.equal(undefined);
      expect(graph.getEntity(dependencyEdge!.sourceEntityId)?.properties.path).to.equal('native/main.c');
      expect(graph.getEntity(dependencyEdge!.targetEntityId)?.properties.path).to.equal('native/helper.h');
      const callEdge = graph.getEdges().find((edge) => edge.edgeType === 'calls');
      expect(callEdge, 'missing C call edge').not.to.equal(undefined);
      expect(graph.getEntity(callEdge!.sourceEntityId)?.label).to.equal('main');
      expect(graph.getEntity(callEdge!.targetEntityId)?.label).to.equal('helper');
    });

    it('should index an entire repository', async () => {
      await writeFile('src/a.ts', 'export function alpha() { return 1; }');
      await writeFile('src/b.ts', 'export function beta() { return 2; }');
      await writeFile('src/c.js', 'export function gamma() { return 3; }');

      const index = await createIndex();
      const { chunksIndexed, filesIndexed } = await index.indexRepository();

      expect(filesIndexed).to.equal(3);
      expect(chunksIndexed).to.be.greaterThanOrEqual(3);
    });

    it('should skip node_modules and dist', async () => {
      await writeFile('src/app.ts', 'export function app() {}');
      await writeFile('node_modules/dep/index.ts', 'export function dep() {}');
      await writeFile('dist/out.js', 'export function out() {}');

      const index = await createIndex();
      const { filesIndexed } = await index.indexRepository();

      expect(filesIndexed).to.equal(1);
    });

    it('should support incremental re-indexing', async () => {
      await writeFile('src/app.ts', 'export function v1() { return 1; }');

      const index = await createIndex();
      await index.indexFile(path.join(repoDir, 'src/app.ts'));
      let chunks = index.getChunksForFile(path.join(repoDir, 'src/app.ts'));
      expect(chunks.some((c) => c.symbol.includes('v1'))).to.be.true;

      // Update file content
      await writeFile('src/app.ts', 'export function v2() { return 2; }');
      await index.indexFile(path.join(repoDir, 'src/app.ts'));
      chunks = index.getChunksForFile(path.join(repoDir, 'src/app.ts'));

      // Old chunks should be replaced
      expect(chunks.some((c) => c.symbol.includes('v1'))).to.be.false;
      expect(chunks.some((c) => c.symbol.includes('v2'))).to.be.true;
    });

    it('embeds only changed chunks when unchanged functions move', async () => {
      const provider = new CountingEmbeddingProvider();
      const filePath = path.join(repoDir, 'src/moved.ts');
      await writeFile('src/moved.ts', [
        'export function stable() { return "stable"; }',
        'export function changed() { return 1; }',
      ].join('\n'));
      const index = new SemanticIndex({provider, rootPath: repoDir, storagePath: storageDir});
      await index.initialize();
      await index.indexFile(filePath);
      const initialEmbeddings = provider.textsEmbedded;

      await writeFile('src/moved.ts', [
        '',
        'export function stable() { return "stable"; }',
        'export function changed() { return 2; }',
      ].join('\n'));
      await index.indexFile(filePath);

      expect(provider.textsEmbedded - initialEmbeddings).to.equal(1);
      expect(index.getChunksForFile(filePath).some((chunk) => chunk.symbol.includes('stable'))).to.equal(true);
    });

    it('retains the last good index when embedding changed chunks fails', async () => {
      const provider = new CountingEmbeddingProvider();
      const filePath = path.join(repoDir, 'src/transactional.ts');
      await writeFile('src/transactional.ts', 'export function stable() { return 1; }');
      const index = new SemanticIndex({provider, rootPath: repoDir, storagePath: storageDir});
      await index.initialize();
      await index.indexFile(filePath);
      const previousChunks = index.getChunksForFile(filePath).map((chunk) => chunk.contentHash);

      await writeFile('src/transactional.ts', 'export function replacement() { return 2; }');
      provider.fail = true;
      let failure: unknown;
      try {
        await index.indexFile(filePath);
      } catch (error) {
        failure = error;
      }

      expect(failure).to.be.instanceOf(Error);
      expect(index.getChunksForFile(filePath).map((chunk) => chunk.contentHash)).to.deep.equal(previousChunks);
    });

    it('cancels repository indexing while an embedding request is blocked', async () => {
      await writeFile('src/app.ts', 'export function app() { return 1; }');
      const controller = new AbortController();
      const index = new SemanticIndex({
        provider: new BlockingEmbeddingProvider(),
        rootPath: repoDir,
        storagePath: storageDir,
      });
      await index.initialize();
      const indexing = index.indexRepository(undefined, controller.signal);
      const reason = new Error('Indexing cancelled');
      setImmediate(() => controller.abort(reason));

      let failure: unknown;
      try {
        await indexing;
      } catch (error) {
        failure = error;
      }

      expect(failure).to.equal(reason);
    });

    it('should invalidate file chunks', async () => {
      await writeFile('src/app.ts', 'export function app() {}');

      const index = await createIndex();
      await index.indexFile(path.join(repoDir, 'src/app.ts'));
      expect(index.getChunksForFile(path.join(repoDir, 'src/app.ts')).length).to.be.greaterThan(0);

      index.invalidateFile(path.join(repoDir, 'src/app.ts'));
      expect(index.getChunksForFile(path.join(repoDir, 'src/app.ts')).length).to.equal(0);
    });

  });

  describe('search', () => {
    it('should return relevant chunks for a query', async () => {
      await writeFile('src/auth.ts', `
export function validatePassword(password: string): boolean {
  return password.length >= 8;
}
`);
      await writeFile('src/math.ts', `
export function calculateSum(a: number, b: number): number {
  return a + b;
}
`);

      const index = await createIndex();
      await index.indexRepository();

      const results = await index.search('password validation authentication');
      expect(results.length).to.be.greaterThan(0);
    });

    it('should filter by structural type', async () => {
      await writeFile('src/mixed.ts', `
interface Config { key: string; }
export function processConfig(config: Config): void {}
export class ConfigManager { start() {} }
`);

      const index = await createIndex();
      await index.indexRepository();

      const funcResults = await index.search('config', { structuralType: 'function' });
      for (const r of funcResults) {
        expect(r.chunk.structuralType).to.equal('function');
      }
    });
  });

  describe('persistence', () => {
    it('should persist and restore index state', async () => {
      await writeFile('src/app.ts', 'export function persist() { return 42; }');

      // Create and populate index
      const index1 = await createIndex();
      await index1.indexRepository();
      const stats1 = index1.stats();
      expect(stats1.chunkCount).to.be.greaterThan(0);

      // Create a new index from the same storage path
      const index2 = await createIndex();
      const stats2 = index2.stats();

      expect(stats2.chunkCount).to.equal(stats1.chunkCount);
      expect(stats2.vectorCount).to.equal(stats1.vectorCount);
    });

    it('does not restore vectors created by an incompatible embedding configuration', async () => {
      await writeFile('src/app.ts', 'export function persist() { return 42; }');
      const first = await createIndex();
      await first.indexRepository();

      const provider = new CountingEmbeddingProvider();
      const second = new SemanticIndex({provider, rootPath: repoDir, storagePath: storageDir});
      await second.initialize();

      expect(second.stats()).to.include({chunkCount: 0, vectorCount: 0});
      await second.indexRepository();
      expect(provider.textsEmbedded).to.be.greaterThan(0);
    });

    it('invalidates persisted chunks when the chunker configuration changes', async () => {
      await writeFile('src/app.ts', 'export function persist() { return 42; }');
      const first = new SemanticIndex({
        maxChunkChars: 4000,
        provider: new NullEmbeddingProvider(),
        rootPath: repoDir,
        storagePath: storageDir,
      });
      await first.initialize();
      await first.indexRepository();

      const second = new SemanticIndex({
        maxChunkChars: 2000,
        provider: new NullEmbeddingProvider(),
        rootPath: repoDir,
        storagePath: storageDir,
      });
      await second.initialize();

      expect(second.stats()).to.include({chunkCount: 0, vectorCount: 0});
    });
  });

  describe('stats', () => {
    it('should return correct statistics', async () => {
      await writeFile('src/a.ts', `
export function funcA() {}
export function funcB() {}
export class ClassA { method() {} }
`);

      const index = await createIndex();
      await index.indexRepository();
      const stats = index.stats();

      expect(stats.fileCount).to.equal(1);
      expect(stats.chunkCount).to.be.greaterThan(0);
      expect(stats.vectorCount).to.equal(stats.chunkCount);
      expect(stats.chunksByType).to.have.property('function');
    });
  });

  describe('NullEmbeddingProvider', () => {
    it('should produce deterministic vectors', async () => {
      const provider = new NullEmbeddingProvider(64);
      const [vec1] = await provider.embed(['hello world']);
      const [vec2] = await provider.embed(['hello world']);
      expect(vec1).to.deep.equal(vec2);
      expect(vec1.length).to.equal(64);
    });

    it('should produce unit vectors', async () => {
      const provider = new NullEmbeddingProvider(64);
      const [vec] = await provider.embed(['test input']);
      const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
      expect(norm).to.be.approximately(1, 0.01);
    });

    it('should produce different vectors for different inputs', async () => {
      const provider = new NullEmbeddingProvider(64);
      const [vec1] = await provider.embed(['input A']);
      const [vec2] = await provider.embed(['input B']);
      expect(vec1).to.not.deep.equal(vec2);
    });
  });
});
