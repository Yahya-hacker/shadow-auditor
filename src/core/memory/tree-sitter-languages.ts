/**
 * Tree-sitter language loader with graceful fallback for missing packages.
 *
 * Dynamically loads available Tree-sitter grammars. Languages backed by
 * production dependencies receive AST-aware chunking. Recognized extensions
 * without an installed grammar remain available through whole-file lexical
 * chunks and emit an explicit degradation diagnostic.
 *
 * TypeScript module declarations for all grammar packages are in
 * `src/types/tree-sitter-languages.d.ts`.
 */



// Helper: dynamic import via variable so TypeScript doesn't resolve the
// specifier at compile time. Only string-literal imports are statically
// analyzed — variable-based imports are deferred to runtime, which is
// exactly what we want for optional tree-sitter grammars.
const _import = (specifier: string): Promise<unknown> =>
  import(specifier);

function makeLoader(packageName: string): () => Promise<unknown> {
  return async () => {
    const mod = await _import(packageName);
    return (mod as { default: unknown }).default;
  };
}

const languageLoaders: Record<string, () => Promise<unknown>> = {
  bash: makeLoader('tree-sitter-bash'),
  c: makeLoader('tree-sitter-c'),
  c_sharp: makeLoader('tree-sitter-c-sharp'),
  cpp: makeLoader('tree-sitter-cpp'),
  css: makeLoader('tree-sitter-css'),
  elixir: makeLoader('tree-sitter-elixir'),
  elm: makeLoader('tree-sitter-elm'),
  go: makeLoader('tree-sitter-go'),
  haskell: makeLoader('tree-sitter-haskell'),
  html: makeLoader('tree-sitter-html'),
  java: makeLoader('tree-sitter-java'),
  javascript: makeLoader('tree-sitter-javascript'),
  json: makeLoader('tree-sitter-json'),
  kotlin: makeLoader('tree-sitter-kotlin'),
  lua: makeLoader('tree-sitter-lua'),
  markdown: makeLoader('@tree-sitter-grammars/tree-sitter-markdown'),
  ocaml: makeLoader('tree-sitter-ocaml'),
  async php() {
    const module = await _import('tree-sitter-php');
    const exported = (module as {default: {php?: unknown}}).default;
    return exported.php ?? exported;
  },
  python: makeLoader('tree-sitter-python'),
  ruby: makeLoader('tree-sitter-ruby'),
  rust: makeLoader('tree-sitter-rust'),
  scala: makeLoader('tree-sitter-scala'),
  solidity: makeLoader('tree-sitter-solidity'),
  sql: makeLoader('tree-sitter-sql'),
  swift: makeLoader('tree-sitter-swift'),
  toml: makeLoader('@tree-sitter-grammars/tree-sitter-toml'),
  async typescript() {
    const ts = await _import('tree-sitter-typescript');
    return (ts as { default: { tsx: unknown; typescript: unknown; } }).default;
  },
  vue: makeLoader('tree-sitter-vue'),
  yaml: makeLoader('@tree-sitter-grammars/tree-sitter-yaml'),
  zig: makeLoader('tree-sitter-zig'),
};

/** Grammars shipped as production dependencies and covered by integration tests. */
export const GUARANTEED_LANGUAGE_KEYS = Object.freeze([
  'c',
  'c_sharp',
  'cpp',
  'elixir',
  'go',
  'haskell',
  'html',
  'java',
  'javascript',
  'json',
  'markdown',
  'php',
  'python',
  'ruby',
  'rust',
  'scala',
  'toml',
  'typescript',
  'yaml',
] as const);

// ============================================================================
// File extension → language key mapping (55+ extensions)
// ============================================================================

