import { expect } from 'chai';
import { describe, it } from 'mocha';
import { z } from 'zod';

import type { ToolEntry } from '../../src/core/graph/tool-retriever.js';

import { ToolRetriever } from '../../src/core/graph/tool-retriever.js';

describe('ToolRetriever', () => {
  const tools: ToolEntry[] = [
    {
      name: 'read_file',
      tool: {
        description: 'Read the contents of a file.',
        execute: async () => 'content',
        inputSchema: z.object({}),
      },
    },
    {
      name: 'search_codebase',
      tool: {
        description: 'Search the codebase for patterns.',
        execute: async () => 'results',
        inputSchema: z.object({}),
      },
    },
    {
      name: 'execute_command',
      tool: {
        description: 'Run a shell command.',
        execute: async () => 'output',
        inputSchema: z.object({}),
      },
    },
  ];

  it('returns all tools when there are fewer than topK', async () => {
    const retriever = new ToolRetriever(tools, { topK: 5 });
    const selected = await retriever.retrieve([]);
    expect(selected).to.have.lengthOf(3);
  });

  it('selects top-K relevant tools by keyword', async () => {
    const retriever = new ToolRetriever(tools, { topK: 2 });
    const messages = [
      { content: 'read the file content for me', role: 'user' },
    ] as { content: string; role: string }[];

    const selected = await retriever.retrieve(messages as never);
    expect(selected).to.have.lengthOf(2);
    expect(selected.map((t) => t.name)).to.include('read_file');
  });
});
