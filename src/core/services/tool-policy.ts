import type { ShadowConfig } from '../../utils/config.js';

export const CONFIGURABLE_AGENT_IDS = [
  'codebase_intelligence',
  'sast_audit',
  'devils_advocate',
  'reporting',
  'exploit-analyst',
  'orchestrator',
  'patch-engineer',
  'reporter',
  'recon',
  'taint-tracer',
  'verifier',
] as const;

const MANDATORY_TOOLS = new Set(['finish_task', 'report_finding']);
const AGENT_HOST_TOOLS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  codebase_intelligence: [
    'context_retrieval',
    'list_directory',
    'read_file',
    'read_file_content',
    'search_codebase',
  ],
  devils_advocate: [
    'check_oast_logs',
    'context_retrieval',
    'execute_command',
    'list_directory',
    'read_file_content',
    'sandbox_deploy',
    'sandbox_exec',
    'sandbox_status',
    'search_codebase',
  ],
  'exploit-analyst': [
    'context_retrieval',
    'execute_command',
    'finish_task',
    'read_file_content',
  ],
  'patch-engineer': [
    'apply_and_test_patch',
    'context_retrieval',
    'detect_test_framework',
    'finish_task',
    'get_baseline_status',
    'read_file_content',
  ],
  recon: [
    'context_retrieval',
    'execute_command',
    'finish_task',
    'list_directory',
    'read_file_content',
    'search_codebase',
  ],
  reporter: [
    'context_retrieval',
    'finish_task',
    'read_file_content',
    'report_finding',
  ],
  reporting: ['finish_task', 'report_finding'],
  sast_audit: [
    'check_oast_logs',
    'context_retrieval',
    'execute_command',
    'list_directory',
    'read_file_content',
    'sandbox_deploy',
    'sandbox_exec',
    'sandbox_status',
    'search_codebase',
  ],
  'taint-tracer': [
    'context_retrieval',
    'finish_task',
    'read_file_content',
    'search_codebase',
  ],
  verifier: [
    'context_retrieval',
    'finish_task',
    'read_file_content',
    'search_codebase',
  ],
});

export function hostEligibleToolsForAgent(
  agentId: string,
  availableTools: readonly string[],
): string[] {
  if (agentId === 'orchestrator') return [...availableTools];
  const allowed = new Set(AGENT_HOST_TOOLS[agentId] ?? []);
  return availableTools.filter((name) =>
    allowed.has(name) || (agentId === 'exploit-analyst' && name.includes('__')),
  );
}

export function effectiveAgentToolSteps(
  config: Pick<ShadowConfig, 'toolPolicy'>,
  agentId: string,
  fallback: number,
): number {
  return config.toolPolicy?.agents?.[agentId]?.maxToolSteps ?? fallback;
}

export function applyAgentToolPolicy(
  config: Pick<ShadowConfig, 'toolPolicy'>,
  agentId: string,
  hostAllowedTools: readonly string[],
): string[] {
  const policy = config.toolPolicy;
  const agent = policy?.agents?.[agentId];
  const enabled = agent?.enabledTools ? new Set(agent.enabledTools) : undefined;
  const disabled = new Set([
    ...(agent?.disabledTools ?? []),
    ...(policy?.disabledTools ?? []),
  ]);

  return hostAllowedTools.filter((name) =>
    MANDATORY_TOOLS.has(name) || (!disabled.has(name) && (!enabled || enabled.has(name))),
  );
}
