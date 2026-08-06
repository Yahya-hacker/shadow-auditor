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
export function chunkJsTs(
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
      rawContent,
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
        }
      } else if (child.text.length > 20) {
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
      rawContent: sourceCode,
      startLine: 1,
      structuralType: 'file_fragment',
      symbol: path.basename(filePath),
    });
  }

  return finalizeChunks(chunks, sourceCode, {filePath, language, maxChunkChars});
}
