import {accessSync, constants, realpathSync, statSync} from 'node:fs';
import * as path from 'node:path';

export interface AuditTargetIdentity {
  canonicalPath: string;
  device: bigint;
  inode: bigint;
}

export class AuditTargetChangedError extends Error {
  constructor(targetPath: string) {
    super(`The approved audit target changed before initialization: ${targetPath}`);
    this.name = 'AuditTargetChangedError';
  }
}

export function resolveAuditTarget(target: string): AuditTargetIdentity {
  const canonicalPath = realpathSync.native(path.resolve(target));
  const stat = statSync(canonicalPath, {bigint: true});
  if (!stat.isDirectory()) throw new Error('The target is not a directory.');
  accessSync(canonicalPath, constants.R_OK);
  return {
    canonicalPath,
    device: stat.dev,
    inode: stat.ino,
  };
}

export function isSameAuditTarget(
  expected: AuditTargetIdentity,
  actual: AuditTargetIdentity,
): boolean {
  return expected.canonicalPath === actual.canonicalPath
    && expected.device === actual.device
    && expected.inode === actual.inode;
}

export function assertAuditTargetIdentity(expected: AuditTargetIdentity): void {
  let actual: AuditTargetIdentity;
  try {
    actual = resolveAuditTarget(expected.canonicalPath);
  } catch {
    throw new AuditTargetChangedError(expected.canonicalPath);
  }

  if (!isSameAuditTarget(expected, actual)) {
    throw new AuditTargetChangedError(expected.canonicalPath);
  }
}

export function isAuditTargetChangedError(error: unknown): boolean {
  if (error instanceof AuditTargetChangedError) return true;
  return error instanceof AggregateError
    && error.errors.some((nestedError) => isAuditTargetChangedError(nestedError));
}
