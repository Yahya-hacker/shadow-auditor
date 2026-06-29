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
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';

import { VectorStore } from './vector-store.js';

// ============================================================================
// Types
// ============================================================================

export interface CodeChunk {
  /** SHA-256 of the raw content for deduplication */
  contentHash: string;
  /** End line (1-indexed, inclusive) */
  endLine: number;
  /** Absolute file path */
  filePath: string;
  /** Unique chunk identifier */
  id: string;
  /** Detected language */
  language: string;
  /** Parent scope context (imports, class header) prepended for coherence */
  parentContext: string;
  /** The raw source code of this chunk */
  rawContent: string;
  /** Start line (1-indexed, inclusive) */
  startLine: number;
  /** Structural type: 'function' | 'class' | 'method' | 'interface' | 'file_fragment' */
  structuralType: string;
  /** Human-readable label (function name, class name, etc.) */
  symbol: string;
}

export interface EmbeddingProvider {
  /** Dimension of the embedding vectors produced */
  dimension: number;
  /** Generate embeddings for a batch of texts */
  embed(texts: string[]): Promise<number[][]>;
  /** Provider name for logging */
  name: string;
}

export interface SemanticIndexOptions {
  /** Maximum tokens per chunk (approximate, character-based) */
  maxChunkChars?: number;
  /** Embedding provider instance */
  provider: EmbeddingProvider;
  /** Root directory of the target repository */
  rootPath: string;
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
  totalFiles: number;
}

// ============================================================================
// Embedding Providers
// ============================================================================

/**
 * Ollama-based local embedding provider.
 * Default for zero-data-leakage in security tooling.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number;
  readonly name = 'ollama';
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options: { baseUrl?: string; dimension?: number; model?: string } = {}) {
    this.model = options.model ?? 'nomic-embed-text';
    this.baseUrl = options.baseUrl ?? 'http://127.0.0.1:11434';
    this.dimension = options.dimension ?? 768;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    const batchSize = 10;

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);

      const batchPromises = batch.map(async (text) => {
        const response = await fetch(`${this.baseUrl}/api/embed`, {
          body: JSON.stringify({
            input: text,
            model: this.model,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        });

        if (!response.ok) {
          throw new Error(`Ollama embed error (${response.status}): ${response.statusText}`);
        }

        const data = (await response.json()) as { embeddings: number[][] };
        return data.embeddings[0];
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    return results;
  }
}

/**
 * OpenAI embedding provider (optional, for users who prioritize speed).
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number;
  readonly name = 'openai';
  private readonly apiKey: string;
  private readonly model: string;

  constructor(options: { apiKey: string; dimension?: number; model?: string }) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'text-embedding-3-small';
    this.dimension = options.dimension ?? 1536;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      body: JSON.stringify({
        input: texts,
        model: this.model,
      }),
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    if (!response.ok) {
      throw new Error(`OpenAI embed error (${response.status}): ${response.statusText}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    return data.data.map((d) => d.embedding);
  }
}

/**
 * Null embedding provider for testing or when embeddings are unavailable.
 * Generates deterministic pseudo-random vectors from content hashes.
 */
export class NullEmbeddingProvider implements EmbeddingProvider {
  readonly dimension: number;
  readonly name = 'null';

  constructor(dimension = 128) {
    this.dimension = dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.deterministicVector(text));
  }

  private deterministicVector(text: string): number[] {
    const hash = crypto.createHash('sha256').update(text).digest();
    const vector: number[] = [];

    for (let i = 0; i < this.dimension; i++) {
      // Use hash bytes cyclically to generate pseudo-random floats in [-1, 1]
      const byteIndex = i % hash.length;
      vector.push((hash[byteIndex] / 127.5) - 1);
    }

    // Normalize to unit vector
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= norm;
      }
    }

    return vector;
  }
}

// ============================================================================
// Tree-sitter Chunking Engine
// ============================================================================

/** Directories to skip during traversal */
const IGNORED_DIRS = new Set([
  '.cache', '.git', '.next', '.turbo',
  '__pycache__', 'build', 'coverage', 'dist', 'node_modules',
]);

/** Supported file extensions with their languages */
const LANGUAGE_MAP: Record<string, () => unknown> = {
  '.js': () => JavaScript,
  '.jsx': () => JavaScript,
  '.ts': () => TypeScript.typescript,
  '.tsx': () => TypeScript.tsx,
};

