/**
 * JS/TS AST-aware chunker.
 *
 * Uses detailed Tree-sitter AST knowledge of JavaScript and TypeScript
 * syntax to chunk at function, class, method, interface, and export
 * boundaries with parent scope context.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';

import type { Parser } from '../tree-sitter-languages.js';
import type { CodeChunk } from './types.js';

import {finalizeChunks} from './chunk-windows.js';
import {extractCodeRelationships} from './code-relationships.js';

/** AST node types that represent meaningful code boundaries (JS/TS-specific) */
const _CHUNK_BOUNDARY_TYPES = new Set([
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
 * Chunk a parsed JS/TS AST into semantically meaningful code blocks.
 * Handles JS/TS with detailed AST knowledge.
 */
export interface JsTsChunkOptions {
  filePath: string;
  language: string;
  maxChunkChars: number;
  root: Parser.SyntaxNode;
  sourceCode: string;
}

type ChunkFactory = (
  node: Parser.SyntaxNode,
  structuralType: string,
  symbol: string,
  parentContext: string,
) => CodeChunk;

interface ChunkingContext {
  chunks: CodeChunk[];
  createChunk: ChunkFactory;
  fileContext: string;
  maxChunkChars: number;
}

function chunkClass(
  node: Parser.SyntaxNode,
  context: ChunkingContext,
  exportedNode?: Parser.SyntaxNode,
): void {
  const className = node.childForFieldName('name')?.text ?? 'Anonymous';
  const prefix = exportedNode ? 'export ' : '';
  const classContext = `${context.fileContext}\n\n${prefix}${extractClassHeader(node)} {`;
  const body = node.childForFieldName('body');
  if (!body) {
    if (exportedNode) {
      context.chunks.push(context.createChunk(exportedNode, 'class', `export ${className}`, context.fileContext));
    }

    return;
  }

  let hasMethodChunks = false;
  for (const member of body.namedChildren) {
    if (member.type !== 'method_definition') continue;
    const methodName = member.childForFieldName('name')?.text ?? 'anonymous';
    context.chunks.push(context.createChunk(
      member,
      'method',
      `${className}.${methodName}`,
      classContext,
    ));
    hasMethodChunks = true;
  }

  if (!hasMethodChunks || node.text.length <= context.maxChunkChars) {
    const chunkNode = exportedNode ?? node;
    const symbol = exportedNode ? `export ${className}` : className;
    context.chunks.push(context.createChunk(chunkNode, 'class', symbol, context.fileContext));
  }
}

function chunkLexicalDeclaration(
  declaration: Parser.SyntaxNode,
  chunkNode: Parser.SyntaxNode,
  context: ChunkingContext,
  prefix = '',
): void {
  for (const declarator of declaration.namedChildren) {
    if (declarator.type !== 'variable_declarator') continue;
    const value = declarator.childForFieldName('value');
    const name = declarator.childForFieldName('name')?.text ?? 'anonymous';
    const structuralType = value && (value.type === 'arrow_function' || value.type === 'function')
      ? 'function'
      : 'declaration';
    context.chunks.push(context.createChunk(
      chunkNode,
      structuralType,
      `${prefix}${name}`,
      context.fileContext,
    ));
  }
}

function chunkExport(node: Parser.SyntaxNode, context: ChunkingContext): void {
  const declaration = node.namedChildren.find((child) =>
    child.type === 'function_declaration' ||
    child.type === 'class_declaration' ||
    child.type === 'lexical_declaration',
  );
  if (!declaration) {
    if (node.text.length > 20) {
      context.chunks.push(context.createChunk(node, 'export', 'export', context.fileContext));
    }

    return;
  }

  if (declaration.type === 'class_declaration') {
    chunkClass(declaration, context, node);
  } else if (declaration.type === 'function_declaration') {
    const name = declaration.childForFieldName('name')?.text ?? 'anonymous';
    context.chunks.push(context.createChunk(node, 'function', `export ${name}`, context.fileContext));
  } else {
    chunkLexicalDeclaration(declaration, node, context, 'export ');
  }
}

function chunkTopLevelNode(node: Parser.SyntaxNode, context: ChunkingContext): void {
  switch (node.type) {
    case 'class_declaration': {
      chunkClass(node, context);
      break;
    }

    case 'enum_declaration': {
      const name = node.childForFieldName('name')?.text ?? 'anonymous';
      context.chunks.push(context.createChunk(node, 'enum', name, context.fileContext));
      break;
    }

    case 'export_statement': {
      chunkExport(node, context);
      break;
    }

    case 'function_declaration': {
      const name = node.childForFieldName('name')?.text ?? 'anonymous';
      context.chunks.push(context.createChunk(node, 'function', name, context.fileContext));
      break;
    }

    case 'interface_declaration': {
      const name = node.childForFieldName('name')?.text ?? 'anonymous';
      context.chunks.push(context.createChunk(
        node,
        node.type.replace('_declaration', ''),
        name,
        context.fileContext,
      ));
      break;
    }

    case 'lexical_declaration': {
      chunkLexicalDeclaration(node, node, context);
      break;
    }

    case 'type_alias_declaration': {
      const name = node.childForFieldName('name')?.text ?? 'anonymous';
      context.chunks.push(context.createChunk(
        node,
        node.type.replace('_declaration', ''),
        name,
        context.fileContext,
      ));
      break;
    }
  }
}

export function chunkJsTs(options: JsTsChunkOptions): CodeChunk[] {
  const {filePath, language, maxChunkChars, root, sourceCode} = options;
  const fileDependencies = extractCodeRelationships(root).dependencies;
  const lines = sourceCode.split('\n');
  const chunks: CodeChunk[] = [];
  const fileContext = extractFileContext(root);
  const createChunk: ChunkFactory = (
    node: Parser.SyntaxNode,
    structuralType: string,
    symbol: string,
    parentContext: string,
  ) => {
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
      parentContext,
      rawContent,
      startLine,
      structuralType,
      symbol,
    };
  };

  for (const child of root.namedChildren) {
    if (child.type !== 'import_statement') {
      chunkTopLevelNode(child, {chunks, createChunk, fileContext, maxChunkChars});
    }
  }

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
