import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const output = execFileSync(
  'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { encoding: 'utf8' },
);
const [pack] = JSON.parse(output);
const files = pack.files.map((entry) => entry.path);
const forbiddenPrefixes = ['src/', 'test/', '.github/', 'scripts/', '.serena/'];
const unexpected = files.filter((file) => forbiddenPrefixes.some((prefix) => file.startsWith(prefix)));
if (unexpected.length > 0) {
  throw new Error(`Package contains private development files: ${unexpected.join(', ')}`);
}

const emittedSuffixes = ['.d.ts.map', '.js.map', '.d.ts', '.js'];
const staleCompiledFiles = files
  .filter((file) => file.startsWith('dist/'))
  .filter((file) => {
    const suffix = emittedSuffixes.find((candidate) => file.endsWith(candidate));
    if (!suffix) return true;
    const sourceStem = `src/${file.slice('dist/'.length, -suffix.length)}`;
    return !['.ts', '.tsx', '.mts', '.cts'].some((extension) => existsSync(`${sourceStem}${extension}`));
  });
if (staleCompiledFiles.length > 0) {
  throw new Error(`Package contains stale compiled files: ${staleCompiledFiles.join(', ')}`);
}

for (const required of [
  'bin/run.js',
  'dist/index.d.ts',
  'dist/index.js',
  'protocol/manifest.json',
  'protocol/openapi.json',
  'protocol/signing-vectors.json',
]) {
  if (!files.includes(required)) throw new Error(`Package is missing ${required}`);
}

console.log(`Package content verified: ${files.length} public files`);
