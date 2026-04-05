import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Node types whose structural signatures we extract
const STRUCTURAL_TYPES = new Set([
  'import_statement',
  'class_declaration',
  'function_declaration',
  'method_definition',
  'export_statement',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'arrow_function',
  'lexical_declaration',
]);

// Directories to skip during traversal
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '__pycache__',
  '.turbo',
  '.cache',
]);

/**
 * Recursively collects all .js and .ts files from the given directory
 */
async function collectFiles(dirPath: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return; // silently skip unreadable directories
    }

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (['.js', '.ts', '.tsx', '.jsx'].includes(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  await walk(dirPath);
  return results.sort();
}

/**
 * Gets the correct parser language for a file extension
 */
function getLanguage(filePath: string): unknown | null {
  const ext = path.extname(filePath);
  switch (ext) {
    case '.ts':
    case '.tsx':
      return TypeScript.typescript;
    case '.js':
    case '.jsx':
      return JavaScript;
    default:
      return null;
  }
}

/**
 * Extracts the structural skeleton from a single node.
 * For functions/methods, we return only the signature line (no body).
 */
function extractSignature(node: Parser.SyntaxNode, sourceCode: string): string {
  // For import statements, return the full text
  if (node.type === 'import_statement') {
    return node.text;
  }

  // For export statements, extract the child declaration
  if (node.type === 'export_statement') {
    const declaration = node.namedChildren.find(
      (c) =>
        c.type === 'function_declaration' ||
        c.type === 'class_declaration' ||
        c.type === 'lexical_declaration' ||
        c.type === 'interface_declaration' ||
        c.type === 'type_alias_declaration' ||
        c.type === 'enum_declaration',
    );

    if (declaration) {
      return `export ${extractSignature(declaration, sourceCode)}`;
    }

    // Default export or re-export
    return node.text.length > 200 ? node.text.slice(0, 200) + ' ...' : node.text;
  }

  // For classes, extract class signature + method signatures
  if (node.type === 'class_declaration') {
    const name = node.childForFieldName('name')?.text ?? 'Anonymous';
    const superClass = node.childForFieldName('superclass');
    let header = `class ${name}`;
    if (superClass) header += ` extends ${superClass.text}`;
    header += ' {';

    const body = node.childForFieldName('body');
    const methods: string[] = [];
    if (body) {
      for (const child of body.namedChildren) {
        if (child.type === 'method_definition') {
          methods.push(`  ${extractMethodSignature(child)}`);
        } else if (child.type === 'public_field_definition' || child.type === 'property_definition') {
          methods.push(`  ${child.text};`);
        }
      }
    }

    return `${header}\n${methods.join('\n')}\n}`;
  }

  // For function declarations, extract only the signature
  if (node.type === 'function_declaration') {
    return extractFunctionSignature(node);
  }

  // For interfaces
  if (node.type === 'interface_declaration') {
    return node.text.length > 500 ? node.text.slice(0, 500) + '\n  ...\n}' : node.text;
  }

  // For type aliases
  if (node.type === 'type_alias_declaration') {
    return node.text.length > 300 ? node.text.slice(0, 300) + ' ...' : node.text;
  }

  // For enums
  if (node.type === 'enum_declaration') {
    return node.text.length > 300 ? node.text.slice(0, 300) + ' ...' : node.text;
  }

  // For lexical declarations (const/let with arrow functions)
  if (node.type === 'lexical_declaration') {
    for (const declarator of node.namedChildren) {
      if (declarator.type === 'variable_declarator') {
        const value = declarator.childForFieldName('value');
        if (value && (value.type === 'arrow_function' || value.type === 'function')) {
          const name = declarator.childForFieldName('name')?.text ?? 'anonymous';
          const params = value.childForFieldName('parameters')?.text ?? '()';
          const returnType = value.childForFieldName('return_type')?.text ?? '';
          const typeAnnotation = declarator.childForFieldName('type')?.text ?? '';
          const keyword = node.children[0]?.text ?? 'const';
          let sig = `${keyword} ${name}`;
          if (typeAnnotation) sig += `: ${typeAnnotation}`;
          sig += ` = ${params}${returnType ? ` ${returnType}` : ''} => { ... }`;
          return sig;
        }
      }
    }

    // Non-function lexical declarations that are exported
    return node.text.length > 200 ? node.text.slice(0, 200) + ' ...' : node.text;
  }

  return node.text.length > 200 ? node.text.slice(0, 200) + ' ...' : node.text;
}

/**
 * Extracts function signature without body
 */
function extractFunctionSignature(node: Parser.SyntaxNode): string {
  const asyncKeyword = node.children.some((c) => c.type === 'async') ? 'async ' : '';
  const name = node.childForFieldName('name')?.text ?? 'anonymous';
  const params = node.childForFieldName('parameters')?.text ?? '()';
  const returnType = node.childForFieldName('return_type')?.text ?? '';
  const typeParams = node.childForFieldName('type_parameters')?.text ?? '';

  return `${asyncKeyword}function ${name}${typeParams}${params}${returnType ? ` ${returnType}` : ''} { ... }`;
}

/**
 * Extracts method signature without body
 */
function extractMethodSignature(node: Parser.SyntaxNode): string {
  const isAsync = node.children.some((c) => c.type === 'async');
  const isStatic = node.children.some((c) => c.text === 'static');
  const accessModifier = node.children.find((c) => ['public', 'private', 'protected'].includes(c.text))?.text;
  const name = node.childForFieldName('name')?.text ?? 'anonymous';
  const params = node.childForFieldName('parameters')?.text ?? '()';
  const returnType = node.childForFieldName('return_type')?.text ?? '';

  let sig = '';
  if (accessModifier) sig += `${accessModifier} `;
  if (isStatic) sig += 'static ';
  if (isAsync) sig += 'async ';
  sig += `${name}${params}${returnType ? ` ${returnType}` : ''} { ... }`;

  return sig;
}

/**
 * Parses a single file and returns its structural skeleton
 */
async function parseFile(parser: Parser, filePath: string, basePath: string): Promise<string | null> {
  const language = getLanguage(filePath);
  if (!language) return null;

  let sourceCode: string;
  try {
    sourceCode = await fs.readFile(filePath, 'utf-8');
  } catch {
    return null; // Silently skip unreadable files
  }

  if (sourceCode.trim().length === 0) return null;

  try {
    parser.setLanguage(language as Parameters<Parser['setLanguage']>[0]);
    const tree = parser.parse(sourceCode);
    const root = tree.rootNode;

    const signatures: string[] = [];

    for (const child of root.namedChildren) {
      if (
        STRUCTURAL_TYPES.has(child.type) ||
        child.type === 'export_statement'
      ) {
        const sig = extractSignature(child, sourceCode);
        if (sig.trim()) {
          signatures.push(sig);
        }
      }
    }

    if (signatures.length === 0) return null;

    const relativePath = path.relative(basePath, filePath);
    return `\n// ─── ${relativePath} ${'─'.repeat(Math.max(0, 60 - relativePath.length))}\n${signatures.join('\n\n')}`;
  } catch (error) {
    const relativePath = path.relative(basePath, filePath);
    console.warn(`⚠  Tree-sitter parse error in ${relativePath}: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Generates a compressed repository map for the given directory.
 * Returns a single string containing all structural signatures.
 */
export async function generateRepoMap(targetPath: string): Promise<string> {
  const resolvedPath = path.resolve(targetPath);
  const parser = new Parser();
  const files = await collectFiles(resolvedPath);

  if (files.length === 0) {
    return '// No JavaScript/TypeScript files found in the target directory.';
  }

  const results: string[] = [
    `// ╔══════════════════════════════════════════════════════════════════╗`,
    `// ║  SHADOW-AUDITOR :: COMPRESSED REPO MAP                        ║`,
    `// ║  Target: ${resolvedPath.padEnd(54)}║`,
    `// ║  Files Scanned: ${String(files.length).padEnd(46)}║`,
    `// ╚══════════════════════════════════════════════════════════════════╝`,
  ];

  let parsedCount = 0;
  for (const file of files) {
    const result = await parseFile(parser, file, resolvedPath);
    if (result) {
      results.push(result);
      parsedCount++;
    }
  }

  results.push(`\n// ─── END OF REPO MAP (${parsedCount} files mapped) ${'─'.repeat(35)}`);

  return results.join('\n');
}
