import { randomUUID } from 'node:crypto';

import type { JsonObject } from '../../protocol/generated.js';
import type { ShadowConfig } from '../../utils/config.js';
import type { MCPRawInvoker } from '../mcp/types.js';
import type { HybridRetriever } from '../memory/hybrid-retriever.js';

import { SandboxManager } from '../dast/sandbox-manager.js';
import { createSandboxTools } from '../dast/sandbox-tools.js';
import { createChromeDevtoolsAdapter } from '../mcp/adapters/chrome-devtools.js';
import { createKaliLinuxAdapter } from '../mcp/adapters/kali-linux.js';
import { MCPManager } from '../mcp/manager.js';
import { createPathGuard } from '../policy/path-guard.js';
import { RemediationLoop } from '../remediation/remediation-loop.js';
import { createRemediationTools } from '../remediation/remediation-tools.js';
import { TestRunner } from '../remediation/test-runner.js';
import { createBashTool } from './bash.js';
import { createContextRetrievalTool } from './context-retrieval.js';
import { createEditFileTool } from './edit-file.js';
import { createExecuteCommandTool } from './execute-command.js';
import { createListDirectoryTool } from './list-directory.js';
import { defineLocalTool, type LocalTool, type LocalToolRisk, type LocalToolSet } from './local-tool.js';
import { createReadFileTool } from './read-file.js';
import { createSearchCodebaseTool } from './search-codebase.js';

const GENERIC_OBJECT_SCHEMA: JsonObject = {
  additionalProperties: true,
  type: 'object',
};

const RISKS: Record<string, LocalToolRisk> = {
  apply_and_test_patch: 'write',
  bash: 'execute',
  check_oast_logs: 'network',
  check_sandbox_status: 'read',
  create_sandbox: 'execute',
  deploy_target: 'execute',
  destroy_sandbox: 'execute',
  edit_file: 'write',
  execute_command: 'execute',
  execute_in_sandbox: 'execute',
  get_baseline_status: 'read',
  list_directory: 'read',
  query_oast_callbacks: 'network',
  read_file: 'read',
  retrieve_context: 'read',
  run_baseline_tests: 'execute',
  search_codebase: 'read',
  validate_current_state: 'execute',
};

function maybeCreateHttpInvoker(endpoint?: string): MCPRawInvoker | undefined {
  const normalizedEndpoint = endpoint?.trim();
  if (!normalizedEndpoint) return undefined;
  const url = new URL(normalizedEndpoint);
  if (url.protocol !== 'https:' && !['127.0.0.1', '::1', 'localhost'].includes(url.hostname)) {
    throw new Error('Remote MCP endpoints must use HTTPS');
  }

  return async (operation, input) => {
    const response = await fetch(url, {
      body: JSON.stringify({ input, operation }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`MCP endpoint error (${response.status}): ${response.statusText}`);
    const body = await response.text();
    if (!body) return null;
    try {
      return JSON.parse(body) as JsonObject;
    } catch {
      return body;
    }
  };
}

function registerToolSet(registry: Map<string, LocalTool>, toolSet: LocalToolSet): void {
  for (const [name, tool] of Object.entries(toolSet)) {
    registry.set(
      name,
      defineLocalTool({
        inputJsonSchema: GENERIC_OBJECT_SCHEMA,
        name,
        risk: name.startsWith('mcp_') ? 'network' : (RISKS[name] ?? 'execute'),
        tool,
      }),
    );
  }
}

export interface LocalToolRegistry {
  close(): Promise<void>;
  tools: Map<string, LocalTool>;
}

export async function createLocalToolRegistry(options: {
  config: ShadowConfig;
  retriever?: HybridRetriever;
  targetPath: string;
}): Promise<LocalToolRegistry> {
  const tools = new Map<string, LocalTool>();
  const cleanup: Array<() => Promise<void>> = [];
  const pathGuard = await createPathGuard(options.targetPath);
  const commandPolicy = {
    additionalAllowedCommandPatterns: options.config.commandPolicy?.allowlist,
    additionalDeniedPatterns: options.config.commandPolicy?.denylist,
    allowPnpmYarn: true,
    expertUnsafe: options.config.commandPolicy?.expertUnsafe,
  };
  const commandOptions = { commandPolicy, workingDirectory: pathGuard.rootRealPath };

  registerToolSet(tools, {
    bash: createBashTool(commandOptions),
    edit_file: createEditFileTool(pathGuard),
    execute_command: createExecuteCommandTool(commandOptions),
    list_directory: createListDirectoryTool(pathGuard),
    read_file: createReadFileTool(pathGuard),
    search_codebase: createSearchCodebaseTool(pathGuard),
  });

  if (options.retriever) {
    registerToolSet(tools, {
      retrieve_context: createContextRetrievalTool({
        retriever: options.retriever,
        rootPath: pathGuard.rootRealPath,
      }),
    });
  }

  if (options.config.mcp?.enabled) {
    const manager = new MCPManager({
      expertUnsafe: options.config.commandPolicy?.expertUnsafe ?? false,
      targetPath: options.targetPath,
    });
    const enabledAdapters = new Set(options.config.mcp.adapters ?? ['chrome-devtools', 'kali-linux']);
    if (enabledAdapters.has('chrome-devtools')) {
      manager.registerAdapter(createChromeDevtoolsAdapter({
        invoker: maybeCreateHttpInvoker(options.config.mcp.chromeDevtoolsEndpoint),
      }));
    }

    if (enabledAdapters.has('kali-linux')) {
      manager.registerAdapter(createKaliLinuxAdapter({
        invoker: maybeCreateHttpInvoker(options.config.mcp.kaliLinuxEndpoint),
      }));
    }

    await manager.initialize();
    registerToolSet(tools, manager.buildAgentTools());
    cleanup.push(() => manager.shutdown());
  }

  if (options.config.dast?.enabled) {
    const sandboxManager = new SandboxManager({
      runId: randomUUID().replaceAll('-', '').slice(0, 16),
      targetPath: options.targetPath,
      timeoutMs: options.config.dast.maxRuntimeMs,
    });
    registerToolSet(tools, createSandboxTools({ sandboxManager }));
    cleanup.push(() => sandboxManager.destroy());
  }

  if (options.config.remediation?.enabled) {
    const testRunner = await TestRunner.detect({
      projectRoot: options.targetPath,
      testCommand: options.config.remediation.testCommand,
      useDocker: true,
    });
    const remediationLoop = new RemediationLoop({
      projectRoot: options.targetPath,
      testRunner,
    });
    registerToolSet(tools, createRemediationTools({
      projectRoot: options.targetPath,
      remediationLoop,
      testRunner,
    }));
  }

  return {
    async close() {
      await Promise.allSettled(cleanup.map((operation) => operation()));
    },
    tools,
  };
}
