import {expect} from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  clearRepoMapCache,
  startRepoMapGeneration,
} from '../src/ui/hooks/useAgentSession.js';
import {
  assertAuditTargetIdentity,
  AuditTargetChangedError,
  isAuditTargetChangedError,
  isSameAuditTarget,
  resolveAuditTarget,
} from '../src/utils/audit-target.js';

describe('audit target identity', () => {
  it('canonicalizes symlinks before trust is requested', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-audit-target-'));
    try {
      const target = path.join(root, 'target');
      const link = path.join(root, 'link');
      await fs.mkdir(target);
      // Junctions require no Developer Mode/admin on Windows; `realpath` resolves
      // them exactly like POSIX directory symlinks.
      await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');

      const selection = resolveAuditTarget(link);
      expect(selection.canonicalPath).to.equal(await fs.realpath(target));
    } finally {
      await fs.rm(root, {force: true, recursive: true});
    }
  });

  it('detects replacement of an approved directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-audit-target-'));
    try {
      const target = path.join(root, 'target');
      await fs.mkdir(target);
      const approved = resolveAuditTarget(target);
      await fs.rename(target, path.join(root, 'old-target'));
      await fs.mkdir(target);

      expect(isSameAuditTarget(approved, resolveAuditTarget(target))).to.equal(false);
      expect(() => assertAuditTargetIdentity(approved)).to.throw(AuditTargetChangedError);
    } finally {
      await fs.rm(root, {force: true, recursive: true});
    }
  });

  it('preserves target-change classification through cleanup aggregation', () => {
    const changed = new AuditTargetChangedError('/target');
    expect(isAuditTargetChangedError(
      new AggregateError([changed, new Error('cleanup failed')], 'Initialization failed'),
    )).to.equal(true);
    expect(isAuditTargetChangedError(
      new AggregateError([new Error('unrelated')], 'Initialization failed'),
    )).to.equal(false);
  });

  it('retains background map failures for awaited initialization without an unhandled rejection', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-audit-target-'));
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      const target = path.join(root, 'target');
      await fs.mkdir(target);
      const approved = resolveAuditTarget(target);
      await fs.rename(target, path.join(root, 'old-target'));
      await fs.mkdir(target);

      startRepoMapGeneration(approved);
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      expect(unhandled).to.deep.equal([]);
    } finally {
      clearRepoMapCache();
      process.off('unhandledRejection', onUnhandled);
      await fs.rm(root, {force: true, recursive: true});
    }
  });
});
