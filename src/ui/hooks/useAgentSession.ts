import { useCallback, useEffect, useRef } from 'react';

import type {
  SuppressionDecision,
  SuppressionListEntry,
} from '../../core/memory/false-positive-store.js';
import type { EnhancedReport } from '../../core/output/finding-schema.js';
import type { AuditTargetIdentity } from '../../utils/audit-target.js';
import type { ShadowConfig } from '../../utils/config.js';

import { AgentSession } from '../../core/agent.js';
import { assertAuditTargetIdentity } from '../../utils/audit-target.js';
import { logToStderr } from '../../utils/stderr-logger.js';
import { isShuttingDown } from '../shutdown.js';

export interface SessionInitOptions {
  diffScopeHint?: string;
  expertUnsafe?: boolean;
  resumeRunId?: string;
  /** Name of the user, collected during onboarding, passed to the AI. */
  userName?: string;
}

/** Shared interface for both direct and worker-backed agent sessions. */
export interface AgentSessionLike {
  cancelActiveOperation(): boolean;
  compactContext(): Promise<{afterTokens: number; beforeTokens: number}>;
  dispose?(): Promise<void>;
  generateReport(): Promise<null | {
    jsonPath?: string;
    markdownPath?: string;
    report: EnhancedReport;
    sarifPath?: string;
  }>;
  getLatestFindings(): EnhancedReport['findings'];
  getPendingHumanInput(): Promise<import('../../core/graph/state.js').HumanInputRequest | null>;
  getToolPolicySnapshot(): Promise<{
    agents: Array<{
      id: string;
      maxToolSteps: number;
      tools: Array<{enabled: boolean; name: string}>;
    }>;
  }>;
  isPausedAwaitingHumanInput(): boolean | Promise<boolean>;
  listSuppressions(): Promise<SuppressionListEntry[]>;
  resumeFromCheckpoint(
    onChunk: (text: string) => void,
    onEvent?: (event: import('../../core/agent.js').AgentStreamEvent) => void,
  ): Promise<string>;
  resumeWithHumanInput(
    answer: boolean | string,
    onChunk: (text: string) => void,
    onEvent?: (event: import('../../core/agent.js').AgentStreamEvent) => void,
  ): Promise<string>;
  revokeSuppression(suppressionId: string, rationale: string): Promise<SuppressionDecision>;
  sendMessage(
    userMessage: string,
    onChunk: (text: string) => void,
    onEvent?: (event: import('../../core/agent.js').AgentStreamEvent) => void,
  ): Promise<string>;
  setReasoningEffort(
    effort: 'high' | 'low' | 'medium' | 'minimal' | 'none' | 'xhigh',
  ): Promise<void>;
  setToolPolicy(toolPolicy: ShadowConfig['toolPolicy']): Promise<void>;
  suppressFinding(
    findingId: string,
    rationale: string,
    expiresAt?: string,
  ): Promise<SuppressionDecision>;
}

// Module-level content-addressed cache. The source root is recomputed before
// reuse, preventing source edits from serving a stale architecture map.
let repoMapPromiseCache: null | {
  contentRoot: Promise<string>;
  path: string;
  promise: Promise<string>;
} = null;
const activeSessions = new Set<AgentSessionLike>();

function retainHandledPromise<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {
    // The original promise remains rejected and is awaited by session initialization.
  });
  return promise;
}

export async function disposeActiveAgentSessions(): Promise<void> {
  const sessions = [...activeSessions];
  activeSessions.clear();
  try {
    const results = await Promise.allSettled(sessions.map((session) => session.dispose?.()));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `Failed to dispose ${failures.length} active agent session(s).`,
      );
    }
  } finally {
    clearRepoMapCache();
  }
}

/**
 * Start generating the repo map in the background.
 * This can be called early (e.g., when target is selected) to avoid blocking
 * the UI during session initialization.
 */
