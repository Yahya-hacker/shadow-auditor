import {expect} from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {computeRepoMapContentRoot, generateRepoMap} from '../src/utils/repo-map.js';

describe('repo-map content root', () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-map-root-'));
  });

  afterEach(async () => {
    await fs.rm(repoPath, {force: true, recursive: true});
  });

  it('changes after source edits, additions, deletions, and renames', async () => {
    const originalPath = path.join(repoPath, 'original.ts');
    await fs.writeFile(originalPath, 'export const value = 1;\n');
    const initial = await computeRepoMapContentRoot(repoPath);

    await fs.writeFile(originalPath, 'export const value = 2;\n');
    const edited = await computeRepoMapContentRoot(repoPath);
    expect(edited).not.to.equal(initial);

    const addedPath = path.join(repoPath, 'added.ts');
    await fs.writeFile(addedPath, 'export const added = true;\n');
    const added = await computeRepoMapContentRoot(repoPath);
    expect(added).not.to.equal(edited);

    await fs.rm(addedPath);
    const deleted = await computeRepoMapContentRoot(repoPath);
    expect(deleted).to.equal(edited);

    await fs.rename(originalPath, path.join(repoPath, 'renamed.ts'));
    const renamed = await computeRepoMapContentRoot(repoPath);
    expect(renamed).not.to.equal(deleted);
  });

  it('maps PHP symbols and includes PHP files in the content fingerprint', async () => {
    const phpPath = path.join(repoPath, 'Controller.php');
    await fs.writeFile(phpPath, `<?php
namespace App;
class Controller {
    public function show(string $id): string { return $id; }
}
function route(string $path): void {}
`);

    const initial = await computeRepoMapContentRoot(repoPath);
    const map = await generateRepoMap(repoPath);
    expect(map).to.include('Controller.php (php)');
    expect(map).to.match(/(?:class|declaration) Controller/);
    expect(map).to.include('show');
    expect(map).to.include('route');

    await fs.appendFile(phpPath, '\nfunction health(): bool { return true; }\n');
    expect(await computeRepoMapContentRoot(repoPath)).not.to.equal(initial);
  });

  it('maps sources larger than the Node 24 Tree-sitter callback limit', async () => {
    const prefix = 'export function large() { return "';
    const suffix = '"; }';
    await fs.writeFile(
      path.join(repoPath, 'large.ts'),
      `${prefix}${'a'.repeat(100_000 - prefix.length - suffix.length)}${suffix}`,
    );

    const map = await generateRepoMap(repoPath);

    expect(map).to.include('large.ts');
    expect(map).not.to.include('Mapping unavailable');
  });
});
