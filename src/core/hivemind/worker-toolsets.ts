/**
 * Worker Toolsets - Role-scoped tool subsets for swarm workers.
 */

import { type ToolSet } from 'ai';

import { type AgentRole } from './hivemind-schema.js';

/**
 * Filter the global toolset to only include tools appropriate for the given worker role.
 */
export function createRoleToolSet(role: AgentRole, allTools: ToolSet): ToolSet {
  const filteredTools: ToolSet = {};

  const addTool = (name: string) => {
    if (allTools[name]) {
      filteredTools[name] = allTools[name];
    }
  };

  switch (role) {
    case 'exploit-analyst': {
      addTool('read_file_content');
      addTool('context_retrieval');
      addTool('execute_command');
      // Add all MCP tools for exploit analysis/dynamic validation
      for (const key of Object.keys(allTools)) {
        if (key.includes('__')) {
          addTool(key);
        }
      }

      break;
    }

    case 'patch-engineer': {
      addTool('read_file_content');
      addTool('context_retrieval');
      addTool('detect_test_framework');
      addTool('get_baseline_status');
      addTool('apply_and_test_patch');
      break;
    }

    case 'recon': {
      addTool('read_file_content');
      addTool('list_directory');
      addTool('search_codebase');
      addTool('context_retrieval');
      addTool('execute_command');
      break;
    }

    case 'reporter': {
      addTool('read_file_content');
      addTool('context_retrieval');
      addTool('report_finding');
      addTool('finish_task');
      break;
    }

    case 'taint-tracer': {
      addTool('read_file_content');
      addTool('search_codebase');
      addTool('context_retrieval');
      break;
    }

    case 'verifier': {
      addTool('read_file_content');
      addTool('search_codebase');
      addTool('context_retrieval');
      break;
    }

    case 'orchestrator':
    default: {
      return { ...allTools };
    }
  }

  // Always allow finish_task for any worker to exit when done
  addTool('finish_task');

  return filteredTools;
}
