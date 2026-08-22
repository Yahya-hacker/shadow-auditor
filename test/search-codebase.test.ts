import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createPathGuard } from '../src/core/policy/path-guard.js';
import { createSearchCodebaseTool } from '../src/core/tools/search-codebase.js';

describe('search-codebase tool (#40 ReDoS, #44 dotenv)', () => {
  let rootDir: string;

  beforeEach(async () => {
    const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-auditor-search-'));
    rootDir = path.join(tempBase, 'repo');
    await fs.mkdir(rootDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(path.dirname(rootDir), { force: true, recursive: true });
  });

  it('rejects nested quantifier ReDoS patterns', async () => {
    const guard = await createPathGuard(rootDir);
    const tool = createSearchCodebaseTool(guard);
    const out = String(await tool.execute({ regexPattern: '(a+)+' }));
    expect(out).to.contain('ReDoS');
  });

  it('rejects quantified alternation ReDoS patterns like (a|aa)+', async () => {
    const guard = await createPathGuard(rootDir);
    const tool = createSearchCodebaseTool(guard);
    const out = String(await tool.execute({ regexPattern: '(a|aa)+' }));
    expect(out).to.contain('ReDoS');
  });

  it('rejects invalid regex', async () => {
    const guard = await createPathGuard(rootDir);
    const tool = createSearchCodebaseTool(guard);
    const out = String(await tool.execute({ regexPattern: '([unclosed' }));
    expect(out.toLowerCase()).to.contain('invalid regex');
  });

  it('searches .env variants as text files', async () => {
    await fs.writeFile(path.join(rootDir, '.env'), 'TOKEN=abc\n', 'utf8');
    await fs.writeFile(path.join(rootDir, '.env.local'), 'SECRET=xyz\n', 'utf8');
    const guard = await createPathGuard(rootDir);
    const tool = createSearchCodebaseTool(guard);
    const out = String(await tool.execute({ regexPattern: 'SECRET=' }));
    expect(out).to.contain('.env.local');
    expect(out).to.contain('SECRET=xyz');
  });

  it('does not match plain non-alternation nested-looking literal safely', async () => {
    await fs.writeFile(path.join(rootDir, 'a.ts'), 'const x = 1;\n', 'utf8');
    const guard = await createPathGuard(rootDir);
    const tool = createSearchCodebaseTool(guard);
    // A safe pattern with alternation inside a character-class-like context must pass.
    const out = String(await tool.execute({ regexPattern: 'const x = 1;' }));
    expect(out.toLowerCase()).not.to.contain('error');
    expect(out).to.contain('a.ts');
  });
});