import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { recoverAtomicWrite, writeFileAtomic } from '../src/utils/fs-atomic.js';

describe('atomic file recovery', () => {
  it('restores the canonical file after a crash during replacement', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-recovery-'));
    const filePath = path.join(directory, 'state.json');
    const backupPath = `${filePath}.shadow-atomic-backup`;
    const journalPath = `${filePath}.shadow-atomic-journal`;
    try {
      await fs.writeFile(backupPath, '{"version":"old"}');
      await fs.writeFile(journalPath, '{}');

      await recoverAtomicWrite(filePath);

      expect(await fs.readFile(filePath, 'utf8')).to.equal('{"version":"old"}');
      await expectMissing(backupPath);
      await expectMissing(journalPath);
    } finally {
      await fs.rm(directory, { force: true, recursive: true });
    }
  });

  it('preserves a backup file when no journal marks it as recovery state', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-recovery-'));
    const filePath = path.join(directory, 'state.json');
    const backupPath = `${filePath}.shadow-atomic-backup`;
    try {
        // A backup file with NO journal is not recovery state — it may be a
        // concurrent writer's file that collides with the deterministic backup
        // name. Recovery must not delete it (previously it did, destroying a
        // live writer's data).
        await fs.writeFile(filePath, '{"version":"new"}');
        await fs.writeFile(backupPath, '{"version":"concurrent-writer"}');

        await recoverAtomicWrite(filePath);

        expect(await fs.readFile(filePath, 'utf8')).to.equal('{"version":"new"}');
        expect(await fs.readFile(backupPath, 'utf8')).to.equal('{"version":"concurrent-writer"}');
      } finally {
        await fs.rm(directory, { force: true, recursive: true });
      }
    });

    it('removes a stale backup only when a journal marks an interrupted replacement', async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-recovery-'));
      const filePath = path.join(directory, 'state.json');
      const backupPath = `${filePath}.shadow-atomic-backup`;
      try {
        await fs.writeFile(filePath, '{"version":"new"}');
        await fs.writeFile(backupPath, '{"version":"old"}');
        await fs.writeFile(`${filePath}.shadow-atomic-journal`, '{}');

        await recoverAtomicWrite(filePath);

        expect(await fs.readFile(filePath, 'utf8')).to.equal('{"version":"new"}');
        await expectMissing(backupPath);
      } finally {
        await fs.rm(directory, { force: true, recursive: true });
      }
    });

  it('serializes concurrent writers to the same destination', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-concurrency-'));
    const filePath = path.join(directory, 'state.json');
    try {
      const contents = Array.from({ length: 50 }, (_, index) => `{"version":${index}}`);
      await Promise.all(contents.map(content => writeFileAtomic(filePath, content)));

      expect(await fs.readFile(filePath, 'utf8')).to.equal(contents.at(-1));
      expect((await fs.readdir(directory)).filter(name => name !== 'state.json')).to.deep.equal([]);
    } finally {
      await fs.rm(directory, { force: true, recursive: true });
    }
  });

  it('rejects attacker-controlled recovery symlinks', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-symlink-'));
    const secretDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-secret-'));
    const filePath = path.join(directory, 'state.json');
    const secretPath = path.join(secretDirectory, 'secret.txt');
    try {
      await fs.writeFile(secretPath, 'host secret');
      await fs.symlink(secretPath, `${filePath}.shadow-atomic-backup`);
      await fs.writeFile(`${filePath}.shadow-atomic-journal`, '{}');

      let error: unknown;
      try {
        await recoverAtomicWrite(filePath);
      } catch (error_) {
        error = error_;
      }

      expect((error as Error).message).to.include('non-regular backup');
      await expectMissing(filePath);
      expect(await fs.readFile(secretPath, 'utf8')).to.equal('host secret');
    } finally {
      await fs.rm(directory, {force: true, recursive: true});
      await fs.rm(secretDirectory, {force: true, recursive: true});
    }
  });
it('steals a stale cross-process lockfile left by a crashed process', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-stale-lock-'));
    const filePath = path.join(directory, 'state.json');
    const lockPath = `${filePath}.shadow-atomic-lock`;
    try {
      // Simulate a lockfile abandoned by a crashed process: old mtime.
      await fs.writeFile(lockPath, '99999\n0\n', 'utf8');
      const old = new Date(Date.now() - 60_000);
      await fs.utimes(lockPath, old, old);

      await writeFileAtomic(filePath, '{"version":1}');

      expect(await fs.readFile(filePath, 'utf8')).to.equal('{"version":1}');
      await expectMissing(lockPath);
    } finally {
      await fs.rm(directory, {force: true, recursive: true});
    }
  });

  it('waits until a held cross-process lockfile is released, then writes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-live-lock-'));
    const filePath = path.join(directory, 'state.json');
    const lockPath = `${filePath}.shadow-atomic-lock`;
    try {
      // A fresh lockfile simulates a live holder in another process.
      await fs.writeFile(lockPath, '99999\n0\n', 'utf8');

      // Release the lock shortly after the write begins.
      const releaseTimer = setTimeout(() => {
        fs.rm(lockPath, {force: true}).catch(() => {});
      }, 100);

      const started = Date.now();
      await writeFileAtomic(filePath, '{"version":1}');
      clearTimeout(releaseTimer);

      // The write waited for the lock to be released rather than completing
      // instantly at t=0 or waiting the full 30s staleness window.
      expect(await fs.readFile(filePath, 'utf8')).to.equal('{"version":1}');
      await expectMissing(lockPath);
    } finally {
      await fs.rm(directory, {force: true, recursive: true});
    }
  });
});

async function expectMissing(filePath: string): Promise<void> {
  let exists = true;
  try {
    await fs.access(filePath);
  } catch {
    exists = false;
  }

  expect(exists).to.equal(false);
}
