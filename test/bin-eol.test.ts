import { expect } from 'chai';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binPath = join(root, 'bin', 'run.js');

describe('bin/run.js shebang (Linux/macOS/WSL compat)', () => {
  it('starts with a clean LF shebang (no CRLF)', () => {
    const raw = readFileSync(binPath, 'utf8');
    const firstLine = raw.split('\n')[0];
    expect(firstLine).to.equal('#!/usr/bin/env node');
    expect(firstLine.endsWith('\r')).to.equal(false);
  });

  it('contains no carriage returns anywhere in the file', () => {
    const raw = readFileSync(binPath, 'utf8');
    expect(raw.includes('\r')).to.equal(false);
  });

  it('is executable so the kernel can run it directly', () => {
    // On POSIX the file must be executable for `shadow-auditor` to launch
    // without `node`. Windows ignores the permission bits.
    if (process.platform !== 'win32') {
      const st = statSync(binPath);
      const otherExec = st.mode % 2 === 1;
      const groupExec = Math.floor(st.mode / 8) % 2 === 1;
      const ownerExec = Math.floor(st.mode / 64) % 2 === 1;
      expect(otherExec || groupExec || ownerExec).to.equal(true);
    }
  });
});
