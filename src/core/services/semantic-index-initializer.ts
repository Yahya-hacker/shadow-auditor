import type { ToolSet } from 'ai';

import * as path from 'node:path';

import type { ShadowConfig } from '../../utils/config.js';
import type { EmbeddingProvider } from '../memory/embeddings/types.js';
import type { KnowledgeGraph } from '../memory/knowledge-graph.js';
import type { MissionEngine } from '../orchestrator/mission-engine.js';

import { logToStderr } from '../../utils/stderr-logger.js';
import {
  fileCanonicalId,
  generateCanonicalId,
} from '../memory/entity-normalizer.js';
import { HybridRetriever } from '../memory/hybrid-retriever.js';
import {
  NullEmbeddingProvider,
  OllamaEmbeddingProvider,
  SemanticIndex,
} from '../memory/semantic-index.js';
import {isSupportedSourceExtension} from '../memory/tree-sitter-languages.js';
import { createContextRetrievalTool } from '../tools/context-retrieval.js';
import { createEmbeddingProvider } from './model-initializer.js';

export interface SemanticIndexInitialization {
  index: null | SemanticIndex;
  tools: ToolSet;
}

export interface SemanticIndexInitializerOptions {
  config: ShadowConfig;
  missionEngine: MissionEngine | null;
  onWarning: (warning: string) => void;
  runDirectory?: string;
  signal?: AbortSignal;
  targetPath: string;
}

interface IndexRelationship {
  calls: string[];
  dependencies: string[];
  fileId: string;
  relativePath: string;
  symbolId?: string;
}

