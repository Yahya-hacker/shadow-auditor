/**
 * Semantic Index - Code-aware chunking, embedding, and vector retrieval.
 *
 * Uses Tree-sitter for AST-aware chunking at function/class boundaries,
 * captures parent scope context (imports, class declarations) per chunk,
 * and generates embeddings via a configurable provider (Ollama default,
 * OpenAI optional) stored in the local VectorStore.
 *
 * Design note: Overlapping sliding windows include the immediate parent
 * scope (e.g., class imports, surrounding class declaration) so that
 * functions are never analyzed completely out of their file context.
 * This prevents hallucination of missing types or global variables.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { CodeChunk } from './chunkers/types.js';
import type { EmbeddingProvider } from './embeddings/types.js';

import { recoverAtomicWrite, withPathLock, writeFileAtomic } from '../../utils/fs-atomic.js';
import { chunkGeneric, chunkWholeFile } from './chunkers/generic-chunker.js';
import { chunkJsTs } from './chunkers/js-ts-chunker.js';
import {
  getLanguageForExt,
  GUARANTEED_LANGUAGE_KEYS,
  Parser,
} from './tree-sitter-languages.js';
import {parseTreeSitterSource} from './tree-sitter-parser.js';
import { VectorStore } from './vector-store.js';

// ============================================================================
// Re-exports for backward compatibility
// ============================================================================

export type { CodeChunk } from './chunkers/types.js';
export { NullEmbeddingProvider } from './embeddings/null-provider.js';
export { OllamaEmbeddingProvider } from './embeddings/ollama-provider.js';
export { OpenAIEmbeddingProvider } from './embeddings/openai-provider.js';
export type { EmbeddingProvider } from './embeddings/types.js';

// ============================================================================
// Types
// ============================================================================

export interface SemanticIndexOptions {
  /** Maximum tokens per chunk (approximate, character-based) */
  maxChunkChars?: number;
  /** Embedding provider instance */
  provider: EmbeddingProvider;
  /** Root directory of the target repository */
  rootPath: string;
  /** Whether vector similarity is backed by a real embedding model. */
  semanticSearchEnabled?: boolean;
  /** Directory for persisting the vector store */
  storagePath: string;
}

export interface SemanticSearchResult {
  chunk: CodeChunk;
  score: number;
}

export interface IndexingProgress {
  currentFile: string;
  filesIndexed: number;
  filesProcessed: number;
  totalFiles: number;
}

export interface IndexingStats {
  chunksIndexed: number;
  filesDiscovered: number;
  filesIndexed: number;
  filesSkipped: number;
}

export interface IndexingDiagnostic {
  filePath: string;
  reason: string;
}

// ============================================================================
// File Collection
// ============================================================================

/** Directories to skip during traversal */
const IGNORED_DIRS = new Set([
  '.cache', '.git', '.next', '.turbo',
  '__pycache__', 'build', 'coverage', 'dist', 'node_modules',
]);

/**
 * Recursively collect source files from a directory.
 */
