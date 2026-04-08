/**
 * MCP Action Policy - Policy tiers for MCP tool invocations.
 */

import { z } from 'zod';

import { SCHEMA_VERSION } from '../schema/base.js';

// =============================================================================
// Schemas
// =============================================================================

export const mcpActionTierSchema = z.enum(['safe', 'sensitive', 'dangerous', 'blocked']);
export type MCPActionTier = z.infer<typeof mcpActionTierSchema>;

export const mcpActionPolicySchema = z.object({
  /** Whether to allow dangerous actions at all */
  allowDangerousActions: z.boolean().default(false),
  
  /** Whether to log all MCP actions */
  auditAllActions: z.boolean().default(true),
  
  /** Expert override flag */
  expertUnsafe: z.boolean().default(false),
  
  /** Whether to require confirmation for dangerous actions */
  requireDangerousConfirmation: z.boolean().default(true),
  
  /** Whether to require confirmation for sensitive actions */
  requireSensitiveConfirmation: z.boolean().default(true),
  
  schemaVersion: z.string().default(SCHEMA_VERSION),
  
  /** Server-specific tier defaults */
  serverTiers: z.record(z.string(), mcpActionTierSchema).default({}),
  
  /** Tool-specific tier overrides */
  toolTiers: z.record(z.string(), mcpActionTierSchema).default({}),
});

export type MCPActionPolicy = z.infer<typeof mcpActionPolicySchema>;

export const mcpActionDecisionSchema = z.object({
  allowed: z.boolean(),
  reason: z.string(),
  requiresConfirmation: z.boolean(),
  tier: mcpActionTierSchema,
  warning: z.string().optional(),
});

export type MCPActionDecision = z.infer<typeof mcpActionDecisionSchema>;

// =============================================================================
// Default Tier Classifications
// =============================================================================

/**
 * Default tool tiers by category.
 * These are conservative defaults that can be overridden per-project.
 */
const DEFAULT_TOOL_TIERS: Record<string, MCPActionTier> = {
  // Sensitive - Interactive but limited side-effects
  'chrome-devtools.click': 'sensitive',
  // Dangerous - Can execute arbitrary code/commands
  'chrome-devtools.evaluate_script': 'dangerous',
  'chrome-devtools.fill': 'sensitive',
  'chrome-devtools.get_console_message': 'safe',
  'chrome-devtools.get_network_request': 'safe',
  'chrome-devtools.hover': 'sensitive',
  'chrome-devtools.list_console_messages': 'safe',
  
  'chrome-devtools.list_network_requests': 'safe',
  'chrome-devtools.list_pages': 'safe',
  'chrome-devtools.navigate_page': 'sensitive',
  'chrome-devtools.new_page': 'sensitive',
  'chrome-devtools.press_key': 'sensitive',
  'chrome-devtools.take_screenshot': 'safe',
  // Safe - Read-only operations
  'chrome-devtools.take_snapshot': 'safe',
  
  'chrome-devtools.type_text': 'sensitive',
  'kali-official.dirb_scan': 'sensitive',
  'kali-official.enum4linux_scan': 'sensitive',
  'kali-official.execute_command': 'dangerous',
  'kali-official.gobuster_scan': 'sensitive',
  
  'kali-official.hydra_attack': 'dangerous',
  'kali-official.john_crack': 'dangerous',
  'kali-official.metasploit_run': 'dangerous',
  'kali-official.nikto_scan': 'sensitive',
  // Kali tools - varying sensitivity
  'kali-official.nmap_scan': 'sensitive',
  'kali-official.server_health': 'safe',
  'kali-official.sqlmap_scan': 'dangerous',
  'kali-official.wpscan_analyze': 'sensitive',
};

/**
 * Server-level default tiers.
 */
const DEFAULT_SERVER_TIERS: Record<string, MCPActionTier> = {
  'chrome-devtools': 'sensitive',
  'github-mcp-server': 'safe',
  'kali-official': 'dangerous',
  'playwright': 'sensitive',
};

// =============================================================================
// Policy Evaluator
// =============================================================================

/**
 * Evaluates MCP action policy for a specific tool invocation.
 */
