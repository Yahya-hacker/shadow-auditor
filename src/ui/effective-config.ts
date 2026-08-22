import type { ShadowConfig } from '../utils/config.js';

export interface RuntimeConfigOverrides {
  ciEnabled?: boolean;
  diffBase?: string;
  diffEnabled?: boolean;
  failOn?: string;
  mode?: string;
  swarmEnabled?: boolean;
}

const FAILURE_THRESHOLDS = new Set(['critical', 'high', 'low', 'medium', 'none']);

export function buildEffectiveConfig(
  config: ShadowConfig,
  overrides: RuntimeConfigOverrides,
): ShadowConfig {
  const failOn = overrides.failOn ?? config.ci?.failOn ?? 'high';
  if (!FAILURE_THRESHOLDS.has(failOn)) {
    throw new Error(`Invalid --fail-on value: ${failOn}`);
  }

  return {
    ...config,
    ...(overrides.mode ? { auditMode: overrides.mode as ShadowConfig['auditMode'] } : {}),
    ...(overrides.ciEnabled ? {
      ci: {
        ...config.ci,
        enabled: true,
        failOn: failOn as NonNullable<ShadowConfig['ci']>['failOn'],
      },
    } : {}),
    ...(overrides.diffEnabled ? {
      diff: {
        ...config.diff,
        baseRef: overrides.diffBase ?? config.diff?.baseRef ?? 'HEAD~1',
        enabled: true,
      },
    } : {}),
    ...(overrides.swarmEnabled ? {
      swarm: {
        ...config.swarm,
        enabled: true,
      },
    } : {}),
  };
}
