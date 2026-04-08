/**
 * Policy Audit - Audit trail for policy decisions.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';

import type { CommandPolicyDecision } from './command-policy.js';
import type { MCPActionDecision, MCPActionTier } from './mcp-policy.js';

import { SCHEMA_VERSION } from '../schema/base.js';

// =============================================================================
// Schemas
// =============================================================================

export const policyDecisionTypeSchema = z.enum(['command', 'mcp', 'path', 'action']);
export type PolicyDecisionType = z.infer<typeof policyDecisionTypeSchema>;

export const policyAuditEntrySchema = z.object({
  agentId: z.string().optional(),
  // Decision details
  allowed: z.boolean(),
  // User interaction
  confirmationRequested: z.boolean().default(false),
  confirmationResult: z.enum(['approved', 'denied', 'timeout', 'skipped']).optional(),
  confirmationTimestamp: z.string().datetime().optional(),
  
  // Context
  context: z.object({
    // For command policy
    command: z.string().optional(),
    
    expertOverride: z.boolean().optional(),
    operation: z.enum(['read', 'write', 'execute']).optional(),
    // Additional metadata
    policyConfig: z.record(z.unknown()).optional(),
    // For path policy
    requestedPath: z.string().optional(),
    
    resolvedPath: z.string().optional(),
    // For MCP policy
    serverName: z.string().optional(),
    tier: z.string().optional(),
    
    toolArgs: z.record(z.unknown()).optional(),
    toolName: z.string().optional(),
  }).default({}),
  
  id: z.string(),
  reason: z.string(),
  runId: z.string(),
  
  schemaVersion: z.string().default(SCHEMA_VERSION),
  
  timestamp: z.string().datetime(),
  type: policyDecisionTypeSchema,
  warning: z.string().optional(),
});

export type PolicyAuditEntry = z.infer<typeof policyAuditEntrySchema>;

export const policyAuditStatsSchema = z.object({
  allowed: z.number(),
  byTier: z.record(z.number()).optional(),
  byType: z.record(z.object({
    allowed: z.number(),
    denied: z.number(),
    total: z.number(),
  })),
  confirmations: z.object({
    approved: z.number(),
    denied: z.number(),
    requested: z.number(),
    timeout: z.number(),
  }),
  denied: z.number(),
  expertOverrides: z.number(),
  totalDecisions: z.number(),
});

export type PolicyAuditStats = z.infer<typeof policyAuditStatsSchema>;

// =============================================================================
// Audit Manager
// =============================================================================

/**
 * Manages policy decision audit trail.
 */
// eslint-disable-next-line unicorn/prefer-event-target
export class PolicyAuditManager extends EventEmitter {
  private readonly auditDir: string;
  private dirty = false;
  private readonly entries: Map<string, PolicyAuditEntry> = new Map();
  private entryCount = 0;
  private readonly runId: string;
  
  constructor(runId: string, auditDir: string) {
    super();
    this.runId = runId;
    this.auditDir = auditDir;
  }
  
  /**
   * Generate human-readable audit report.
   */
  generateReport(): string {
    const stats = this.getStats();
    const lines: string[] = [];
    
    lines.push(
      '# Policy Audit Report',
      `Run ID: ${this.runId}`,
      `Generated: ${new Date().toISOString()}`,
      '',
      '## Summary',
      `- Total Decisions: ${stats.totalDecisions}`,
      `- Allowed: ${stats.allowed}`,
      `- Denied: ${stats.denied}`,
      `- Expert Overrides: ${stats.expertOverrides}`,
      '',
      '## By Type',
    );
    for (const [type, data] of Object.entries(stats.byType)) {
      lines.push(`- ${type}: ${data.total} (${data.allowed} allowed, ${data.denied} denied)`);
    }

    lines.push('');
    
    if (stats.byTier) {
      lines.push('## By MCP Tier');
      for (const [tier, count] of Object.entries(stats.byTier)) {
        lines.push(`- ${tier}: ${count}`);
      }

      lines.push('');
    }
    
    lines.push('## Confirmations', `- Requested: ${stats.confirmations.requested}`, `- Approved: ${stats.confirmations.approved}`, `- Denied: ${stats.confirmations.denied}`, `- Timeout: ${stats.confirmations.timeout}`, '');
    
    // List denied decisions
    const denied = this.getDeniedEntries();
    if (denied.length > 0) {
      lines.push('## Denied Decisions');
      for (const entry of denied) {
        lines.push(`### ${entry.id}`, `- Type: ${entry.type}`, `- Reason: ${entry.reason}`);
        if (entry.context.command) {
          lines.push(`- Command: ${entry.context.command}`);
        }

        if (entry.context.toolName) {
          lines.push(`- Tool: ${entry.context.serverName}.${entry.context.toolName}`);
        }

        lines.push('');
      }
    }
    
    return lines.join('\n');
  }
  
