import {expect} from 'chai';

import {
  applyAgentToolPolicy,
  effectiveAgentToolSteps,
  hostEligibleToolsForAgent,
} from '../src/core/services/tool-policy.js';
import {toggleAgentToolPolicy} from '../src/ui/screens/ToolsScreen.js';

describe('agent tool policy', () => {
  it('removes contradictory agent disables when a tool is enabled', () => {
    expect(toggleAgentToolPolicy(
      {disabledTools: ['read_file_content'], enabledTools: []},
      'read_file_content',
      true,
    )).to.deep.equal({
      disabledTools: [],
      enabledTools: ['read_file_content'],
    });
  });

  it('preserves the effective allowlist when the first tool is disabled', () => {
    expect(toggleAgentToolPolicy(
      undefined,
      'search_codebase',
      false,
      ['read_file_content', 'search_codebase'],
    )).to.deep.equal({
      disabledTools: ['search_codebase'],
      enabledTools: ['read_file_content'],
    });
  });

  const availableTools = [
    'context_retrieval',
    'execute_command',
    'finish_task',
    'list_directory',
    'read_file_content',
    'report_finding',
    'search_codebase',
    'vendor__browser',
  ];

  it('shows only tools the host permits for each agent role', () => {
    expect(hostEligibleToolsForAgent('reporting', availableTools)).to.deep.equal([
      'finish_task',
      'report_finding',
    ]);
    expect(hostEligibleToolsForAgent('taint-tracer', availableTools)).to.deep.equal([
      'context_retrieval',
      'finish_task',
      'read_file_content',
      'search_codebase',
    ]);
    expect(hostEligibleToolsForAgent('exploit-analyst', availableTools)).to.include(
      'vendor__browser',
    );
  });

  it('lets user policy narrow but never widen host-owned tool access', () => {
    const hostTools = hostEligibleToolsForAgent('reporting', availableTools);
    const effective = applyAgentToolPolicy({
      toolPolicy: {
        agents: {
          reporting: {
            enabledTools: ['execute_command', 'finish_task'],
          },
        },
      },
    }, 'reporting', hostTools);

    expect(effective).to.deep.equal(['finish_task', 'report_finding']);
    expect(effective).not.to.include('execute_command');
  });

  it('uses an agent budget override without changing the fallback', () => {
    const config = {
      toolPolicy: {
        agents: {
          sast_audit: {maxToolSteps: 768},
        },
      },
    };

    expect(effectiveAgentToolSteps(config, 'sast_audit', 128)).to.equal(768);
    expect(effectiveAgentToolSteps(config, 'reporting', 128)).to.equal(128);
  });
});
