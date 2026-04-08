import { expect } from 'chai';

import {
  evaluateMCPPolicy,
  isAutoApproved,
  type MCPActionPolicy,
  MCPPolicyBuilder,
} from '../src/core/policy/mcp-policy.js';

describe('MCP policy', () => {
  describe('evaluateMCPPolicy', () => {
    it('allows safe tools by default', () => {
      const decision = evaluateMCPPolicy('chrome-devtools', 'take_snapshot');
      
      expect(decision.allowed).to.equal(true);
      expect(decision.tier).to.equal('safe');
      expect(decision.requiresConfirmation).to.equal(false);
    });

    it('requires confirmation for sensitive tools', () => {
      const decision = evaluateMCPPolicy('chrome-devtools', 'click');
      
      expect(decision.allowed).to.equal(true);
      expect(decision.tier).to.equal('sensitive');
      expect(decision.requiresConfirmation).to.equal(true);
    });

    it('denies dangerous tools without explicit flag', () => {
      const decision = evaluateMCPPolicy('kali-official', 'execute_command');
      
      expect(decision.allowed).to.equal(false);
      expect(decision.tier).to.equal('dangerous');
    });

    it('allows dangerous tools with allowDangerousActions flag', () => {
      const decision = evaluateMCPPolicy('kali-official', 'execute_command', {
        allowDangerousActions: true,
      });
      
      expect(decision.allowed).to.equal(true);
      expect(decision.tier).to.equal('dangerous');
      expect(decision.requiresConfirmation).to.equal(true);
      expect(decision.warning).to.include('dangerous');
    });

    it('allows dangerous tools in expert unsafe mode', () => {
      const decision = evaluateMCPPolicy('kali-official', 'execute_command', {
        expertUnsafe: true,
      });
      
      expect(decision.allowed).to.equal(true);
      expect(decision.requiresConfirmation).to.equal(false);
    });

    it('respects tool-specific tier overrides', () => {
      const policy: Partial<MCPActionPolicy> = {
        toolTiers: {
          'chrome-devtools.evaluate_script': 'safe', // Override dangerous to safe
        },
      };
      
      const decision = evaluateMCPPolicy('chrome-devtools', 'evaluate_script', policy);
      
      expect(decision.tier).to.equal('safe');
      expect(decision.allowed).to.equal(true);
    });

    it('blocks tools with blocked tier', () => {
      const policy: Partial<MCPActionPolicy> = {
        toolTiers: {
          'kali-official.metasploit_run': 'blocked',
        },
      };
      
      const decision = evaluateMCPPolicy('kali-official', 'metasploit_run', policy);
      
      expect(decision.allowed).to.equal(false);
      expect(decision.tier).to.equal('blocked');
    });

    it('uses server tier as fallback for unknown tools', () => {
      const policy: Partial<MCPActionPolicy> = {
        serverTiers: {
          'custom-server': 'sensitive',
        },
      };
      
      const decision = evaluateMCPPolicy('custom-server', 'unknown_tool', policy);
      
      expect(decision.tier).to.equal('sensitive');
    });

    it('defaults unknown servers to sensitive', () => {
      const decision = evaluateMCPPolicy('unknown-server', 'some_tool');
      
      expect(decision.tier).to.equal('sensitive');
    });
  });

  describe('isAutoApproved', () => {
    it('returns true for allowed without confirmation', () => {
      const decision = evaluateMCPPolicy('chrome-devtools', 'take_snapshot');
      
      expect(isAutoApproved(decision)).to.equal(true);
    });

    it('returns false when confirmation required', () => {
      const decision = evaluateMCPPolicy('chrome-devtools', 'click');
      
      expect(isAutoApproved(decision)).to.equal(false);
    });

    it('returns false when not allowed', () => {
      const decision = evaluateMCPPolicy('kali-official', 'execute_command');
      
      expect(isAutoApproved(decision)).to.equal(false);
    });
  });

  describe('MCPPolicyBuilder', () => {
    it('builds policy with fluent interface', () => {
      const policy = new MCPPolicyBuilder()
        .setExpertUnsafe(true)
        .allowDangerous(true)
        .setToolTier('custom', 'tool', 'safe')
        .blockTool('bad-server', 'bad-tool')
        .build();
      
      expect(policy.expertUnsafe).to.equal(true);
      expect(policy.allowDangerousActions).to.equal(true);
      expect(policy.toolTiers['custom.tool']).to.equal('safe');
      expect(policy.toolTiers['bad-server.bad-tool']).to.equal('blocked');
    });

    it('can block entire servers', () => {
      const policy = new MCPPolicyBuilder()
        .blockServer('untrusted-server')
        .build();
      
      expect(policy.serverTiers['untrusted-server']).to.equal('blocked');
      
      const decision = evaluateMCPPolicy('untrusted-server', 'any_tool', policy);
      expect(decision.allowed).to.equal(false);
    });
  });
});
