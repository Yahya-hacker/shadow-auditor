import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export class PathGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathGuardError';
  }
}

export interface PathGuard {
  resolveExistingPath(relativePath: string): Promise<string>;
  resolvePathForWrite(relativePath: string): Promise<string>;
  readonly rootPath: string;
  readonly rootRealPath: string;
  toRelative(absolutePath: string): string;
}

function isInsideRoot(rootRealPath: string, candidateRealPath: string): boolean {
  const root = process.platform === 'win32' ? rootRealPath.toLowerCase() : rootRealPath;
  const candidate = process.platform === 'win32' ? candidateRealPath.toLowerCase() : candidateRealPath;
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as Record<string, unknown>).code === 'ENOENT',
  );
}

async function findExistingAncestor(candidatePath: string): Promise<string> {
  let current = candidatePath;

  while (true) {
    try {
      return await fs.realpath(current);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }

      current = parent;
    }
  }
}

export async function createPathGuard(rootPath: string): Promise<PathGuard> {
  const resolvedRoot = path.resolve(rootPath);
  const rootRealPath = await fs.realpath(resolvedRoot);

  async function resolveExistingPath(relativePath: string): Promise<string> {
    const candidatePath = path.resolve(resolvedRoot, relativePath);
    const candidateRealPath = await fs.realpath(candidatePath);

    if (!isInsideRoot(rootRealPath, candidateRealPath)) {
      throw new PathGuardError(`Access denied: "${relativePath}" resolves outside the target directory.`);
    }

    return candidateRealPath;
  }

  async function resolvePathForWrite(relativePath: string): Promise<string> {
    const candidatePath = path.resolve(resolvedRoot, relativePath);

    try {
      const candidateRealPath = await fs.realpath(candidatePath);
      if (!isInsideRoot(rootRealPath, candidateRealPath)) {
        throw new PathGuardError(`Access denied: "${relativePath}" resolves outside the target directory.`);
      }

      return candidateRealPath;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }

      const ancestorRealPath = await findExistingAncestor(path.dirname(candidatePath));
      if (!isInsideRoot(rootRealPath, ancestorRealPath)) {
        throw new PathGuardError(`Access denied: "${relativePath}" resolves outside the target directory.`);
      }

      return candidatePath;
    }
  }

  function toRelative(absolutePath: string): string {
    return path.relative(rootRealPath, absolutePath);
  }

  return {
    resolveExistingPath,
    resolvePathForWrite,
    rootPath: resolvedRoot,
    rootRealPath,
    toRelative,
  };
}

export function ensurePathInsideRoot(rootRealPath: string, candidateRealPath: string): void {
  if (!isInsideRoot(rootRealPath, candidateRealPath)) {
    throw new PathGuardError('Resolved path escapes target directory.');
  }
}
