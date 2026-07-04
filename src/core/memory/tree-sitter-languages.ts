/**
 * Tree-sitter language loader with graceful fallback for missing packages.
 *
 * Dynamically loads available tree-sitter grammars. If a package is not
 * installed, the import fails silently and the language is excluded from
 * the index. This allows the semantic index to work with whatever subset
 * of grammars the user has chosen to install.
 *
 * TypeScript module declarations for all grammar packages are in
 * `src/types/tree-sitter-languages.d.ts`.
 */

import Parser from 'tree-sitter';

const languageLoaders: Record<string, () => Promise<unknown>> = {
  bash: async () => (await import('tree-sitter-bash')).default,
  c: async () => (await import('tree-sitter-c')).default,
  cpp: async () => (await import('tree-sitter-cpp')).default,
  c_sharp: async () => (await import('tree-sitter-c-sharp')).default,
  css: async () => (await import('tree-sitter-css')).default,
  elixir: async () => (await import('tree-sitter-elixir')).default,
  elm: async () => (await import('tree-sitter-elm')).default,
  go: async () => (await import('tree-sitter-go')).default,
  haskell: async () => (await import('tree-sitter-haskell')).default,
  html: async () => (await import('tree-sitter-html')).default,
  java: async () => (await import('tree-sitter-java')).default,
  javascript: async () => (await import('tree-sitter-javascript')).default,
  json: async () => (await import('tree-sitter-json')).default,
  kotlin: async () => (await import('tree-sitter-kotlin')).default,
  lua: async () => (await import('tree-sitter-lua')).default,
  markdown: async () => (await import('tree-sitter-markdown')).default,
  ocaml: async () => (await import('tree-sitter-ocaml')).default,
  php: async () => (await import('tree-sitter-php')).default,
  python: async () => (await import('tree-sitter-python')).default,
  ruby: async () => (await import('tree-sitter-ruby')).default,
  rust: async () => (await import('tree-sitter-rust')).default,
  scala: async () => (await import('tree-sitter-scala')).default,
  solidity: async () => (await import('tree-sitter-solidity')).default,
  sql: async () => (await import('tree-sitter-sql')).default,
  swift: async () => (await import('tree-sitter-swift')).default,
  toml: async () => (await import('tree-sitter-toml')).default,
  typescript: async () => {
    const ts = await import('tree-sitter-typescript');
    return ts.default;
  },
  vue: async () => (await import('tree-sitter-vue')).default,
  yaml: async () => (await import('tree-sitter-yaml')).default,
  zig: async () => (await import('tree-sitter-zig')).default,
};

// ============================================================================
// File extension → language key mapping (55+ extensions)
// ============================================================================

const EXTENSION_MAP: Record<string, { key: string; subkey?: string }> = {
  // JavaScript / TypeScript family
  '.js': { key: 'javascript' },
  '.jsx': { key: 'javascript' },
  '.mjs': { key: 'javascript' },
  '.cjs': { key: 'javascript' },
  '.ts': { key: 'typescript', subkey: 'typescript' },
  '.tsx': { key: 'typescript', subkey: 'tsx' },
  '.mts': { key: 'typescript', subkey: 'typescript' },
  '.cts': { key: 'typescript', subkey: 'typescript' },
  // Python
  '.py': { key: 'python' },
  '.pyi': { key: 'python' },
  '.pyx': { key: 'python' },
  '.pxd': { key: 'python' },
  // Go
  '.go': { key: 'go' },
  // Rust
  '.rs': { key: 'rust' },
  // Java / Kotlin / Scala (JVM)
  '.java': { key: 'java' },
  '.kt': { key: 'kotlin' },
  '.kts': { key: 'kotlin' },
  '.scala': { key: 'scala' },
  '.sc': { key: 'scala' },
  // C / C++ family
  '.c': { key: 'c' },
  '.h': { key: 'c' },
  '.cpp': { key: 'cpp' },
  '.cc': { key: 'cpp' },
  '.cxx': { key: 'cpp' },
  '.hpp': { key: 'cpp' },
  '.hh': { key: 'cpp' },
  // C#
  '.cs': { key: 'c_sharp' },
  // Ruby
  '.rb': { key: 'ruby' },
  '.erb': { key: 'ruby' },
  // PHP
  '.php': { key: 'php' },
  '.phtml': { key: 'php' },
  // Swift
  '.swift': { key: 'swift' },
  // Haskell / Elm (ML family)
  '.hs': { key: 'haskell' },
  '.lhs': { key: 'haskell' },
  '.elm': { key: 'elm' },
  // Elixir
  '.ex': { key: 'elixir' },
  '.exs': { key: 'elixir' },
  // Lua
  '.lua': { key: 'lua' },
  // Zig
  '.zig': { key: 'zig' },
  '.zon': { key: 'zig' },
  // Solidity
  '.sol': { key: 'solidity' },
  // Bash / Shell
  '.sh': { key: 'bash' },
  '.bash': { key: 'bash' },
  '.zsh': { key: 'bash' },
  // SQL
  '.sql': { key: 'sql' },
  // OCaml
  '.ml': { key: 'ocaml' },
  '.mli': { key: 'ocaml' },
  // Web: HTML / CSS / Vue
  '.html': { key: 'html' },
  '.htm': { key: 'html' },
  '.css': { key: 'css' },
  '.vue': { key: 'vue' },
  // Data / Config: JSON / YAML / TOML / Markdown
  '.json': { key: 'json' },
  '.yaml': { key: 'yaml' },
  '.yml': { key: 'yaml' },
  '.toml': { key: 'toml' },
  '.md': { key: 'markdown' },
  '.mdx': { key: 'markdown' },
};

// ============================================================================
// Language metadata
// ============================================================================

const STRUCTURED_LANGUAGE_KEYS = new Set([
  'bash', 'c', 'cpp', 'c_sharp', 'elixir', 'elm', 'go', 'haskell',
  'java', 'javascript', 'kotlin', 'lua', 'ocaml', 'php', 'python',
  'ruby', 'rust', 'scala', 'solidity', 'swift', 'typescript', 'zig',
]);

const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  javascript: 'javascript', typescript: 'typescript',
  python: 'python', go: 'go', rust: 'rust',
  java: 'java', kotlin: 'kotlin', scala: 'scala',
  c: 'c', cpp: 'cpp', c_sharp: 'c_sharp',
  ruby: 'ruby', php: 'php', swift: 'swift',
  haskell: 'haskell', elm: 'elm', elixir: 'elixir',
  lua: 'lua', zig: 'zig', solidity: 'solidity',
  bash: 'bash', sql: 'sql', ocaml: 'ocaml',
  html: 'html', css: 'css', vue: 'vue',
  json: 'json', yaml: 'yaml', toml: 'toml', markdown: 'markdown',
};

// ============================================================================
// Public API
// ============================================================================

export interface LanguageInfo {
  /** Language key for internal use */
  key: string;
  /** Human-readable language name */
  name: string;
  /** Whether this language has function/class AST structure */
  isStructured: boolean;
  /** Factory function that returns a tree-sitter Language (or throws) */
  load: () => Promise<unknown>;
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
    key: entry.key,
    name: LANGUAGE_DISPLAY_NAMES[entry.key] ?? entry.key,
    isStructured: STRUCTURED_LANGUAGE_KEYS.has(entry.key),
    load: entry.subkey
      ? async () => {
          const result = await loader();
          return (result as Record<string, unknown>)[entry.subkey!];
        }
      : loader,
  };
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
export { Parser };
