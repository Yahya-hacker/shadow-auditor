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

  it('keeps the installed replacement and removes a stale backup', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-recovery-'));
    const filePath = path.join(directory, 'state.json');
    const backupPath = `${filePath}.shadow-atomic-backup`;
    try {
      await fs.writeFile(filePath, '{"version":"new"}');
      await fs.writeFile(backupPath, '{"version":"old"}');

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
