import { z } from 'zod';

import type { MCPAdapter, MCPRawInvoker } from '../types.js';

interface KaliLinuxAdapterOptions {
  invoker?: MCPRawInvoker;
}

function unavailableMessage(operation: string): string {
  return `[MCP_UNAVAILABLE] kali-linux adapter has no invoker configured for "${operation}".`;
}

export function createKaliLinuxAdapter(options: KaliLinuxAdapterOptions = {}): MCPAdapter {
  const invoker = options.invoker;

  return {
    capabilities: ['network-scanning', 'web-scanning'],
    displayName: 'Kali Linux MCP',
    id: 'kali-linux',
    isAvailable: () => typeof invoker === 'function',
    listTools: () => [
      {
        description: 'Execute an Nmap scan against a target host.',
        async execute(input: Record<string, unknown>) {
          if (!invoker) {
            return unavailableMessage('nmap_scan');
          }

          return invoker('nmap_scan', input);
        },
        inputSchema: z
          .object({
            additional_args: z.string().optional(),
            ports: z.string().optional(),
            scan_type: z.string().optional(),
            target: z.string().min(1),
          })
          .strict(),
        name: 'nmap_scan',
        requiresConfirmation: true,
        riskLevel: 'medium',
      },
      {
        description: 'Execute a Nikto web server scan.',
        async execute(input: Record<string, unknown>) {
          if (!invoker) {
            return unavailableMessage('nikto_scan');
          }

          return invoker('nikto_scan', input);
        },
        inputSchema: z
          .object({
            additional_args: z.string().optional(),
            target: z.string().min(1),
          })
          .strict(),
        name: 'nikto_scan',
        requiresConfirmation: true,
        riskLevel: 'medium',
      },
      {
        description: 'Execute a Dirb web content discovery scan.',
        async execute(input: Record<string, unknown>) {
          if (!invoker) {
            return unavailableMessage('dirb_scan');
          }

          return invoker('dirb_scan', input);
        },
        inputSchema: z
          .object({
            additional_args: z.string().optional(),
            url: z.string().min(1),
            wordlist: z.string().optional(),
          })
          .strict(),
        name: 'dirb_scan',
        requiresConfirmation: true,
        riskLevel: 'medium',
      },
    ],
  };
}
