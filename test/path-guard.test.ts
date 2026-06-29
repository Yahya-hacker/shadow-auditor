import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createPathGuard, PathGuardError } from '../src/core/policy/path-guard.js';

describe('path guard', () => {
  let outsideDir: string;
  let rootDir: string;

  beforeEach(async () => {
    const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-auditor-path-guard-'));
    rootDir = path.join(tempBase, 'repo');
    outsideDir = path.join(tempBase, 'outside');
    await fs.mkdir(rootDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(path.dirname(rootDir), { force: true, recursive: true });
  });

  it('resolves regular in-root files', async () => {
    const safeFile = path.join(rootDir, 'safe.ts');
    await fs.writeFile(safeFile, 'export const ok = true;', 'utf8');

    const guard = await createPathGuard(rootDir);
    const resolved = await guard.resolveExistingPath('safe.ts');
    expect(resolved).to.equal(await fs.realpath(safeFile));
  });

  it('blocks symlink escape for existing reads', async function () {
    const outsideFile = path.join(outsideDir, 'secret.txt');
    const inRootSymlink = path.join(rootDir, 'linked-secret.txt');
    await fs.writeFile(outsideFile, 'top-secret', 'utf8');

    try {
      await fs.symlink(outsideFile, inRootSymlink);
    } catch (error) {
      const {code} = (error as NodeJS.ErrnoException);
      if (code === 'EPERM' || code === 'EACCES') {
        this.skip();
        return;
      }

      throw error;
    }

    const guard = await createPathGuard(rootDir);
    let failure: unknown;
    try {
      await guard.resolveExistingPath('linked-secret.txt');
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(PathGuardError);
  });

  it('blocks symlink escape for write targets', async function () {
    const outsideNested = path.join(outsideDir, 'nested');
    await fs.mkdir(outsideNested, { recursive: true });
    const symlinkedDir = path.join(rootDir, 'symlinked-outside');

    try {
      await fs.symlink(outsideNested, symlinkedDir, 'dir');
    } catch (error) {
      const {code} = (error as NodeJS.ErrnoException);
      if (code === 'EPERM' || code === 'EACCES') {
        this.skip();
        return;
      }

      throw error;
    }

    const guard = await createPathGuard(rootDir);
    let failure: unknown;
    try {
      await guard.resolvePathForWrite('symlinked-outside/new-file.ts');
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(PathGuardError);
  });
});