async function collectSourceFiles(dirPath: string, signal?: AbortSignal): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    signal?.throwIfAborted();
    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      signal?.throwIfAborted();
      return;
    }

    for (const entry of entries) {
      signal?.throwIfAborted();
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (getLanguageForExt(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  await walk(dirPath);
  return results.sort();
}

// ============================================================================
// Semantic Index
// ============================================================================

/**
 * Semantic Index for code-aware retrieval.
 *
 * Combines Tree-sitter AST parsing for structural chunking with
 * vector embeddings for semantic similarity search. The index is
 * persisted to disk and supports incremental updates.
 */
export class SemanticIndex {
  readonly semanticSearchAvailable: boolean;
  private readonly cacheFingerprint: string;
  private chunks: Map<string, CodeChunk> = new Map();
  private fileChunkIndex: Map<string, Set<string>> = new Map();
  private indexingDiagnostics: Map<string, string> = new Map();
  private initialized = false;
  private readonly maxChunkChars: number;
  private readonly parser: Parser;
  private readonly provider: EmbeddingProvider;
  private readonly rootPath: string;
  private readonly storagePath: string;
  private vectorStore!: VectorStore;

  constructor(options: SemanticIndexOptions) {
    this.rootPath = path.resolve(options.rootPath);
    this.storagePath = options.storagePath;
    this.provider = options.provider;
    this.semanticSearchAvailable = options.semanticSearchEnabled ?? true;
    this.maxChunkChars = options.maxChunkChars ?? 4000;
    this.cacheFingerprint = [
      'semantic-index-schema-v4',
      'tree-sitter-parser-callback-v1',
      'chunkers-v3-lossless-windows',
      `max-chars:${this.maxChunkChars}`,
      `guaranteed-grammars:${GUARANTEED_LANGUAGE_KEYS.join(',')}`,
    ].join('|');
    this.parser = new Parser();
  }

  /**
   * Get all chunks across all files.
   */
  getAllChunks(): CodeChunk[] {
    this.ensureInitialized();
    return [...this.chunks.values()];
  }

  /**
   * Get a chunk by ID.
   */
  getChunk(chunkId: string): CodeChunk | undefined {
    this.ensureInitialized();
    return this.chunks.get(chunkId);
  }

  /**
   * Get all chunks for a file.
   */
  getChunksForFile(filePath: string): CodeChunk[] {
    this.ensureInitialized();
    const chunkIds = this.fileChunkIndex.get(filePath);
    if (!chunkIds) {
      return [];
    }

    return [...chunkIds]
      .map((id) => this.chunks.get(id))
      .filter((c): c is CodeChunk => c !== undefined);
  }

  /**
   * Get all indexed file paths.
   */
  getIndexedFilePaths(): string[] {
    this.ensureInitialized();
    return [...this.fileChunkIndex.keys()];
  }

  getIndexingDiagnostics(): IndexingDiagnostic[] {
    return [...this.indexingDiagnostics.entries()].map(([filePath, reason]) => ({
      filePath,
      reason,
    }));
  }

  /**
   * Index a single file, returning the number of chunks created.
   */
  async indexFile(filePath: string, signal?: AbortSignal): Promise<number> {
    this.ensureInitialized();
    signal?.throwIfAborted();

    const ext = path.extname(filePath);
    const langInfo = getLanguageForExt(ext);
    if (!langInfo) {
      return 0;
    }

    let sourceCode: string;
    try {
      sourceCode = await fs.readFile(filePath, {encoding: 'utf8', signal});
    } catch (error) {
      signal?.throwIfAborted();
      this.invalidateFile(filePath);
      this.indexingDiagnostics.set(
        filePath,
        `read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }

    if (sourceCode.trim().length === 0) {
      this.invalidateFile(filePath);
      this.indexingDiagnostics.set(filePath, 'file is empty');
      return 0;
    }

    // Binary file detection: scan for null bytes in the first 8KB.
    // Tree-sitter parsers crash on binary input, so we skip aggressively.
    const scanLength = Math.min(sourceCode.length, 8192);
    if (sourceCode.slice(0, scanLength).includes('\0')) {
      this.invalidateFile(filePath);
      this.indexingDiagnostics.set(filePath, 'binary content detected');
      return 0;
    }

    const languageName = langInfo.name;
    const isStructured = langInfo.isStructured;
    let embeddingInProgress = false;

    try {
      let language: unknown;
      let grammarWarning: string | undefined;
      try {
        language = await langInfo.load();
      } catch {
        signal?.throwIfAborted();
        grammarWarning = `Tree-sitter grammar "${langInfo.key}" unavailable; ` +
          'indexed with whole-file lexical chunks';
      }

      signal?.throwIfAborted();

      // Use language-specific AST chunking for JS/TS (detailed knowledge),
      // generic cross-language chunking for other structured languages
      // (Python, Go, Rust, Java, etc.), and whole-file chunks for
      // data/config/markup formats.
      let newChunks: CodeChunk[];
      if (language) {
        try {
          this.parser.setLanguage(language as Parameters<Parser['setLanguage']>[0]);
          const tree = parseTreeSitterSource(this.parser, sourceCode);
          newChunks = isStructured
            ? (langInfo.key === 'javascript' || langInfo.key === 'typescript')
              ? chunkJsTs(tree.rootNode, sourceCode, filePath, languageName, this.maxChunkChars)
              : chunkGeneric(tree.rootNode, sourceCode, filePath, languageName, this.maxChunkChars)
            : chunkWholeFile(sourceCode, filePath, languageName, this.maxChunkChars);
        } catch (error) {
          signal?.throwIfAborted();
          const detail = error instanceof Error ? error.message : String(error);
          grammarWarning = `Tree-sitter grammar "${langInfo.key}" failed (${detail}); ` +
            'indexed with whole-file lexical chunks';
          newChunks = chunkWholeFile(sourceCode, filePath, languageName, this.maxChunkChars);
        }
      } else {
        newChunks = chunkWholeFile(sourceCode, filePath, languageName, this.maxChunkChars);
      }

      if (newChunks.length === 0) {
        this.invalidateFile(filePath);
        this.indexingDiagnostics.set(filePath, 'parser produced no indexable chunks');
        return 0;
      }

      newChunks = newChunks.map((chunk) => ({
        ...chunk,
        contentHash: this.embeddingFingerprint(chunk),
      }));
      const existingChunks = this.getChunksForFile(filePath);
      if (
        existingChunks.length === newChunks.length &&
        existingChunks.every((chunk, index) => chunk.contentHash === newChunks[index]?.contentHash)
      ) {
        if (grammarWarning) this.indexingDiagnostics.set(filePath, grammarWarning);
        else this.indexingDiagnostics.delete(filePath);
        return existingChunks.length;
      }

      // Reuse vectors for unchanged semantic blocks, even when surrounding
      // edits move their line numbers and therefore change their chunk IDs.
      const reusableVectors = new Map(
        existingChunks.flatMap((chunk) => {
          const entry = this.vectorStore.get(chunk.id);
          return entry ? [[chunk.contentHash, entry.vector] as const] : [];
        }),
      );
      const embeddings: Array<number[] | undefined> = Array.from({length: newChunks.length});
      const changedIndexes: number[] = [];
      for (const [index, chunk] of newChunks.entries()) {
        const reusable = reusableVectors.get(chunk.contentHash);
        if (reusable) embeddings[index] = reusable;
        else changedIndexes.push(index);
      }

      // Generate every missing replacement vector before mutating the active
      // index. A transient provider failure leaves the last good index intact.
      if (changedIndexes.length > 0) {
        embeddingInProgress = true;
        const generated = await this.provider.embed(
          changedIndexes.map((index) => this.buildEmbeddingText(newChunks[index]!)),
          signal,
        );
        embeddingInProgress = false;
        if (
          generated.length !== changedIndexes.length ||
          generated.some((embedding) => !embedding)
        ) {
          throw new Error(
            `Embedding provider returned ${generated.length} vectors for ${changedIndexes.length} changed chunks.`,
          );
        }

        for (const [position, chunkIndex] of changedIndexes.entries()) {
          embeddings[chunkIndex] = generated[position];
        }
      }

      this.invalidateFile(filePath);
      const fileChunkIds = new Set<string>();
      for (const chunk of newChunks) {
        this.chunks.set(chunk.id, chunk);
        fileChunkIds.add(chunk.id);
      }

      this.fileChunkIndex.set(filePath, fileChunkIds);

      // Store in vector index
      for (const [i, chunk] of newChunks.entries()) {
        this.vectorStore.upsert({
          id: chunk.id,
          metadata: {
            contentHash: chunk.contentHash,
            endLine: chunk.endLine,
            filePath: chunk.filePath,
            language: chunk.language,
            startLine: chunk.startLine,
            structuralType: chunk.structuralType,
            symbol: chunk.symbol,
          },
          vector: embeddings[i]!,
        });
      }

      if (grammarWarning) this.indexingDiagnostics.set(filePath, grammarWarning);
      else this.indexingDiagnostics.delete(filePath);
      return newChunks.length;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (embeddingInProgress || /embed|vector|quota|rate limit|unauthoriz|timeout|network/i.test(errorMessage)) {
        throw error;
      }

      this.indexingDiagnostics.set(filePath, `parse failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Index the entire repository.
   */
  async indexRepository(
    onProgress?: (progress: IndexingProgress) => void,
    signal?: AbortSignal,
  ): Promise<IndexingStats> {
    return withPathLock(path.join(this.storagePath, 'semantic-index-operation'), async () => {
      signal?.throwIfAborted();
      await this.reloadPersistedState();
      return this.indexRepositoryUnlocked(onProgress, signal);
    });
  }

  /**
   * Initialize the index, loading any persisted state.
   */
  async initialize(): Promise<void> {
    this.vectorStore = await VectorStore.create(
      this.storagePath,
      `${this.provider.fingerprint}|${this.cacheFingerprint}`,
    );
    if (this.vectorStore.restoredCompatibleSnapshot) {
      await this.loadChunkMetadata(this.vectorStore.snapshotGeneration);
    }

    this.initialized = true;
  }

  /**
   * Remove all chunks for a file (for re-indexing).
   */
  invalidateFile(filePath: string): void {
    this.ensureInitialized();

    const existingChunkIds = this.fileChunkIndex.get(filePath);
    if (!existingChunkIds) {
      return;
    }

    for (const chunkId of existingChunkIds) {
      this.chunks.delete(chunkId);
      this.vectorStore.delete(chunkId);
    }

    this.fileChunkIndex.delete(filePath);
  }

  /**
   * Semantic search: find code chunks most relevant to a natural language query.
   */
  async search(
    query: string,
    options: {
      fileFilter?: string;
      language?: string;
      minScore?: number;
      signal?: AbortSignal;
      structuralType?: string;
      topK?: number;
    } = {},
  ): Promise<SemanticSearchResult[]> {
    this.ensureInitialized();
    if (!this.semanticSearchAvailable) return [];

    // Generate query embedding
    const [queryEmbedding] = await this.provider.embed([query], options.signal);

    // Build metadata filter
    const filter: Record<string, unknown> = {};
    if (options.language) {
      filter.language = options.language;
    }

    if (options.structuralType) {
      filter.structuralType = options.structuralType;
    }

    // Search vector store
    const vectorResults = this.vectorStore.search(queryEmbedding, {
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      minScore: options.minScore ?? -1,
      predicate: options.fileFilter
        ? (metadata) => typeof metadata.filePath === 'string' &&
          metadata.filePath.includes(options.fileFilter!)
        : undefined,
      topK: options.topK ?? 20,
    });

    // Map back to CodeChunks
    const results: SemanticSearchResult[] = [];
    for (const vr of vectorResults) {
      const chunk = this.chunks.get(vr.entry.id);
      if (!chunk) {
        continue;
      }

      results.push({ chunk, score: vr.score });
    }

    return results;
  }

  /**
   * Get index statistics.
   */
  stats(): {
    chunkCount: number;
    chunksByType: Record<string, number>;
    fileCount: number;
    vectorCount: number;
  } {
    this.ensureInitialized();

    const chunksByType: Record<string, number> = {};
    for (const chunk of this.chunks.values()) {
      chunksByType[chunk.structuralType] = (chunksByType[chunk.structuralType] ?? 0) + 1;
    }

    return {
      chunkCount: this.chunks.size,
      chunksByType,
      fileCount: this.fileChunkIndex.size,
      vectorCount: this.vectorStore.size,
    };
  }

  /**
   * Build the text that gets embedded.
   * Includes parent context for coherence (imports, class header).
   */
  private buildEmbeddingText(chunk: CodeChunk): string {
    const parts: string[] = [];

    // Include file path as semantic signal
    const relativePath = path.relative(this.rootPath, chunk.filePath);
    parts.push(`// File: ${relativePath}`);

    // Include parent context (imports, class declaration)
    if (chunk.parentContext.trim()) {
      parts.push(chunk.parentContext, ''); // Empty line separator
    }

    // Include the actual chunk content
    parts.push(chunk.rawContent);

    return parts.join('\n');
  }

  private embeddingFingerprint(chunk: CodeChunk): string {
    return crypto.createHash('sha256').update(JSON.stringify({
      embeddingText: this.buildEmbeddingText(chunk),
      structuralType: chunk.structuralType,
      symbol: chunk.symbol,
    })).digest('hex').slice(0, 16);
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('SemanticIndex not initialized. Call initialize() first.');
    }
  }

  private async indexRepositoryUnlocked(
    onProgress?: (progress: IndexingProgress) => void,
    signal?: AbortSignal,
  ): Promise<IndexingStats> {
    this.ensureInitialized();
    signal?.throwIfAborted();

    const files = await collectSourceFiles(this.rootPath, signal);
    const currentFiles = new Set(files);
    for (const indexedFile of this.fileChunkIndex.keys()) {
      if (!currentFiles.has(indexedFile)) this.invalidateFile(indexedFile);
    }

    let filesIndexed = 0;
    let filesProcessed = 0;
    let chunksIndexed = 0;

    const BATCH_SIZE = 5;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      signal?.throwIfAborted();
      const batch = files.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(fp => this.indexFile(fp, signal)));
      for (const chunks of results) {
        chunksIndexed += chunks;
        if (chunks > 0) filesIndexed++;
      }

      filesProcessed += batch.length;

      onProgress?.({
        currentFile: path.relative(this.rootPath, batch.at(-1) ?? ''),
        filesIndexed,
        filesProcessed,
        totalFiles: files.length,
      });

      await new Promise((resolve) => { setImmediate(resolve); });
    }

    const generation = crypto.randomUUID();
    await this.vectorStore.saveSnapshot(generation);
    await this.saveChunkMetadata(generation);

    return {
      chunksIndexed,
      filesDiscovered: files.length,
      filesIndexed,
      filesSkipped: files.length - filesIndexed,
    };
  }

  /**
   * Load chunk metadata from disk.
   */
  private async loadChunkMetadata(expectedGeneration?: string): Promise<void> {
    const metaPath = path.join(this.storagePath, 'chunk-metadata.json');
    try {
      await recoverAtomicWrite(metaPath);
      const content = await fs.readFile(metaPath, 'utf8');
      const data = JSON.parse(content) as {
        cacheFingerprint?: string;
        chunks: CodeChunk[];
        fileIndex: Record<string, string[]>;
        generation?: string;
      };
      if (
        data.cacheFingerprint !== this.cacheFingerprint ||
        !expectedGeneration ||
        data.generation !== expectedGeneration ||
        data.chunks.some((chunk) => !this.vectorStore.has(chunk.id))
      ) return;

      for (const chunk of data.chunks) {
        this.chunks.set(chunk.id, chunk);
      }

      for (const [filePath, chunkIds] of Object.entries(data.fileIndex)) {
        this.fileChunkIndex.set(filePath, new Set(chunkIds));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }

      throw error;
    }
  }

  private async reloadPersistedState(): Promise<void> {
    this.vectorStore = await VectorStore.create(
      this.storagePath,
      `${this.provider.fingerprint}|${this.cacheFingerprint}`,
    );
    this.chunks.clear();
    this.fileChunkIndex.clear();
    if (this.vectorStore.restoredCompatibleSnapshot) {
      await this.loadChunkMetadata(this.vectorStore.snapshotGeneration);
    }
  }

  /**
   * Save chunk metadata to disk.
   */
  private async saveChunkMetadata(generation: string): Promise<void> {
    const metaPath = path.join(this.storagePath, 'chunk-metadata.json');

    const fileIndex: Record<string, string[]> = {};
    for (const [filePath, chunkIds] of this.fileChunkIndex) {
      fileIndex[filePath] = [...chunkIds];
    }

    const data = {
      cacheFingerprint: this.cacheFingerprint,
      chunks: [...this.chunks.values()],
      fileIndex,
      generation,
    };

    await writeFileAtomic(metaPath, JSON.stringify(data));
  }
}