/** AST node types that represent meaningful code boundaries */
const CHUNK_BOUNDARY_TYPES = new Set([
  'arrow_function',
  'class_declaration',
  'enum_declaration',
  'export_statement',
  'function_declaration',
  'interface_declaration',
  'lexical_declaration',
  'method_definition',
  'type_alias_declaration',
]);

/**
 * Recursively collect source files from a directory.
 */
async function collectSourceFiles(dirPath: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (ext in LANGUAGE_MAP) {
          results.push(fullPath);
        }
      }
    }
  }

  await walk(dirPath);
  return results.sort();
}

/**
 * Extract import statements and top-level type declarations from a file.
 * These form the "parent context" prepended to each function-level chunk
 * so the LLM never sees a function completely divorced from its environment.
 */
function extractFileContext(root: Parser.SyntaxNode): string {
  const contextLines: string[] = [];

  for (const child of root.namedChildren) {
    if (child.type === 'import_statement') {
      contextLines.push(child.text);
    } else if (
      child.type === 'type_alias_declaration' ||
      child.type === 'interface_declaration'
    ) {
      // Include type declarations but truncate large ones
      const text = child.text;
      contextLines.push(text.length > 200 ? text.slice(0, 200) + ' ...' : text);
    }
  }

  return contextLines.join('\n');
}

/**
 * Extract the class header (name, extends, implements) without the body.
 */
function extractClassHeader(node: Parser.SyntaxNode): string {
  const name = node.childForFieldName('name')?.text ?? 'Anonymous';
  const superClass = node.childForFieldName('superclass');
  let header = `class ${name}`;
  if (superClass) header += ` extends ${superClass.text}`;
  return header;
}

/**
 * Chunk a parsed AST into semantically meaningful code blocks.
 */
