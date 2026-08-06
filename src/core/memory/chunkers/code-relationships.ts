import type {Parser} from '../tree-sitter-languages.js';

export interface CodeRelationships {
  calls: string[];
  dependencies: string[];
}

const CALL_NODE_TYPES = new Set([
  'call',
  'call_expression',
  'function_call',
  'function_call_expression',
  'invocation_expression',
  'method_invocation',
]);

const DEPENDENCY_NODE_TYPES = new Set([
  'import_declaration',
  'import_from_statement',
  'import_statement',
  'include_expression',
  'include_statement',
  'preproc_include',
  'require_expression',
  'require_statement',
  'use_declaration',
  'using_directive',
]);

function extractCallTarget(node: Parser.SyntaxNode): string | undefined {
  const target = node.childForFieldName('function') ??
    node.childForFieldName('name') ??
    node.childForFieldName('method') ??
    node.namedChildren[0];
  const value = target?.text.trim();
  return value && value.length <= 200 ? value : undefined;
}

function extractDependencyTarget(text: string): string | undefined {
  const quoted = text.match(/["'<]([^"'>]+)[">']/)?.[1];
  if (quoted) return quoted;

  const moduleName = text.match(
    /^(?:from|import|use|using)\s+([A-Za-z_][\w./:-]*)/,
  )?.[1];
  return moduleName?.replaceAll('::', '/').replaceAll('.', '/');
}

export function extractCodeRelationships(root: Parser.SyntaxNode): CodeRelationships {
  const calls = new Set<string>();
  const dependencies = new Set<string>();

  function walk(node: Parser.SyntaxNode): void {
    if (CALL_NODE_TYPES.has(node.type)) {
      const target = extractCallTarget(node);
      if (target) calls.add(target);
    }

    if (DEPENDENCY_NODE_TYPES.has(node.type)) {
      const target = extractDependencyTarget(node.text.trim());
      if (target) dependencies.add(target);
    }

    for (const child of node.namedChildren) walk(child);
  }

  walk(root);
  return {
    calls: [...calls].sort(),
    dependencies: [...dependencies].sort(),
  };
}
