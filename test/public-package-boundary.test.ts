import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import Shell from '../src/commands/shell.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbiddenImports = [
  '@anthropic-ai/',
  '@google/generative-ai',
  '@langchain/',
  '@langgraph/',
  'openai',
];

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [absolute] : [];
  }));
  return nested.flat();
}

describe('public package boundary', () => {
  it('ships only the CLI, compiled client, manifest, and frozen protocol', async () => {
    const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      files: string[];
      types: string;
    };
    expect(packageJson.files).to.deep.equal([
      './bin',
      './dist',
      './oclif.manifest.json',
      './protocol',
    ]);
    expect(packageJson.types).to.equal('dist/index.d.ts');
    expect((await fs.stat(path.join(root, 'src', 'index.ts'))).isFile()).to.equal(true);
    for (const dependency of forbiddenImports) {
      expect(Object.keys(packageJson.dependencies).some((name) => name.startsWith(dependency))).to.equal(false);
    }
  });

  it('contains no private cognition or hosted-model imports', async () => {
    const files = await sourceFiles(path.join(root, 'src'));
    for (const file of files) {
      const source = await fs.readFile(file, 'utf8');
      for (const forbidden of forbiddenImports) {
        expect(source, path.relative(root, file)).not.to.include(`'${forbidden}`);
        expect(source, path.relative(root, file)).not.to.include(`"${forbidden}`);
      }

      expect(source, path.relative(root, file)).not.to.match(/\bAgentState\b/);
    }
  });

  it('keeps the protocol layer independent of runtime implementation details', async () => {
    const files = await sourceFiles(path.join(root, 'src', 'protocol'));
    for (const file of files) {
      const source = await fs.readFile(file, 'utf8');
      expect(source, path.relative(root, file)).not.to.match(/from ['"].*\bcore\b/);
    }
  });

  it('exposes the remote-client CLI controls and CI flags', () => {
    expect(Shell.description).to.include('remote private backend');
    expect(Object.keys(Shell.flags)).to.include.members([
      'ci',
      'diff',
      'fail-on',
      'mode',
      'objective',
      'reconfigure',
      'since',
      'target',
    ]);
  });
});
