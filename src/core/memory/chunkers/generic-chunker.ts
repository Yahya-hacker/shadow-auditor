/**
 * Generic cross-language chunker for structured languages other than JS/TS.
 *
 * Walks top-level named children and chunks at function-like and class-like
 * boundaries. Uses common tree-sitter node type patterns that work across
 * Python, Go, Rust, Java, C/C++, C#, Ruby, PHP, Swift, Kotlin, Scala,
 * Haskell, Elixir, Elm, Lua, Zig, Solidity, Bash, and OCaml.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';

import type { Parser } from '../tree-sitter-languages.js';
import type { CodeChunk } from './types.js';

import {finalizeChunks} from './chunk-windows.js';
import {extractCodeRelationships} from './code-relationships.js';

/**
 * Tree-sitter node types that represent function/method definitions across
 * common languages.
 */
const FUNCTION_LIKE_TYPES = new Set([
  'arrow_function', 'constructor_declaration', 'func_literal',
  'function', 'function_declaration', 'function_definition',
  'function_item', 'method',
  'method_declaration', 'method_definition',
]);

/**
 * Tree-sitter node types that represent class/struct/interface/module
 * definitions across common languages.
 */
const CLASS_LIKE_TYPES = new Set([
  'class', 'class_declaration', 'class_definition',
  'enum_declaration', 'impl_item',
  'interface_declaration', 'module', 'struct_declaration',
  'struct_item', 'trait_item', 'type_declaration',
]);

/**
 * Node types that should be skipped (not chunked) — imports, includes,
 * package declarations, and other boilerplate.
 */
const SKIP_TYPES = new Set([
  'block_comment', 'comment', 'import_declaration',
  'import_from_statement', 'import_statement', 'include_statement',
  'line_comment', 'package_clause', 'package_declaration',
  'preproc_def', 'preproc_if', 'preproc_ifdef',
  'preproc_include', 'require_statement', 'use_declaration', 'using_directive',
]);

function extractDeclaredName(node: Parser.SyntaxNode): string | undefined {
  const name = node.childForFieldName('name');
  if (name) return name.text;

  const declarator = node.childForFieldName('declarator');
  if (!declarator) return undefined;
  if (declarator.namedChildCount === 0) return declarator.text;
  return extractDeclaredName(declarator);
}

/**
 * Chunk a non-structured file (JSON, YAML, Markdown, SQL, etc.) as a single
 * whole-file fragment.
 */
export function chunkWholeFile(
  sourceCode: string,
  filePath: string,
  language: string,
  maxChunkChars: number,
): CodeChunk[] {
  const lines = sourceCode.split('\n');
  return finalizeChunks([{
    contentHash: crypto.createHash('sha256').update(sourceCode).digest('hex').slice(0, 16),
    endLine: lines.length,
    filePath,
    id: `chunk_${crypto.createHash('sha256').update(`${filePath}:file`).digest('hex').slice(0, 16)}`,
    language,
    parentContext: '',
    rawContent: sourceCode,
    startLine: 1,
    structuralType: 'file_fragment',
    symbol: path.basename(filePath),
  }], sourceCode, {filePath, language, maxChunkChars});
}

/**
 * Generic cross-language chunker for structured languages.
 */
export interface GenericChunkOptions {
  filePath: string;
  language: string;
  maxChunkChars: number;
  root: Parser.SyntaxNode;
  sourceCode: string;
}

export function chunkGeneric(options: GenericChunkOptions): CodeChunk[] {
  const {filePath, language, maxChunkChars, root, sourceCode} = options;
  const chunks: CodeChunk[] = [];
  const lines = sourceCode.split('\n');
  const fileDependencies = extractCodeRelationships(root).dependencies;

  function createChunk(
    node: Parser.SyntaxNode,
    structuralType: string,
    symbol: string,
  ): CodeChunk {
    const rawContent = node.text;
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const relationships = extractCodeRelationships(node);

    return {
      calls: relationships.calls,
      contentHash: crypto.createHash('sha256').update(rawContent).digest('hex').slice(0, 16),
      dependencies: fileDependencies,
      endLine,
      filePath,
      id: `chunk_${crypto.createHash('sha256').update(`${filePath}:${startLine}:${endLine}`).digest('hex').slice(0, 16)}`,
      language,
      parentContext: '',
      rawContent,
      startLine,
      structuralType,
      symbol,
    };
  }

  const seen = new Set<string>();
  function addChunk(node: Parser.SyntaxNode, structuralType: string, symbol: string): void {
    const key = `${node.startIndex}:${node.endIndex}:${structuralType}`;
    if (seen.has(key)) return;
    seen.add(key);
    chunks.push(createChunk(node, structuralType, symbol));
  }

  function walk(parent: Parser.SyntaxNode, depth: number): void {
    for (const child of parent.namedChildren) {
      const childType = child.type;

      if (SKIP_TYPES.has(childType)) continue;

      if (FUNCTION_LIKE_TYPES.has(childType)) {
        const name = extractDeclaredName(child) ?? 'anonymous';
        addChunk(child, depth > 1 ? 'method' : 'function', name);
        continue;
      }

      if (CLASS_LIKE_TYPES.has(childType)) {
        const name = child.childForFieldName('name')?.text ?? 'Anonymous';
        addChunk(child, 'class', name);
        const body = child.childForFieldName('body') ??
          child.childForFieldName('declaration_list');
        if (body) walk(body, depth + 1);
        continue;
      }

      // Keep top-level declarations in the index, then descend through
      // namespaces/modules so PHP, C++, Ruby, and similar nested definitions
      // expose their actual functions and classes.
      if (depth === 0 && child.text.length > 20) {
        const name = child.childForFieldName('name')?.text;
        addChunk(child, 'declaration', name ?? childType);
      }

      if (child.namedChildCount > 0) walk(child, depth + 1);
    }
  }

  walk(root, 0);

  // Fallback: if no chunks were found, capture the whole file
  if (chunks.length === 0 && sourceCode.trim().length > 0) {
    chunks.push({
      contentHash: crypto.createHash('sha256').update(sourceCode).digest('hex').slice(0, 16),
      endLine: lines.length,
      filePath,
      id: `chunk_${crypto.createHash('sha256').update(`${filePath}:file`).digest('hex').slice(0, 16)}`,
      language,
      parentContext: '',
      rawContent: sourceCode,
      startLine: 1,
      structuralType: 'file_fragment',
      symbol: path.basename(filePath),
    });
  }

  return finalizeChunks(chunks, sourceCode, {filePath, language, maxChunkChars});
}