function normalizeSymbolReference(reference: string): string {
  const unexported = reference.startsWith('export ') ? reference.slice('export '.length) : reference;
  const withoutCall = unexported
    .replaceAll('?.(', '.')
    .replaceAll(/\($/g, '');
  return withoutCall.split(/[.:]/).at(-1)?.trim() ?? withoutCall;
}

function resolveDependencyFile(
  sourcePath: string,
  reference: string,
  knownPaths: ReadonlySet<string>,
): string | undefined {
  const normalizedReference = reference.replaceAll('\\', '/').replace(/^node:/, '');
  const sourceDirectory = path.posix.dirname(sourcePath);
  const referenceExtension = path.posix.extname(normalizedReference);
  const relativeBase = normalizedReference.startsWith('.') ||
    isSupportedSourceExtension(referenceExtension)
    ? path.posix.normalize(path.posix.join(sourceDirectory, normalizedReference))
    : normalizedReference;
  const extensionlessBase = relativeBase.replace(/\.(?:cjs|js|jsx|mjs)$/, '');
  const candidates = [
    relativeBase,
    extensionlessBase,
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.php', '.go', '.rs', '.java']
      .flatMap((extension) => [
        `${extensionlessBase}${extension}`,
        `${extensionlessBase}/index${extension}`,
      ]),
  ];
  return candidates.find((candidate) => knownPaths.has(candidate));
}

function addDependencyEdges(
  graph: KnowledgeGraph,
  relationship: IndexRelationship,
  fileIds: ReadonlyMap<string, string>,
  knownPaths: ReadonlySet<string>,
): Set<string> {
  const dependencyFileIds = new Set<string>();
  for (const dependency of relationship.dependencies) {
    const targetPath = resolveDependencyFile(relationship.relativePath, dependency, knownPaths);
    const targetId = targetPath ? fileIds.get(targetPath) : undefined;
    if (!targetId || targetId === relationship.fileId) continue;

    dependencyFileIds.add(targetId);
    graph.addEdge('depends_on', relationship.fileId, targetId, {
      confidence: 1,
      metadata: {reference: dependency},
      validated: true,
    });
  }

  return dependencyFileIds;
}

function addCallEdges(
  graph: KnowledgeGraph,
  relationship: IndexRelationship,
  symbolIdsByName: ReadonlyMap<string, string[]>,
  dependencyFileIds: ReadonlySet<string>,
): void {
  if (!relationship.symbolId) return;

  for (const call of relationship.calls) {
    const candidates = symbolIdsByName.get(normalizeSymbolReference(call)) ?? [];
    const sameFileTargets = candidates.filter((candidate) =>
      graph.getEntity(candidate)?.properties.fileCanonicalId === relationship.fileId,
    );
    const importedTargets = candidates.filter((candidate) => {
      const candidateFileId = graph.getEntity(candidate)?.properties.fileCanonicalId;
      return typeof candidateFileId === 'string' && dependencyFileIds.has(candidateFileId);
    });
    const sameFileTarget = sameFileTargets.length === 1 ? sameFileTargets[0] : undefined;
    const targetId = sameFileTarget ?? (importedTargets.length === 1 ? importedTargets[0] : undefined);
    if (!targetId || targetId === relationship.symbolId) continue;

    graph.addEdge('calls', relationship.symbolId, targetId, {
      confidence: sameFileTarget ? 1 : 0.9,
      metadata: {reference: call},
      validated: true,
    });
  }
}

export async function populateIndexKnowledgeGraph(
  graph: KnowledgeGraph,
  index: SemanticIndex,
  rootPath: string,
): Promise<void> {
  const now = new Date().toISOString();
  const symbols = new Map<string, string>();
  const chunks = index.getAllChunks();
  const fileIds = new Map<string, string>();
  const relationships: IndexRelationship[] = [];
  const symbolIdsByName = new Map<string, string[]>();

  for (const chunk of chunks) {
    const relativePath = path.relative(rootPath, chunk.filePath).replaceAll('\\', '/');
    const fileId = fileCanonicalId(relativePath);
    fileIds.set(relativePath, fileId);
    graph.addEntity({
      canonicalId: fileId,
      confidence: 1,
      createdAt: now,
      entityType: 'file',
      label: relativePath,
      properties: {language: chunk.language, path: relativePath},
      updatedAt: now,
    });

    const chunkId = generateCanonicalId('chunk', {
      contentHash: chunk.contentHash,
      endLine: chunk.endLine,
      fileCanonicalId: fileId,
      startLine: chunk.startLine,
    });
    graph.addEntity({
      canonicalId: chunkId,
      confidence: 1,
      createdAt: now,
      entityType: 'chunk',
      label: `${relativePath}:${chunk.startLine}-${chunk.endLine}`,
      properties: {
        contentHash: chunk.contentHash,
        endLine: chunk.endLine,
        fileCanonicalId: fileId,
        path: relativePath,
        startLine: chunk.startLine,
        structuralType: chunk.structuralType,
        symbol: chunk.symbol,
      },
      updatedAt: now,
    });
    graph.addEdge('contains', fileId, chunkId, {confidence: 1, validated: true});

    if (!['class', 'function', 'method'].includes(chunk.structuralType)) {
      relationships.push({
        calls: [],
        dependencies: chunk.dependencies ?? [],
        fileId,
        relativePath,
      });
      continue;
    }

    const entityType = chunk.structuralType === 'class' ? 'class' : 'function';
    const symbol = chunk.symbol.replace(/ \[part \d+\]$/, '');
    const symbolKey = `${fileId}:${entityType}:${symbol}`;
    let symbolId = symbols.get(symbolKey);
    if (!symbolId) {
      symbolId = generateCanonicalId(entityType, {
        fileCanonicalId: fileId,
        name: symbol,
      });
      symbols.set(symbolKey, symbolId);
      graph.addEntity({
        canonicalId: symbolId,
        confidence: 1,
        createdAt: now,
        entityType,
        label: symbol,
        properties: {
          fileCanonicalId: fileId,
          lineEnd: chunk.endLine,
          lineStart: chunk.startLine,
          name: symbol,
          path: relativePath,
        },
        updatedAt: now,
      });
      graph.addEdge('contains', fileId, symbolId, {confidence: 1, validated: true});
      const simpleName = normalizeSymbolReference(symbol);
      symbolIdsByName.set(simpleName, [...(symbolIdsByName.get(simpleName) ?? []), symbolId]);
    }

    graph.addEdge('embeds', chunkId, symbolId, {confidence: 1, validated: true});
    relationships.push({
      calls: chunk.structuralType === 'class' ? [] : chunk.calls ?? [],
      dependencies: chunk.dependencies ?? [],
      fileId,
      relativePath,
      symbolId,
    });
  }

  const knownPaths = new Set(fileIds.keys());
  for (const relationship of relationships) {
    const dependencyFileIds = addDependencyEdges(graph, relationship, fileIds, knownPaths);
    addCallEdges(graph, relationship, symbolIdsByName, dependencyFileIds);
  }

  await graph.saveSnapshot();
}

async function resolveEmbeddingProvider(
  options: SemanticIndexInitializerOptions,
): Promise<{provider: EmbeddingProvider; semanticSearchEnabled: boolean}> {
  let provider = createEmbeddingProvider(options.config);
  if (!provider.testConnection || await provider.testConnection(options.signal)) {
    return {provider, semanticSearchEnabled: true};
  }

  logToStderr(
    `[SemanticIndex] Embedding provider "${provider.name}" failed health check. Attempting fallback...`,
  );
  const fallback = new OllamaEmbeddingProvider();
  if (await fallback.testConnection(options.signal)) {
    logToStderr('[SemanticIndex] Falling back to local Ollama embeddings.');
    provider = fallback;
    return {provider, semanticSearchEnabled: true};
  }

  const warning = 'Embeddings unavailable: continuing with AST and lexical indexing only. ' +
    'Install Ollama and pull nomic-embed-text to enable semantic similarity.';
  logToStderr('[SemanticIndex] Embeddings unavailable. Continuing with lexical indexing.');
  options.onWarning(warning);
  return {provider: new NullEmbeddingProvider(), semanticSearchEnabled: false};
}

async function createAndInitializeIndex(
  options: SemanticIndexInitializerOptions,
  provider: EmbeddingProvider,
  semanticSearchEnabled: boolean,
): Promise<SemanticIndex> {
  const index = new SemanticIndex({
    maxChunkChars: options.config.indexing?.maxChunkChars ?? 4000,
    provider,
    rootPath: options.targetPath,
    semanticSearchEnabled,
    // Keep the content-addressed index with the target so unchanged chunks
    // are reused across runs instead of paying the embedding cost per run.
    storagePath: path.join(options.targetPath, '.shadow-auditor', 'semantic-index'),
  });
  await index.initialize();
  return index;
}

function reportIndexingResult(
  options: SemanticIndexInitializerOptions,
  index: SemanticIndex,
  stats: Awaited<ReturnType<SemanticIndex['indexRepository']>>,
): void {
  logToStderr(
    `[SemanticIndex] Indexing complete: ${stats.filesIndexed}/${stats.filesDiscovered} files, ` +
    `${stats.chunksIndexed} chunks, ${stats.filesSkipped} skipped`,
  );
  if (stats.filesSkipped === 0) return;

  const diagnostics = index.getIndexingDiagnostics()
    .slice(0, 5)
    .map(({filePath, reason}) => `${path.relative(options.targetPath, filePath)}: ${reason}`)
    .join('; ');
  options.onWarning(
    `Semantic indexing skipped ${stats.filesSkipped} file(s).` +
    (diagnostics ? ` ${diagnostics}` : ''),
  );
}

async function indexRepository(
  options: SemanticIndexInitializerOptions,
  initialIndex: SemanticIndex,
): Promise<SemanticIndex> {
  try {
    const stats = await initialIndex.indexRepository((progress) => {
      if (progress.filesProcessed % 50 !== 0 && progress.filesProcessed !== progress.totalFiles) return;
      logToStderr(
        `[SemanticIndex] Processed ${progress.filesProcessed}/${progress.totalFiles} files; ` +
        `${progress.filesIndexed} indexed (${progress.currentFile})`,
      );
    }, options.signal);
    reportIndexingResult(options, initialIndex, stats);
    return initialIndex;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const warning = `Embeddings failed during indexing; continuing with AST and lexical retrieval: ${
      error instanceof Error ? error.message : String(error)
    }`;
    logToStderr('[SemanticIndex] Embeddings failed. Rebuilding the lexical index without vectors.');
    options.onWarning(warning);
    const fallbackIndex = await createAndInitializeIndex(
      options,
      new NullEmbeddingProvider(),
      false,
    );
    await fallbackIndex.indexRepository(undefined, options.signal);
    return fallbackIndex;
  }
}

async function createRetrievalTools(
  options: SemanticIndexInitializerOptions,
  index: SemanticIndex,
): Promise<ToolSet> {
  if (!options.missionEngine) return {};

  const graph = options.missionEngine.getGraph();
  const retrieval = options.missionEngine.getRetrieval();
  try {
    await populateIndexKnowledgeGraph(graph, index, options.targetPath);
  } catch (error) {
    const warning = `Knowledge graph population failed; semantic and lexical retrieval remain available: ${
      error instanceof Error ? error.message : String(error)
    }`;
    logToStderr(`[SemanticIndex] ${warning}`);
    options.onWarning(warning);
  }

  const retriever = new HybridRetriever(graph, retrieval, index, { rootPath: options.targetPath });
  retrieval.setHybridRetriever(retriever);
  return {
    context_retrieval: createContextRetrievalTool({
      retriever,
      rootPath: options.targetPath,
    }),
  };
}

export async function initializeSemanticIndex(
  options: SemanticIndexInitializerOptions,
): Promise<SemanticIndexInitialization> {
  const indexingConfig = options.config.indexing;
  if (indexingConfig?.enabled === false) {
    return { index: null, tools: {} };
  }

  try {
    options.signal?.throwIfAborted();
    const {provider, semanticSearchEnabled} = await resolveEmbeddingProvider(options);
    const initialIndex = await createAndInitializeIndex(options, provider, semanticSearchEnabled);
    const index = await indexRepository(options, initialIndex);
    const tools = await createRetrievalTools(options, index);
    return {index, tools};
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const warning = `Semantic indexing initialization failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    logToStderr('[SemanticIndex] Embeddings unavailable or misconfigured. Disabling semantic search.');
    options.onWarning(warning);
    return { index: null, tools: {} };
  }
}
