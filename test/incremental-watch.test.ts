import { expect } from 'chai';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { EnhancedFinding } from '../src/core/output/finding-schema.js';

import {
  calculateSecurityDelta,
  IncrementalWatchService,
  updateWatchBaseline,
} from '../src/core/watch/incremental-watch.js';

function finding(vulnId: string): EnhancedFinding {
  return {
    attackerPersonas: ['unauthenticated_remote'],
    confidence: 0.9,
    cvssV31Score: 7.5,
    cvssV31Vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
    cwe: 'CWE-22',
    exploitability: 'easy',
    locations: [{ filePath: 'src/app.ts', startLine: 1 }],
    remediation: { breakingChange: false, summary: 'Constrain paths.' },
    rootCause: 'Untrusted path reaches a file-system sink.',
    schemaVersion: '1.0.0',
    severityLabel: 'High',
    title: 'Path traversal',
    truncated: false,
    vulnId,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for watch event.');
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

describe('incremental watch', () => {
  it('calculates introduced, resolved, and unchanged findings by stable ID', () => {
    const delta = calculateSecurityDelta(
      [finding('resolved'), finding('stable')],
      [finding('introduced'), finding('stable')],
    );

    expect(delta.introduced.map(({ vulnId }) => vulnId)).to.deep.equal(['introduced']);
    expect(delta.resolved.map(({ vulnId }) => vulnId)).to.deep.equal(['resolved']);
    expect(delta.unchanged.map(({ vulnId }) => vulnId)).to.deep.equal(['stable']);
  });

  it('does not mark findings outside an incremental audit scope as resolved', () => {
    const untouched = finding('untouched');
    untouched.locations = [{filePath: 'src/untouched.ts', startLine: 1}];
    const changed = finding('resolved');
    changed.locations = [{filePath: 'src/changed.ts', startLine: 1}];

    const delta = calculateSecurityDelta(
      [untouched, changed],
      [],
      ['src/changed.ts'],
    );

    expect(delta.resolved.map(({vulnId}) => vulnId)).to.deep.equal(['resolved']);
    expect(delta.unchanged.map(({vulnId}) => vulnId)).to.deep.equal(['untouched']);
  });

  it('preserves out-of-scope findings across consecutive watch batches', () => {
    const first = finding('first');
    first.locations = [{filePath: 'src/first.ts', startLine: 1}];
    const second = finding('second');
    second.locations = [{filePath: 'src/second.ts', startLine: 1}];

    const firstDelta = calculateSecurityDelta([first], [second], ['src/second.ts']);
    const baseline = updateWatchBaseline(firstDelta);
    const secondDelta = calculateSecurityDelta(baseline, [first], ['src/first.ts']);

    expect(secondDelta.introduced).to.deep.equal([]);
    expect(secondDelta.resolved).to.deep.equal([]);
    expect(secondDelta.unchanged.map(({vulnId}) => vulnId).sort())
      .to.deep.equal(['first', 'second']);
  });

  it('routes a post-ready watcher error to onError instead of crashing', async function () {
    this.timeout(6000);
    const root = await mkdtemp(path.join(tmpdir(), 'shadow-watch-err-'));
    const errors: Error[] = [];
    const watcher = new IncrementalWatchService({
      debounceMs: 25,
      async onBatch() {},
      onError(error) {
        errors.push(error);
      },
      root,
    });

    try {
      await watcher.start();
      // Simulate a chokidar error emitted after the watcher is ready. Without
      // a persistent listener Node throws on 'error' events with no handler.
      (watcher as unknown as { watcher: { emit: (event: string, err: Error) => void } })
        .watcher.emit('error', new Error('watch root permission revoked'));
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(errors).to.have.length(1);
      expect(errors[0]?.message).to.equal('watch root permission revoked');
    } finally {
      await watcher.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('retains changed paths for a retry when the batch audit fails', async function () {
    this.timeout(6000);
    const root = await mkdtemp(path.join(tmpdir(), 'shadow-watch-retry-'));
    const batches: string[][] = [];
    let ready = false;
    let failFirst = true;
    const watcher = new IncrementalWatchService({
      canProcess() {
        return ready;
      },
      debounceMs: 25,
      async onBatch(batch) {
        if (failFirst) {
          failFirst = false;
          throw new Error('audit failed');
        }

        batches.push(batch);
      },
      root,
    });

    try {
      await mkdir(path.join(root, 'src'));
      await watcher.start();
      // Make the watcher ready to process then trigger a change.
      ready = true;
      await writeFile(path.join(root, 'src', 'a.ts'), 'first');
      // The first onBatch for a.ts throws. Even though there is no new watch
      // event, the retained path must be retried and eventually processed
      // instead of being silently dropped.
      await waitFor(() => batches.flat().includes('src/a.ts'));
      expect(batches.flat().filter((p) => p === 'src/a.ts').length).to.equal(1);
    } finally {
      await watcher.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it('coalesces changes, ignores generated roots, and defers while busy', async function () {
    this.timeout(6000);
    const root = await mkdtemp(path.join(tmpdir(), 'shadow-watch-'));
    const batches: string[][] = [];
    let ready = false;
    const watcher = new IncrementalWatchService({
      canProcess() {
        return ready;
      },
      debounceMs: 25,
      async onBatch(batch) {
        batches.push(batch);
      },
      root,
    });

    try {
      await mkdir(path.join(root, 'src'));
      await mkdir(path.join(root, 'dist'));
      await watcher.start();
      await writeFile(path.join(root, 'src', 'a.ts'), 'first');
      await writeFile(path.join(root, 'src', 'b.ts'), 'second');
      await writeFile(path.join(root, 'dist', 'generated.js'), 'ignored');
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });
      expect(batches).to.deep.equal([]);

      ready = true;
      await waitFor(() => batches.length === 1);
      expect(batches[0]).to.deep.equal(['src/a.ts', 'src/b.ts']);
    } finally {
      await watcher.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