  /**
   * Get all entries.
   */
  getAllEntries(): PolicyAuditEntry[] {
    return Array.from(this.entries.values());
  }
  
  /**
   * Get denied entries.
   */
  getDeniedEntries(): PolicyAuditEntry[] {
    return this.getAllEntries().filter((e) => !e.allowed);
  }
  
  /**
   * Get entries by type.
   */
  getEntriesByType(type: PolicyDecisionType): PolicyAuditEntry[] {
    return this.getAllEntries().filter((e) => e.type === type);
  }
  
  /**
   * Get entry by ID.
   */
  getEntry(id: string): PolicyAuditEntry | undefined {
    return this.entries.get(id);
  }
  
  /**
   * Compute audit statistics.
   */
  getStats(): PolicyAuditStats {
    const entries = this.getAllEntries();
    
    const byType: Record<string, { allowed: number; denied: number; total: number; }> = {};
    const byTier: Record<string, number> = {};
    let confirmationsRequested = 0;
    let confirmationsApproved = 0;
    let confirmationsDenied = 0;
    let confirmationsTimeout = 0;
    let expertOverrides = 0;
    
    for (const entry of entries) {
      // By type
      if (!byType[entry.type]) {
        byType[entry.type] = { allowed: 0, denied: 0, total: 0 };
      }

      byType[entry.type].total++;
      if (entry.allowed) {
        byType[entry.type].allowed++;
      } else {
        byType[entry.type].denied++;
      }
      
      // By tier (for MCP)
      if (entry.context.tier) {
        byTier[entry.context.tier] = (byTier[entry.context.tier] ?? 0) + 1;
      }
      
      // Confirmations
      if (entry.confirmationRequested) {
        confirmationsRequested++;
        switch (entry.confirmationResult) {
          case 'approved': {
            confirmationsApproved++;
            break;
          }

          case 'denied': {
            confirmationsDenied++;
            break;
          }

          case 'timeout': {
            confirmationsTimeout++;
            break;
          }
        }
      }
      
      // Expert overrides
      if (entry.context.expertOverride) {
        expertOverrides++;
      }
    }
    
    return {
      allowed: entries.filter((e) => e.allowed).length,
      byTier: Object.keys(byTier).length > 0 ? byTier : undefined,
      byType,
      confirmations: {
        approved: confirmationsApproved,
        denied: confirmationsDenied,
        requested: confirmationsRequested,
        timeout: confirmationsTimeout,
      },
      denied: entries.filter((e) => !e.allowed).length,
      expertOverrides,
      totalDecisions: entries.length,
    };
  }
  
