import type { ToolSet } from 'ai';

import * as path from 'node:path';

import type { ShadowConfig } from '../../utils/config.js';
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

export async function populateIndexKnowledgeGraph(
  graph: KnowledgeGraph,
  index: SemanticIndex,
  rootPath: string,
): Promise<void> {
  const now = new Date().toISOString();
  const symbols = new Map<string, string>();

  for (const chunk of index.getAllChunks()) {
    const relativePath = path.relative(rootPath, chunk.filePath).replaceAll('\\', '/');
    const fileId = fileCanonicalId(relativePath);
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

    if (!['class', 'function', 'method'].includes(chunk.structuralType)) continue;
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
    }

    graph.addEdge('embeds', chunkId, symbolId, {confidence: 1, validated: true});
  }

  await graph.saveSnapshot();
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
    let provider = createEmbeddingProvider(options.config);
    let semanticSearchEnabled = true;
    if (provider.testConnection && !(await provider.testConnection(options.signal))) {
      logToStderr(
        `[SemanticIndex] Embedding provider "${provider.name}" failed health check. Attempting fallback...`,
      );
      const fallback = new OllamaEmbeddingProvider();
      if (await fallback.testConnection(options.signal)) {
        logToStderr('[SemanticIndex] Falling back to local Ollama embeddings.');
        provider = fallback;
      } else {
        const warning = 'Embeddings unavailable: continuing with AST and lexical indexing only. ' +
          'Install Ollama and pull nomic-embed-text to enable semantic similarity.';
        logToStderr('[SemanticIndex] Embeddings unavailable. Continuing with lexical indexing.');
        options.onWarning(warning);
        provider = new NullEmbeddingProvider();
        semanticSearchEnabled = false;
      }
    }

    let index = new SemanticIndex({
      maxChunkChars: indexingConfig?.maxChunkChars ?? 4000,
      provider,
      rootPath: options.targetPath,
      semanticSearchEnabled,
      // Keep the content-addressed index with the target so unchanged chunks
      // are reused across runs instead of paying the embedding cost per run.
      storagePath: path.join(options.targetPath, '.shadow-auditor', 'semantic-index'),
    });
    await index.initialize();

    try {
      const stats = await index.indexRepository((progress) => {
        if (
          progress.filesProcessed % 50 === 0 ||
          progress.filesProcessed === progress.totalFiles
        ) {
          logToStderr(
            `[SemanticIndex] Processed ${progress.filesProcessed}/${progress.totalFiles} files; ` +
            `${progress.filesIndexed} indexed (${progress.currentFile})`,
          );
        }
      }, options.signal);
      logToStderr(
        `[SemanticIndex] Indexing complete: ${stats.filesIndexed}/${stats.filesDiscovered} files, ` +
        `${stats.chunksIndexed} chunks, ${stats.filesSkipped} skipped`,
      );
      if (stats.filesSkipped > 0) {
        const diagnostics = index.getIndexingDiagnostics()
          .slice(0, 5)
          .map(({filePath, reason}) => `${path.relative(options.targetPath, filePath)}: ${reason}`)
          .join('; ');
        options.onWarning(
          `Semantic indexing skipped ${stats.filesSkipped} file(s).` +
          (diagnostics ? ` ${diagnostics}` : ''),
        );
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const warning = `Embeddings failed during indexing; continuing with AST and lexical retrieval: ${
        error instanceof Error ? error.message : String(error)
      }`;
      logToStderr('[SemanticIndex] Embeddings failed. Rebuilding the lexical index without vectors.');
      options.onWarning(warning);
      index = new SemanticIndex({
        maxChunkChars: indexingConfig?.maxChunkChars ?? 4000,
        provider: new NullEmbeddingProvider(),
        rootPath: options.targetPath,
        semanticSearchEnabled: false,
        storagePath: path.join(options.targetPath, '.shadow-auditor', 'semantic-index'),
      });
      await index.initialize();
      await index.indexRepository(undefined, options.signal);
    }

    if (!options.missionEngine) {
      return { index, tools: {} };
    }

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
      index,
      tools: {
        context_retrieval: createContextRetrievalTool({
          retriever,
          rootPath: options.targetPath,
        }),
      },
    };
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
