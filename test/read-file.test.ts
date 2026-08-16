import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createPathGuard } from '../src/core/policy/path-guard.js';
import { createReadFileTool } from '../src/core/tools/read-file.js';

describe('read-file tool (#41 size guard)', () => {
  let rootDir: string;

  beforeEach(async () => {
    const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-auditor-read-file-'));
    rootDir = path.join(tempBase, 'repo');
    await fs.mkdir(rootDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(path.dirname(rootDir), { force: true, recursive: true });
  });

  it('reads a normal small file fully', async () => {
    const f = path.join(rootDir, 'ok.ts');
    await fs.writeFile(f, 'line1\nline2\nline3\n', 'utf8');
    const guard = await createPathGuard(rootDir);
    const tool = createReadFileTool(guard);
    const out = await tool.execute({ filePath: 'ok.ts' });
    expect(String(out)).to.contain('line1');
    expect(String(out)).to.contain('line3');
  });

  it('refuses to read an oversized file instead of loading it into memory', async () => {
    const f = path.join(rootDir, 'huge.bundle.js');
    // 11 MB of content, well above the 10 MB cap.
    const big = Buffer.alloc(11 * 1024 * 1024, 0x61); // 'a'
    await fs.writeFile(f, big);

    const guard = await createPathGuard(rootDir);
    const tool = createReadFileTool(guard);
    const out = String(await tool.execute({ filePath: 'huge.bundle.js' }));
    expect(out.toLowerCase()).to.contain('error');
    expect(out).to.contain('MB');
  });

  it('reads a medium file with an explicit line range', async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line-${i + 1}`).join('\n');
    const f = path.join(rootDir, 'medium.ts');
    await fs.writeFile(f, lines + '\n', 'utf8');
    const guard = await createPathGuard(rootDir);
    const tool = createReadFileTool(guard);
    const out = String(await tool.execute({ filePath: 'medium.ts', startLine: 40, endLine: 45 }));
    expect(out).to.contain('line-40');
    expect(out).to.contain('line-45');
  });
});