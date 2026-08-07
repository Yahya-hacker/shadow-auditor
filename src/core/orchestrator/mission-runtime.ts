import type { NormalizedTokenUsage } from '../usage.js';

const MISSION_ACCOUNTING_FAILURE_PREFIX = 'Mission accounting failed after ';

export function isMissionAccountingFailure(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value);
  return message.startsWith(MISSION_ACCOUNTING_FAILURE_PREFIX);
}

export interface MissionModelInvocation {
  agentId?: string;
  estimatedTokens?: number;
  executionId?: string;
  resumeReservedTools?: boolean;
  stage: string;
}

export interface MissionToolCall {
  callId: string;
  name: string;
}

export interface MissionToolResult extends MissionToolCall {
  succeeded: boolean;
}

/**
 * Durable control-plane hooks shared by the deterministic workflow and swarm
 * workers. Implementations enforce one mission-wide budget rather than letting
 * each execution mode maintain unrelated counters.
 */
export interface MissionRuntimeObserver {
  afterModelInvocation(
    invocation: MissionModelInvocation,
    usage: NormalizedTokenUsage | undefined,
    reservationId?: string,
  ): Promise<void>;
  afterToolExecution(
    invocation: MissionModelInvocation,
    results: MissionToolResult[],
  ): Promise<void>;
  beforeModelInvocation(invocation: MissionModelInvocation): Promise<string>;
  beforeToolExecution(
    invocation: MissionModelInvocation,
    calls: MissionToolCall[],
  ): Promise<void>;
  recordMissionCompleted(): Promise<void>;
  recordMissionFailed(reason: string): Promise<void>;
  recordStageCompleted(stage: string): Promise<void>;
  recordStageStarted(stage: string): Promise<void>;
}

export async function runObservedModelInvocation<T>(
  runtime: MissionRuntimeObserver | undefined,
  invocation: MissionModelInvocation,
  invoke: () => Promise<T>,
  usageFromResult?: (result: T) => NormalizedTokenUsage | undefined,
): Promise<T> {
  if (!runtime) return invoke();
  const reservationId = await runtime.beforeModelInvocation(invocation);
  let result: T;

  try {
    result = await invoke();
  } catch (error) {
    try {
      await runtime.afterModelInvocation(invocation, undefined, reservationId);
    } catch (accountingError) {
      throw new AggregateError(
        [error, accountingError],
        `Model invocation and mission accounting both failed during ${invocation.stage}.`,
      );
    }

    throw error;
  }

  try {
    await runtime.afterModelInvocation({
      ...invocation,
      estimatedTokens: (invocation.estimatedTokens ?? 0) + estimateContentTokens(result),
    }, usageFromResult?.(result), reservationId);
  } catch (error) {
    throw new Error(`${MISSION_ACCOUNTING_FAILURE_PREFIX}${invocation.stage} model completion.`, {
      cause: error,
    });
  }

  return result;
}

export function estimateContentTokens(value: unknown): number {
  const characters = countContentCharacters(value, new Set<object>());
  return Math.ceil(characters / 3);
}

function countContentCharacters(value: unknown, seen: Set<object>): number {
  if (typeof value === 'string') return value.length;
  if (!value || typeof value !== 'object' || seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countContentCharacters(item, seen), 0);
  }

  const candidate = value as Record<string, unknown>;
  let characters = 0;
  for (const [key, item] of Object.entries(candidate)) {
    characters += key.length + countContentCharacters(item, seen);
  }

  return characters;
}
