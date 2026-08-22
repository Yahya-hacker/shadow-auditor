import type Parser from 'tree-sitter';

const TREE_SITTER_INPUT_CHUNK_SIZE = 32_767;

/**
 * Node 24 rejects the unbounded callback chunks produced by tree-sitter 0.21
 * for sources near 32 KiB. Supplying bounded chunks keeps parsing incremental
 * without changing the grammar ABI shared by the installed language packages.
 */
export function parseTreeSitterSource(parser: Parser, source: string): Parser.Tree {
  return parser.parse((offset) =>
    source.slice(offset, offset + TREE_SITTER_INPUT_CHUNK_SIZE));
}
