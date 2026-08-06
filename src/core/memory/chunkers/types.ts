/**
 * Shared chunk interfaces used by all chunkers and the SemanticIndex.
 */

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