export function startRepoMapGeneration(target: AuditTargetIdentity): void {
  const modulePromise = import('../../utils/repo-map.js');
  const targetPath = target.canonicalPath;
  const verifiedModule = modulePromise.then((module) => {
    assertAuditTargetIdentity(target);
    return module;
  });
  repoMapPromiseCache = {
    contentRoot: retainHandledPromise(
      verifiedModule.then((module) => module.computeRepoMapContentRoot(targetPath)),
    ),
    path: targetPath,
    promise: retainHandledPromise(
      verifiedModule.then((module) => module.generateRepoMap(targetPath)),
    ),
  };
}

/**
 * Clear the repo map cache, forcing the next session init to regenerate
 * the repo map. Called during graceful shutdown, target change, or
 * test teardown to prevent stale state leaking.
 */
export function clearRepoMapCache(): void {
  repoMapPromiseCache = null;
}

async function loadRepoMap(target: AuditTargetIdentity): Promise<string> {
  assertAuditTargetIdentity(target);
  const targetPath = target.canonicalPath;
  const repoMap = await import('../../utils/repo-map.js');
  const currentRoot = await repoMap.computeRepoMapContentRoot(targetPath);
  if (
    repoMapPromiseCache?.path === targetPath &&
    await repoMapPromiseCache.contentRoot === currentRoot
  ) {
    const map = await repoMapPromiseCache.promise;
    assertAuditTargetIdentity(target);
    return map;
  }

  const promise = repoMap.generateRepoMap(targetPath);
  repoMapPromiseCache = {
    contentRoot: Promise.resolve(currentRoot),
    path: targetPath,
    promise,
  };
  const map = await promise;
  assertAuditTargetIdentity(target);
  return map;
}

export function useAgentSession() {
  const agentSessionRef = useRef<AgentSessionLike | null>(null);
  const lifecycleOwnerRef = useRef<null | symbol>(null);
  const initializationGenerationRef = useRef(0);

  useEffect(() => {
    const owner = Symbol('agent-session-lifecycle');
    lifecycleOwnerRef.current = owner;

    return () => {
      if (lifecycleOwnerRef.current !== owner) return;

      lifecycleOwnerRef.current = null;
      initializationGenerationRef.current++;
      if (isShuttingDown()) return;

      const ownedSession = agentSessionRef.current;
      agentSessionRef.current = null;
      if (ownedSession) activeSessions.delete(ownedSession);
      ownedSession?.dispose?.().catch((error: unknown) => {
        logToStderr(`Session cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    };
  }, []);

  const initSession = useCallback(async (
    config: ShadowConfig,
    target: AuditTargetIdentity,
    options: SessionInitOptions,
  ) => {
    const owner = lifecycleOwnerRef.current;
    const generation = ++initializationGenerationRef.current;
    if (!owner || isShuttingDown()) return;

    const targetPath = target.canonicalPath;
    const map = await loadRepoMap(target);

    // Async map generation may outlive the component or a StrictMode lifecycle.
    // Never publish a session into a newer hook instance.
    if (
      isShuttingDown() ||
      lifecycleOwnerRef.current !== owner ||
      initializationGenerationRef.current !== generation
    ) return;

    assertAuditTargetIdentity(target);
    const session = new AgentSession(config, map, targetPath, {
      diffScopeHint: options.diffScopeHint,
      expertUnsafe: options.expertUnsafe,
      resumeRunId: options.resumeRunId,
      userName: options.userName,
    });
    try {
      await session.waitForReady();
      assertAuditTargetIdentity(target);
    } catch (error) {
      try {
        await session.dispose?.();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Session initialization failed and cleanup did not complete.',
        );
      }

      throw error;
    }

    if (
      isShuttingDown() ||
      lifecycleOwnerRef.current !== owner ||
      initializationGenerationRef.current !== generation
    ) {
      await session.dispose?.();
      return;
    }

    const previousSession = agentSessionRef.current;
    agentSessionRef.current = session;
    activeSessions.add(session);
    if (previousSession && previousSession !== session) {
      activeSessions.delete(previousSession);
      await previousSession.dispose?.();
    }
  }, []);

  return {
    agentSessionRef,
    initSession,
  };
}
