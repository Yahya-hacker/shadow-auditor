/**
 * Semantic Index tests.
 */

import { expect } from 'chai';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  NullEmbeddingProvider,
  SemanticIndex,
} from '../src/core/memory/semantic-index.js';

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

    it('should handle empty files gracefully', async () => {
      await writeFile('empty.ts', '');
      const index = await createIndex();
      const count = await index.indexFile(path.join(repoDir, 'empty.ts'));
      expect(count).to.equal(0);
    });

    it('should skip non-JS/TS files', async () => {
      await writeFile('readme.md', '# Hello');
      const index = await createIndex();
      const count = await index.indexFile(path.join(repoDir, 'readme.md'));
      expect(count).to.equal(0);
    });
  });

  describe('indexing', () => {
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
