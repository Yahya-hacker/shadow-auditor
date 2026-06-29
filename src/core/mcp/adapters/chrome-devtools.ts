import { z } from 'zod';

import type { MCPAdapter, MCPRawInvoker } from '../types.js';

interface ChromeDevtoolsAdapterOptions {
  invoker?: MCPRawInvoker;
}

function unavailableMessage(operation: string): string {
  return `[MCP_UNAVAILABLE] chrome-devtools adapter has no invoker configured for "${operation}".`;
}

export function createChromeDevtoolsAdapter(options: ChromeDevtoolsAdapterOptions = {}): MCPAdapter {
  const {invoker} = options;

  return {
    capabilities: ['browser-observation', 'dom-snapshot', 'network-inspection'],
    displayName: 'Chrome DevTools MCP',
    id: 'chrome-devtools',
    isAvailable: () => typeof invoker === 'function',
    listTools: () => [
      {
        description: 'Capture an accessibility-aware page snapshot.',
        async execute(input: Record<string, unknown>) {
          if (!invoker) {
            return unavailableMessage('take_snapshot');
          }

          return invoker('take_snapshot', input);
        },
        inputSchema: z
          .object({
            verbose: z.boolean().optional(),
          })
          .strict(),
        name: 'take_snapshot',
        requiresConfirmation: true,
        riskLevel: 'low',
      },
      {
        description: 'Retrieve browser console messages.',
        async execute(input: Record<string, unknown>) {
          if (!invoker) {
            return unavailableMessage('console_messages');
          }

          return invoker('console_messages', input);
        },
        inputSchema: z
          .object({
            level: z.enum(['debug', 'error', 'info', 'warning']).optional(),
          })
          .strict(),
        name: 'console_messages',
        requiresConfirmation: true,
        riskLevel: 'low',
      },
      {
        description: 'Retrieve network requests observed in the browser.',
        async execute(input: Record<string, unknown>) {
          if (!invoker) {
            return unavailableMessage('network_requests');
          }

          return invoker('network_requests', input);
        },
        inputSchema: z
          .object({
            includeStatic: z.boolean().optional(),
          })
          .strict(),
        name: 'network_requests',
        requiresConfirmation: true,
        riskLevel: 'medium',
      },
    ],
  };
}
