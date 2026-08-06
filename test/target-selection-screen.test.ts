import {expect} from 'chai';
import {render} from 'ink';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import {PassThrough} from 'node:stream';
import React from 'react';

import {clearRepoMapCache} from '../src/ui/hooks/useAgentSession.js';
import {TargetSelectionScreen} from '../src/ui/screens/TargetSelectionScreen.js';
import {useAppStore} from '../src/ui/store/appStore.js';

async function renderTrustSelector(target: string) {
  const stdin = new PassThrough() as NodeJS.ReadStream & PassThrough;
  const stdout = new PassThrough() as NodeJS.WriteStream & PassThrough;
  const stderr = new PassThrough() as NodeJS.WriteStream & PassThrough;
  Object.assign(stdin, {
    isTTY: true,
    ref() {
      return stdin;
    },
    setRawMode() {
      return stdin;
    },
    unref() {
      return stdin;
    },
  });
  Object.assign(stdout, {columns: 120, isTTY: true, rows: 40});
  Object.assign(stderr, {columns: 120, isTTY: true, rows: 40});

  const instance = render(
    React.createElement(TargetSelectionScreen, {initialTarget: target}),
    {
      exitOnCtrlC: false,
      interactive: true,
      patchConsole: false,
      stderr,
      stdin,
      stdout,
    },
  );
  await instance.waitUntilRenderFlush();
  return {instance, stdin};
}

async function withTrustSelector(
  input: string,
  assertion: (target: string) => void,
): Promise<void> {
  const target = await mkdtemp(path.join(tmpdir(), 'shadow-target-screen-'));
  const stdinTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: true});
  const initialStore = useAppStore.getState();
  useAppStore.getState().setScreen('target');
  const {instance, stdin} = await renderTrustSelector(target);

  try {
    stdin.write(input);
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    assertion(target);
  } finally {
    instance.unmount();
    await instance.waitUntilExit();
    clearRepoMapCache();
    useAppStore.setState(initialStore, true);
    if (stdinTtyDescriptor) {
      Object.defineProperty(process.stdin, 'isTTY', stdinTtyDescriptor);
    } else {
      Reflect.deleteProperty(process.stdin, 'isTTY');
    }

    await rm(target, {force: true, recursive: true});
  }
}

describe('target selection screen', () => {
  it('keeps the trust selector interactive after setup target confirmation', async () => {
    await withTrustSelector('\r', (target) => {
      expect(useAppStore.getState().screen).to.equal('initializing');
      expect(useAppStore.getState().session.targetPath).to.equal(target);
    });
  });

  it('accepts Y directly at the trust confirmation', async () => {
    await withTrustSelector('y', (target) => {
      expect(useAppStore.getState().screen).to.equal('initializing');
      expect(useAppStore.getState().session.targetPath).to.equal(target);
    });
  });
});
