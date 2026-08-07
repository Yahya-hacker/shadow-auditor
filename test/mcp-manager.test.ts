import { expect } from 'chai';
import { z } from 'zod';

import { MCPManager } from '../src/core/mcp/manager.js';
import { HumanInteractionService } from '../src/utils/human-in-loop.js';

describe('MCP manager policy enforcement', () => {
  it('requests confirmation when tier policy marks a tool sensitive', async () => {
    const humanInteraction = new HumanInteractionService();
    let confirmationCount = 0;
    let executionCount = 0;
    humanInteraction.confirmMcpToolExecution = async () => {
      confirmationCount += 1;
      return false;
    };

    const manager = new MCPManager({
      expertUnsafe: false,
      humanInteraction,
      targetPath: process.cwd(),
    });
    manager.registerAdapter({
      capabilities: ['test'],
      displayName: 'Test adapter',
      id: 'unknown-sensitive-adapter',
      listTools: () => [{
        description: 'A tool whose unknown server defaults to the sensitive tier.',
        async execute() {
          executionCount += 1;
          return 'executed';
        },
        inputSchema: z.object({}),
        name: 'side_effect',
        requiresConfirmation: false,
        riskLevel: 'medium',
      }],
    });

    const wrappedTool = manager.buildAgentTools().mcp_unknown_sensitive_adapter_side_effect;
    expect(wrappedTool?.execute).to.be.a('function');
    const result = await wrappedTool!.execute!({}, { abortSignal: new AbortController().signal } as never);

    expect(result).to.equal(
      '[DENIED] User denied MCP tool execution for unknown-sensitive-adapter.side_effect.',
    );
    expect(confirmationCount).to.equal(1);
    expect(executionCount).to.equal(0);
  });
});