  /**
   * Load audit log from disk.
   */
  async load(): Promise<void> {
    const auditPath = path.join(this.auditDir, 'policy-audit.jsonl');
    
    try {
      const content = await fs.readFile(auditPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const entry = policyAuditEntrySchema.parse(parsed);
          this.entries.set(entry.id, entry);
        } catch (error) {
          console.warn(
            `[PolicyAuditManager] Skipping invalid audit entry: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  
  /**
   * Record a command policy decision.
   */
  recordCommandDecision(
    command: string,
    decision: CommandPolicyDecision,
    expertOverride = false,
  ): PolicyAuditEntry {
    const entry = this.createEntry('command', decision.allowed, decision.reason, {
      command,
      expertOverride,
    });
    
    if (decision.warning) {
      entry.warning = decision.warning;
    }
    
    this.addEntry(entry);
    return entry;
  }
  
  /**
   * Update an entry with confirmation result.
   */
  recordConfirmation(
    entryId: string,
    result: 'approved' | 'denied' | 'timeout',
  ): void {
    const entry = this.entries.get(entryId);
    if (!entry) {
      return;
    }
    
    entry.confirmationResult = result;
    entry.confirmationTimestamp = new Date().toISOString();
    
    // Update allowed status if denied
    if (result === 'denied' || result === 'timeout') {
      entry.allowed = false;
    }
    
    this.dirty = true;
    this.emit('confirmation', entry);
  }
  
  /**
   * Record an MCP action policy decision.
   */
  // eslint-disable-next-line max-params
  recordMCPDecision(
    serverName: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    decision: MCPActionDecision,
    expertOverride = false,
  ): PolicyAuditEntry {
    const entry = this.createEntry('mcp', decision.allowed, decision.reason, {
      expertOverride,
      serverName,
      tier: decision.tier,
      toolArgs: this.sanitizeArgs(toolArgs),
      toolName,
    });
    
    if (decision.warning) {
      entry.warning = decision.warning;
    }
    
    if (decision.requiresConfirmation) {
      entry.confirmationRequested = true;
    }
    
    this.addEntry(entry);
    return entry;
  }
  
  /**
   * Record a path policy decision.
   */
  // eslint-disable-next-line max-params
  recordPathDecision(
    requestedPath: string,
    resolvedPath: null | string,
    operation: 'execute' | 'read' | 'write',
    allowed: boolean,
    reason: string,
  ): PolicyAuditEntry {
    const entry = this.createEntry('path', allowed, reason, {
      operation,
      requestedPath,
      resolvedPath: resolvedPath ?? undefined,
    });
    
    this.addEntry(entry);
    return entry;
  }
  
  /**
   * Save audit log to disk.
   */
  async save(): Promise<void> {
    if (!this.dirty && this.entries.size === 0) {
      return;
    }
    
    await fs.mkdir(this.auditDir, { recursive: true });
    
    const auditPath = path.join(this.auditDir, 'policy-audit.jsonl');
    const lines = this.getAllEntries()
      .map((entry) => JSON.stringify(entry))
      .join('\n');
    
    await fs.writeFile(auditPath, lines + '\n', 'utf-8');
    this.dirty = false;
    this.emit('saved', auditPath);
  }
  
  // ===========================================================================
  // Private Methods
  // ===========================================================================
  
  private addEntry(entry: PolicyAuditEntry): void {
    this.entries.set(entry.id, entry);
    this.dirty = true;
    this.emit('decision', entry);
  }
  
  private createEntry(
    type: PolicyDecisionType,
    allowed: boolean,
    reason: string,
    context: PolicyAuditEntry['context'],
  ): PolicyAuditEntry {
    this.entryCount++;
    
    return {
      allowed,
      confirmationRequested: false,
      context,
      id: `${this.runId}-policy-${this.entryCount.toString().padStart(4, '0')}`,
      reason,
      runId: this.runId,
      schemaVersion: SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      type,
    };
  }
  
  private sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    // Remove potentially sensitive fields
    const sanitized = { ...args };
    const sensitiveKeys = ['password', 'secret', 'token', 'key', 'credential', 'auth'];
    
    for (const key of Object.keys(sanitized)) {
      if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
        sanitized[key] = '[REDACTED]';
      }
    }
    
    return sanitized;
  }
}

// =============================================================================
// Convenience Functions
// =============================================================================

let globalAuditManager: null | PolicyAuditManager = null;

/**
 * Initialize global audit manager.
 */
export function initializeAuditManager(runId: string, auditDir: string): PolicyAuditManager {
  globalAuditManager = new PolicyAuditManager(runId, auditDir);
  return globalAuditManager;
}

/**
 * Get global audit manager.
 */
export function getAuditManager(): null | PolicyAuditManager {
  return globalAuditManager;
}