export function evaluateMCPPolicy(
  serverName: string,
  toolName: string,
  policy: Partial<MCPActionPolicy> = {},
): MCPActionDecision {
  const fullPolicy = mcpActionPolicySchema.parse(policy);
  const fullToolName = `${serverName}.${toolName}`;
  
  // Determine tier: tool-specific > server-specific > default
  let tier: MCPActionTier;
  
  if (fullPolicy.toolTiers[fullToolName]) {
    tier = fullPolicy.toolTiers[fullToolName];
  } else if (fullPolicy.serverTiers[serverName]) {
    tier = fullPolicy.serverTiers[serverName];
  } else if (DEFAULT_TOOL_TIERS[fullToolName]) {
    tier = DEFAULT_TOOL_TIERS[fullToolName];
  } else if (DEFAULT_SERVER_TIERS[serverName]) {
    tier = DEFAULT_SERVER_TIERS[serverName];
  } else {
    // Unknown tools default to sensitive
    tier = 'sensitive';
  }
  
  // Blocked tier is always denied
  if (tier === 'blocked') {
    return {
      allowed: false,
      reason: `[MCP_POLICY_BLOCKED] Tool ${fullToolName} is blocked by policy.`,
      requiresConfirmation: false,
      tier,
    };
  }
  
  // Dangerous tier requires explicit allow flag
  if (tier === 'dangerous' && !fullPolicy.allowDangerousActions && !fullPolicy.expertUnsafe) {
    return {
      allowed: false,
      reason: `[MCP_POLICY_DENIED] Dangerous tool ${fullToolName} requires allowDangerousActions flag or expertUnsafe mode.`,
      requiresConfirmation: false,
      tier,
    };
  }
  
  // Determine confirmation requirement
  const requiresConfirmation =
    (tier === 'sensitive' && fullPolicy.requireSensitiveConfirmation) ||
    (tier === 'dangerous' && fullPolicy.requireDangerousConfirmation);
  
  // Expert unsafe mode bypasses confirmation
  const actualRequiresConfirmation = requiresConfirmation && !fullPolicy.expertUnsafe;
  
  // Generate warning for dangerous actions
  let warning: string | undefined;
  if (tier === 'dangerous') {
    warning = `[MCP_WARNING] ${fullToolName} is classified as dangerous. Review action carefully.`;
  } else if (tier === 'sensitive' && !actualRequiresConfirmation) {
    warning = `[MCP_WARNING] ${fullToolName} confirmation skipped due to policy settings.`;
  }
  
  return {
    allowed: true,
    reason: `[MCP_POLICY_ALLOWED] Tool ${fullToolName} allowed (tier: ${tier}).`,
    requiresConfirmation: actualRequiresConfirmation,
    tier,
    warning,
  };
}

/**
 * Check if a tool should be auto-approved based on tier.
 */
export function isAutoApproved(decision: MCPActionDecision): boolean {
  return decision.allowed && !decision.requiresConfirmation;
}

/**
 * Get a summary of policy for display.
 */
export function getPolicySummary(policy: Partial<MCPActionPolicy> = {}): string {
  const fullPolicy = mcpActionPolicySchema.parse(policy);
  const lines: string[] = ['MCP Action Policy:'];
  
  lines.push(`  Expert Unsafe: ${fullPolicy.expertUnsafe}`, `  Allow Dangerous: ${fullPolicy.allowDangerousActions}`, `  Confirm Sensitive: ${fullPolicy.requireSensitiveConfirmation}`, `  Confirm Dangerous: ${fullPolicy.requireDangerousConfirmation}`, `  Audit All: ${fullPolicy.auditAllActions}`);
  
  if (Object.keys(fullPolicy.toolTiers).length > 0) {
    lines.push('  Tool Overrides:');
    for (const [tool, tier] of Object.entries(fullPolicy.toolTiers)) {
      lines.push(`    ${tool}: ${tier}`);
    }
  }
  
  if (Object.keys(fullPolicy.serverTiers).length > 0) {
    lines.push('  Server Defaults:');
    for (const [server, tier] of Object.entries(fullPolicy.serverTiers)) {
      lines.push(`    ${server}: ${tier}`);
    }
  }
  
  return lines.join('\n');
}

// =============================================================================
// Policy Builder
// =============================================================================

/**
 * Builder for creating MCP policies.
 */
export class MCPPolicyBuilder {
  private policy: MCPActionPolicy;
  
  constructor(base: Partial<MCPActionPolicy> = {}) {
    this.policy = mcpActionPolicySchema.parse(base);
  }
  
  allowDangerous(value: boolean): this {
    this.policy.allowDangerousActions = value;
    return this;
  }
  
  blockServer(serverName: string): this {
    return this.setServerTier(serverName, 'blocked');
  }
  
  blockTool(serverName: string, toolName: string): this {
    return this.setToolTier(serverName, toolName, 'blocked');
  }
  
  build(): MCPActionPolicy {
    return { ...this.policy };
  }
  
  setExpertUnsafe(value: boolean): this {
    this.policy.expertUnsafe = value;
    return this;
  }
  
  setServerTier(serverName: string, tier: MCPActionTier): this {
    this.policy.serverTiers[serverName] = tier;
    return this;
  }
  
  setToolTier(serverName: string, toolName: string, tier: MCPActionTier): this {
    this.policy.toolTiers[`${serverName}.${toolName}`] = tier;
    return this;
  }
}