const EXTENSION_MAP: Record<string, { key: string; subkey?: string }> = {
  '.bash': { key: 'bash' },
  // C / C++ family
  '.c': { key: 'c' },
  '.cc': { key: 'cpp' },
  '.cjs': { key: 'javascript' },
  '.cpp': { key: 'cpp' },
  // C#
  '.cs': { key: 'c_sharp' },
  '.css': { key: 'css' },
  '.cts': { key: 'typescript', subkey: 'typescript' },
  '.cxx': { key: 'cpp' },
  '.elm': { key: 'elm' },
  '.erb': { key: 'ruby' },
  // Elixir
  '.ex': { key: 'elixir' },
  '.exs': { key: 'elixir' },
  // Go
  '.go': { key: 'go' },
  '.h': { key: 'c' },
  '.hh': { key: 'cpp' },
  '.hpp': { key: 'cpp' },
  // Haskell / Elm (ML family)
  '.hs': { key: 'haskell' },
  '.htm': { key: 'html' },
  // Web: HTML / CSS / Vue
  '.html': { key: 'html' },
  // Java / Kotlin / Scala (JVM)
  '.java': { key: 'java' },
  // JavaScript / TypeScript family
  '.js': { key: 'javascript' },
  // Data / Config: JSON / YAML / TOML / Markdown
  '.json': { key: 'json' },
  '.jsx': { key: 'javascript' },
  '.kt': { key: 'kotlin' },
  '.kts': { key: 'kotlin' },
  '.lhs': { key: 'haskell' },
  // Lua
  '.lua': { key: 'lua' },
  '.md': { key: 'markdown' },
  '.mdx': { key: 'markdown' },
  '.mjs': { key: 'javascript' },
  // OCaml
  '.ml': { key: 'ocaml' },
  '.mli': { key: 'ocaml' },
  '.mts': { key: 'typescript', subkey: 'typescript' },
  // PHP
  '.php': { key: 'php' },
  '.phtml': { key: 'php' },
  '.pxd': { key: 'python' },
  // Python
  '.py': { key: 'python' },
  '.pyi': { key: 'python' },
  '.pyx': { key: 'python' },
  // Ruby
  '.rb': { key: 'ruby' },
  // Rust
  '.rs': { key: 'rust' },
  '.sc': { key: 'scala' },
  '.scala': { key: 'scala' },
  // Bash / Shell
  '.sh': { key: 'bash' },
  // Solidity
  '.sol': { key: 'solidity' },
  // SQL
  '.sql': { key: 'sql' },
  // Swift
  '.swift': { key: 'swift' },
  '.toml': { key: 'toml' },
  '.ts': { key: 'typescript', subkey: 'typescript' },
  '.tsx': { key: 'typescript', subkey: 'tsx' },
  '.vue': { key: 'vue' },
  '.yaml': { key: 'yaml' },
  '.yml': { key: 'yaml' },
  // Zig
  '.zig': { key: 'zig' },
  '.zon': { key: 'zig' },
  '.zsh': { key: 'bash' },
};

// ============================================================================
// Language metadata
// ============================================================================

const STRUCTURED_LANGUAGE_KEYS = new Set([
  'bash', 'c', 'c_sharp', 'cpp', 'elixir', 'elm', 'go', 'haskell',
  'java', 'javascript', 'kotlin', 'lua', 'ocaml', 'php', 'python',
  'ruby', 'rust', 'scala', 'solidity', 'swift', 'typescript', 'zig',
]);

const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  bash: 'bash', c: 'c',
  c_sharp: 'c_sharp', cpp: 'cpp', css: 'css',
  elixir: 'elixir', elm: 'elm', go: 'go',
  haskell: 'haskell', html: 'html', java: 'java',
  javascript: 'javascript', json: 'json', kotlin: 'kotlin',
  lua: 'lua', markdown: 'markdown', ocaml: 'ocaml',
  php: 'php', python: 'python', ruby: 'ruby',
  rust: 'rust', scala: 'scala', solidity: 'solidity',
  sql: 'sql', swift: 'swift', toml: 'toml',
  typescript: 'typescript', vue: 'vue', yaml: 'yaml', zig: 'zig',
};

// ============================================================================
// Public API
// ============================================================================

export interface LanguageInfo {
  /** Whether this language has function/class AST structure */
  isStructured: boolean;
  /** Language key for internal use */
  key: string;
  /** Factory function that returns a tree-sitter Language (or throws) */
  load: () => Promise<unknown>;
  /** Human-readable language name */
  name: string;
}

/** Supported file extensions (computed at init time) */
export function getSupportedExtensions(): string[] {
  return Object.keys(EXTENSION_MAP);
}

/** Get the language info for a file extension, or null if unsupported */
export function getLanguageForExt(ext: string): LanguageInfo | null {
  const entry = EXTENSION_MAP[ext];
  if (!entry) return null;

  const loader = languageLoaders[entry.key];
  if (!loader) return null;

  return {
    isStructured: STRUCTURED_LANGUAGE_KEYS.has(entry.key),
    key: entry.key,
    load: entry.subkey
      ? async () => {
          const result = await loader();
          return (result as Record<string, unknown>)[entry.subkey!];
        }
      : loader,
    name: LANGUAGE_DISPLAY_NAMES[entry.key] ?? entry.key,
  };
}

export function isSupportedSourceExtension(ext: string): boolean {
  return Object.hasOwn(EXTENSION_MAP, ext);
}

/** Check if a language is structured (function/class AST) */
export function isStructuredLanguage(key: string): boolean {
  return STRUCTURED_LANGUAGE_KEYS.has(key);
}

/** Get available language keys */
export function getAvailableLanguageKeys(): string[] {
  return Object.keys(languageLoaders);
}

// Re-export Parser for convenience


export {default as Parser} from 'tree-sitter';