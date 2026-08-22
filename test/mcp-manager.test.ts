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

  it('honors configured serverTiers/toolTiers instead of only expertUnsafe (#42)', async () => {
    const humanInteraction = new HumanInteractionService();
    let executionCount = 0;

    // A server that would default to a dangerous-tier tool, but the config
    // marks the whole server 'safe' so no confirmation and no denial.
    const manager = new MCPManager({
      expertUnsafe: false,
      humanInteraction,
      policy: {
        serverTiers: { 'corp-tools': 'safe' },
        toolTiers: { 'corp-tools.secure_snapshot': 'safe' },
      },
      targetPath: process.cwd(),
    });
    manager.registerAdapter({
      capabilities: ['test'],
      displayName: 'Corp tools',
      id: 'corp-tools',
      listTools: () => [{
        description: 'Snapshot tool; must run without confirmation via configured safe tier.',
        async execute() {
          executionCount += 1;
          return 'executed';
        },
        inputSchema: z.object({}),
        name: 'secure_snapshot',
        requiresConfirmation: false,
        riskLevel: 'low',
      }],
    });

    const wrappedTool = manager.buildAgentTools().mcp_corp_tools_secure_snapshot;
    expect(wrappedTool?.execute).to.be.a('function');
    const result = await wrappedTool!.execute!({}, { abortSignal: new AbortController().signal } as never);

    // Configured tier must bypass confirmation and execute.
    expect(result).to.equal('executed');
    expect(executionCount).to.equal(1);
  });

  it('respects a configured blocked tool tier so it never executes (#42)', async () => {
    const humanInteraction = new HumanInteractionService();
    let executionCount = 0;

    const manager = new MCPManager({
      expertUnsafe: false,
      humanInteraction,
      policy: {
        toolTiers: { 'corp-tools.bad_tool': 'blocked' },
      },
      targetPath: process.cwd(),
    });
    manager.registerAdapter({
      capabilities: ['test'],
      displayName: 'Corp tools',
      id: 'corp-tools',
      listTools: () => [{
        description: 'A tool the operator blocked via config.',
        async execute() {
          executionCount += 1;
          return 'executed';
        },
        inputSchema: z.object({}),
        name: 'bad_tool',
        requiresConfirmation: false,
        riskLevel: 'medium',
      }],
    });

    const wrappedTool = manager.buildAgentTools().mcp_corp_tools_bad_tool;
    const result = await wrappedTool!.execute!({}, { abortSignal: new AbortController().signal } as never);

    expect(result).to.include('[MCP_POLICY_BLOCKED]');
    expect(executionCount).to.equal(0);
  });
});