function chunkAST(
  root: Parser.SyntaxNode,
  sourceCode: string,
  filePath: string,
  language: string,
  maxChunkChars: number,
): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  const fileContext = extractFileContext(root);
  const lines = sourceCode.split('\n');

  function createChunk(
    node: Parser.SyntaxNode,
    structuralType: string,
    symbol: string,
    parentContext: string,
  ): CodeChunk {
    const rawContent = node.text;
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;

    return {
      contentHash: crypto.createHash('sha256').update(rawContent).digest('hex').slice(0, 16),
      endLine,
      filePath,
      id: `chunk_${crypto.createHash('sha256').update(`${filePath}:${startLine}:${endLine}`).digest('hex').slice(0, 16)}`,
      language,
      parentContext,
      rawContent: rawContent.length > maxChunkChars
        ? rawContent.slice(0, maxChunkChars) + '\n// ... truncated'
        : rawContent,
      startLine,
      structuralType,
      symbol,
    };
  }

  // Process top-level declarations
  for (const child of root.namedChildren) {
    if (child.type === 'import_statement') {
      continue; // Imports are captured as parent context, not standalone chunks
    }

    if (child.type === 'class_declaration') {
      const className = child.childForFieldName('name')?.text ?? 'Anonymous';
      const classHeader = extractClassHeader(child);
      const classContext = `${fileContext}\n\n${classHeader} {`;

      // Chunk each method within the class separately
      const body = child.childForFieldName('body');
      if (body) {
        let hasMethodChunks = false;
        for (const member of body.namedChildren) {
          if (member.type === 'method_definition') {
            const methodName = member.childForFieldName('name')?.text ?? 'anonymous';
            chunks.push(createChunk(
              member,
              'method',
              `${className}.${methodName}`,
              classContext,
            ));
            hasMethodChunks = true;
          }
        }

        // If class has no methods or is small, chunk the entire class
        if (!hasMethodChunks || child.text.length <= maxChunkChars) {
          chunks.push(createChunk(child, 'class', className, fileContext));
        }
      }

      continue;
    }

    if (child.type === 'function_declaration') {
      const name = child.childForFieldName('name')?.text ?? 'anonymous';
      chunks.push(createChunk(child, 'function', name, fileContext));
      continue;
    }

    if (child.type === 'export_statement') {
      const declaration = child.namedChildren.find((c) =>
        c.type === 'function_declaration' ||
        c.type === 'class_declaration' ||
        c.type === 'lexical_declaration',
      );

      if (declaration) {
        switch (declaration.type) {
        case 'class_declaration': {
          // Recurse into the class to extract method-level chunks
          const className = declaration.childForFieldName('name')?.text ?? 'Anonymous';
          const classHeader = extractClassHeader(declaration);
          const classContext = `${fileContext}\n\nexport ${classHeader} {`;

          const body = declaration.childForFieldName('body');
          if (body) {
            let hasMethodChunks = false;
            for (const member of body.namedChildren) {
              if (member.type === 'method_definition') {
                const methodName = member.childForFieldName('name')?.text ?? 'anonymous';
                chunks.push(createChunk(
                  member,
                  'method',
                  `${className}.${methodName}`,
                  classContext,
                ));
                hasMethodChunks = true;
              }
            }

            // Also add a whole-class chunk if small or no methods found
            if (!hasMethodChunks || declaration.text.length <= maxChunkChars) {
              chunks.push(createChunk(child, 'class', `export ${className}`, fileContext));
            }
          } else {
            chunks.push(createChunk(child, 'class', `export ${className}`, fileContext));
          }
        
        break;
        }

        case 'function_declaration': {
          const name = declaration.childForFieldName('name')?.text ?? 'anonymous';
          chunks.push(createChunk(child, 'function', `export ${name}`, fileContext));
        
        break;
        }

        case 'lexical_declaration': {
          // Check if it's an arrow function assignment
          for (const declarator of declaration.namedChildren) {
            if (declarator.type === 'variable_declarator') {
              const value = declarator.childForFieldName('value');
              const name = declarator.childForFieldName('name')?.text ?? 'anonymous';
              if (value && (value.type === 'arrow_function' || value.type === 'function')) {
                chunks.push(createChunk(child, 'function', `export ${name}`, fileContext));
              } else {
                chunks.push(createChunk(child, 'declaration', `export ${name}`, fileContext));
              }
            }
          }
        
        break;
        }
        // No default
        }
      } else if (child.text.length > 20) {
        // Re-exports, default exports, etc.
        chunks.push(createChunk(child, 'export', 'export', fileContext));
      }

      continue;
    }

    if (child.type === 'lexical_declaration') {
      for (const declarator of child.namedChildren) {
        if (declarator.type === 'variable_declarator') {
          const name = declarator.childForFieldName('name')?.text ?? 'anonymous';
          const value = declarator.childForFieldName('value');
          const structType = value && (value.type === 'arrow_function' || value.type === 'function')
            ? 'function'
            : 'declaration';
          chunks.push(createChunk(child, structType, name, fileContext));
        }
      }

      continue;
    }

    if (child.type === 'interface_declaration' || child.type === 'type_alias_declaration') {
      const name = child.childForFieldName('name')?.text ?? 'anonymous';
      chunks.push(createChunk(child, child.type.replace('_declaration', ''), name, fileContext));
      continue;
    }

    if (child.type === 'enum_declaration') {
      const name = child.childForFieldName('name')?.text ?? 'anonymous';
      chunks.push(createChunk(child, 'enum', name, fileContext));
      continue;
    }
  }

  // If no structural chunks were found, chunk the file as a whole
  if (chunks.length === 0 && sourceCode.trim().length > 0) {
    chunks.push({
      contentHash: crypto.createHash('sha256').update(sourceCode).digest('hex').slice(0, 16),
      endLine: lines.length,
      filePath,
      id: `chunk_${crypto.createHash('sha256').update(`${filePath}:file`).digest('hex').slice(0, 16)}`,
      language,
      parentContext: '',
      rawContent: sourceCode.length > maxChunkChars
        ? sourceCode.slice(0, maxChunkChars) + '\n// ... truncated'
        : sourceCode,
      startLine: 1,
      structuralType: 'file_fragment',
      symbol: path.basename(filePath),
    });
  }

  return chunks;
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
  private chunks: Map<string, CodeChunk> = new Map();
  private fileChunkIndex: Map<string, Set<string>> = new Map();
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
    this.maxChunkChars = options.maxChunkChars ?? 4000;
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

  /**
   * Index a single file, returning the number of chunks created.
   */
  async indexFile(filePath: string): Promise<number> {
    this.ensureInitialized();

    const ext = path.extname(filePath);
    const languageFactory = LANGUAGE_MAP[ext];
    if (!languageFactory) {
      return 0;
    }

    let sourceCode: string;
    try {
      sourceCode = await fs.readFile(filePath, 'utf8');
    } catch {
      return 0;
    }

    if (sourceCode.trim().length === 0) {
      return 0;
    }

    // Remove old chunks for this file
    this.invalidateFile(filePath);

    // Parse and chunk
    const language = languageFactory();
    const languageName = ext === '.ts' || ext === '.tsx' ? 'typescript' : 'javascript';

    try {
      this.parser.setLanguage(language as Parameters<Parser['setLanguage']>[0]);
      const tree = this.parser.parse(sourceCode);
      const newChunks = chunkAST(tree.rootNode, sourceCode, filePath, languageName, this.maxChunkChars);

      if (newChunks.length === 0) {
        return 0;
      }

      // Register chunks
      const fileChunkIds = new Set<string>();
      for (const chunk of newChunks) {
        this.chunks.set(chunk.id, chunk);
        fileChunkIds.add(chunk.id);
      }

      this.fileChunkIndex.set(filePath, fileChunkIds);

      // Generate embeddings
      const texts = newChunks.map((c) => this.buildEmbeddingText(c));
      const embeddings = await this.provider.embed(texts);

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
          vector: embeddings[i],
        });
      }

      return newChunks.length;
    } catch (error) {
      console.warn(`[SemanticIndex] Parse error in ${filePath}: ${(error as Error).message}`);
      return 0;
    }
  }

  /**
   * Index the entire repository.
   */
  async indexRepository(
    onProgress?: (progress: IndexingProgress) => void,
  ): Promise<{ chunksIndexed: number; filesIndexed: number }> {
    this.ensureInitialized();

    const files = await collectSourceFiles(this.rootPath);
    let filesIndexed = 0;
    let chunksIndexed = 0;

    for (const filePath of files) {
      const chunks = await this.indexFile(filePath);
      chunksIndexed += chunks;
      filesIndexed++;

      onProgress?.({
        currentFile: path.relative(this.rootPath, filePath),
        filesIndexed,
        totalFiles: files.length,
      });
    }

    // Persist everything
    await this.saveChunkMetadata();
    await this.vectorStore.saveSnapshot();

    return { chunksIndexed, filesIndexed };
  }

  /**
   * Initialize the index, loading any persisted state.
   */
  async initialize(): Promise<void> {
    this.vectorStore = await VectorStore.create(this.storagePath);
    await this.loadChunkMetadata();
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
      structuralType?: string;
      topK?: number;
    } = {},
  ): Promise<SemanticSearchResult[]> {
    this.ensureInitialized();

    // Generate query embedding
    const [queryEmbedding] = await this.provider.embed([query]);

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
      topK: options.topK ?? 20,
    });

    // Map back to CodeChunks
    const results: SemanticSearchResult[] = [];
    for (const vr of vectorResults) {
      const chunk = this.chunks.get(vr.entry.id);
      if (!chunk) {
        continue;
      }

      // Apply file filter if specified
      if (options.fileFilter && !chunk.filePath.includes(options.fileFilter)) {
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

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('SemanticIndex not initialized. Call initialize() first.');
    }
  }

  /**
   * Load chunk metadata from disk.
   */
  private async loadChunkMetadata(): Promise<void> {
    const metaPath = path.join(this.storagePath, 'chunk-metadata.json');
    try {
      const content = await fs.readFile(metaPath, 'utf8');
      const data = JSON.parse(content) as { chunks: CodeChunk[]; fileIndex: Record<string, string[]> };

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

  /**
   * Save chunk metadata to disk.
   */
  private async saveChunkMetadata(): Promise<void> {
    const metaPath = path.join(this.storagePath, 'chunk-metadata.json');

    const fileIndex: Record<string, string[]> = {};
    for (const [filePath, chunkIds] of this.fileChunkIndex) {
      fileIndex[filePath] = [...chunkIds];
    }

    const data = {
      chunks: [...this.chunks.values()],
      fileIndex,
    };

    await fs.writeFile(metaPath, JSON.stringify(data), 'utf8');
  }
}
