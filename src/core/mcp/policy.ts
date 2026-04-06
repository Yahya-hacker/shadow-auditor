import type { MCPToolDefinition } from './types.js';

export interface MCPPolicyDecision {
  allowed: boolean;
  reason: string;
  warning?: string;
}

const SAFE_ADAPTER_TOOLS: Record<string, Set<string>> = {
  'chrome-devtools': new Set(['console_messages', 'network_requests', 'take_snapshot']),
  'kali-linux': new Set(['dirb_scan', 'nikto_scan', 'nmap_scan']),
};

const HIGH_RISK_TOOLS = new Set([
  'hydra_attack',
  'metasploit_run',
  'sqlmap_scan',
  'wpscan_analyze',
]);

export function evaluateMcpPolicy(
  adapterId: string,
  toolDefinition: MCPToolDefinition,
  expertUnsafe: boolean,
): MCPPolicyDecision {
  const safeTools = SAFE_ADAPTER_TOOLS[adapterId] ?? new Set<string>();
  const isSafeTool = safeTools.has(toolDefinition.name);
  const isHighRisk = toolDefinition.riskLevel === 'high' || HIGH_RISK_TOOLS.has(toolDefinition.name);

  if (isSafeTool) {
    return {
      allowed: true,
      reason: '[MCP_POLICY_ALLOWED] Tool is allowlisted.',
    };
  }

  if (!expertUnsafe) {
    return {
      allowed: false,
      reason: `[MCP_POLICY_DENIED] ${adapterId}.${toolDefinition.name} is not in the allowlist.`,
    };
  }

  if (isHighRisk) {
    return {
      allowed: true,
      reason: '[MCP_POLICY_ALLOWED] High-risk MCP tool allowed in expert unsafe mode.',
      warning:
        '[EXPERT-UNSAFE] High-risk MCP operation requested. Confirm only when you are authorized and the blast radius is understood.',
    };
  }

  return {
    allowed: true,
    reason: '[MCP_POLICY_ALLOWED] Non-allowlisted MCP tool permitted in expert unsafe mode.',
    warning: '[EXPERT-UNSAFE] MCP tool is outside default policy allowlist.',
  };
}
