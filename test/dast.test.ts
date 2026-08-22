import type { execFile } from 'node:child_process';

import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  type DastValidationResult,
  dastValidationResultSchema,
  exploitProofOfConceptSchema,
  type OastCallback,
  oastCallbackSchema,
  type SandboxExecResult,
  sandboxExecResultSchema,
} from '../src/core/dast/dast-schema.js';
import { MirageOAST } from '../src/core/dast/mirage-oast.js';
import { SandboxManager } from '../src/core/dast/sandbox-manager.js';

function cancellableDockerExecutor(
  _file: string,
  _args: readonly string[],
  options: { signal?: AbortSignal },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
): object {
  if (!options.signal) {
    callback(null, '', '');
    return {};
  }

  options.signal.addEventListener('abort', () => {
    callback(new Error('aborted'), '', '');
  }, { once: true });
  return {};
}

function ipForInspect(args: readonly string[]): string | null {
  // The IP-inspect uses `--format '{{range .NetworkSettings...}}'`; the
  // running-state inspect uses `--format '{{.State.Running}}'`.
  if (args[0] === 'inspect' && args[1] === '--format' && String(args[2]).includes('{{range')) {
    return '172.18.0.2\n';
  }
  return null;
}

function createRecordingDockerExecutor(calls: string[][]): typeof execFile {
  const executor = (
    _file: string,
    args: readonly string[],
    _options: object,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    calls.push([...args]);
    const ip = ipForInspect(args);
    callback(null, ip ?? (args[0] === 'inspect' ? 'true\n' : ''), '');
    return {};
  };

  return executor as unknown as typeof execFile;
}

function immediatelyExitedDockerExecutor(
  _file: string,
  args: readonly string[],
  _options: object,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
): object {
  const ip = ipForInspect(args);
  callback(null, ip ?? (args[0] === 'inspect' ? 'false\n' : ''), '');
  return {};
}

function failedDeployDockerExecutor(
  _file: string,
  args: readonly string[],
  _options: object,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
): object {
  const failedDeploy = args[0] === 'exec' && args.at(-1) === 'npm start';
  const error = failedDeploy ? Object.assign(new Error('deploy failed'), { code: 7 }) : null;
  const ip = ipForInspect(args);
  callback(error, ip ?? (args[0] === 'inspect' ? 'true\n' : ''), failedDeploy ? 'deploy failed' : '');
  return {};
}

describe('DAST subsystem', () => {
  describe('dast-schema', () => {
    it('validates a SandboxExecResult', () => {
      const result: SandboxExecResult = {
        command: 'curl http://localhost:3000/api/users',
        durationMs: 150,
        exitCode: 0,
        stderr: '',
        stdout: '{"users":[]}',
        timestamp: new Date().toISOString(),
      };

      expect(sandboxExecResultSchema.parse(result)).to.deep.equal(result);
    });

    it('validates an OastCallback', () => {
      const callback: OastCallback = {
        headers: { 'user-agent': 'curl/7.64.0' },
        method: 'GET',
        timestamp: new Date().toISOString(),
        url: 'http://oast-abc123.shadow.local/exfil?data=secret',
      };

      expect(oastCallbackSchema.parse(callback)).to.deep.equal(callback);
    });

    it('validates a DastValidationResult', () => {
      const result: DastValidationResult = {
        endpoint: 'http://target:3000/api/proxy',
        method: 'POST',
        oastCallbacks: [],
        payload: '{"url":"http://oast-abc123.shadow.local"}',
        responseBody: '{"status":"ok"}',
        responseStatus: 200,
        validated: true,
      };

      expect(dastValidationResultSchema.parse(result)).to.have.property('validated', true);
    });

    it('validates an ExploitProofOfConcept', () => {
      const poc = {
        findingId: 'SHADOW-CWE-918-abc123',
        oastCallbacks: [{
          headers: {},
          method: 'GET',
          timestamp: new Date().toISOString(),
          url: 'http://oast-token.shadow.local',
        }],
        sandboxLogs: [{
          command: 'curl -X POST http://target:3000/api/proxy -d \'{"url":"http://oast-token.shadow.local"}\'',
          durationMs: 200,
          exitCode: 0,
          stderr: '',
          stdout: '{"status":"ok"}',
          timestamp: new Date().toISOString(),
        }],
        timestamp: new Date().toISOString(),
        validated: true,
      };

      const parsed = exploitProofOfConceptSchema.parse(poc);
      expect(parsed.validated).to.equal(true);
      expect(parsed.sandboxLogs).to.have.length(1);
      expect(parsed.oastCallbacks).to.have.length(1);
      expect(parsed.schemaVersion).to.be.a('string');
    });
  });

  describe('MirageOAST', () => {
    it('should record and retrieve callbacks', () => {
      const mirage = new MirageOAST({ networkName: 'shadow-net-test', runId: 'test-run' });

      mirage.recordCallback({
        headers: {},
        method: 'GET',
        timestamp: new Date().toISOString(),
        url: 'http://oast-abc123.shadow.local/ping',
      });

      expect(mirage.getCallbackLog()).to.have.length(1);
      expect(mirage.hasCallback('oast-abc123')).to.equal(true);
      expect(mirage.hasCallback('oast-xyz789')).to.equal(false);
    });

    it('should filter callbacks by domain', () => {
      const mirage = new MirageOAST({ networkName: 'shadow-net-test', runId: 'test-run' });

      mirage.recordCallback({
        headers: {},
        method: 'GET',
        timestamp: new Date().toISOString(),
        url: 'http://oast-abc.shadow.local/ping',
      });

      mirage.recordCallback({
        headers: {},
        method: 'POST',
        timestamp: new Date().toISOString(),
        url: 'http://example.com/api',
      });

      const filtered = mirage.getCallbacksForDomain('oast-abc');
      expect(filtered).to.have.length(1);
      expect(filtered[0].method).to.equal('GET');
    });

    it('should clear the log', () => {
      const mirage = new MirageOAST({ networkName: 'shadow-net-test', runId: 'test-run' });

      mirage.recordCallback({
        headers: {},
        method: 'GET',
        timestamp: new Date().toISOString(),
        url: 'http://oast-test.shadow.local',
      });

      expect(mirage.getCallbackLog()).to.have.length(1);
      mirage.clearLog();
      expect(mirage.getCallbackLog()).to.have.length(0);
    });

        it('caps the callback log as a ring buffer and flags overflow', () => {
          const mirage = new MirageOAST({ networkName: 'shadow-net-test', runId: 'test-run' });

          // Push well past the 5000-entry cap.
          const total = 5200;
          for (let i = 0; i < total; i++) {
            mirage.recordCallback({
              headers: {},
              method: 'GET',
              timestamp: new Date().toISOString(),
              url: `http://oast-${String(i).padStart(4, '0')}.shadow.local/x`,
            });
          }

          // Ring buffer retained only the newest entries.
          expect(mirage.getCallbackLog()).to.have.length(5000);
          expect(mirage.hasCallback('oast-0000')).to.equal(false);
          expect(mirage.hasCallback('oast-5199')).to.equal(true);
          expect(mirage.hasCallbackOverflow()).to.equal(true);
        });

    it('should generate unique tokens', () => {
      const mirage = new MirageOAST({ networkName: 'shadow-net-test', runId: 'test-run' });

      const token1 = mirage.generateToken('finding-1');
      const token2 = mirage.generateToken('finding-2');

      expect(token1).to.match(/^oast-[a-f0-9]+$/);
      expect(token2).to.match(/^oast-[a-f0-9]+$/);
      expect(token1).to.not.equal(token2);
    });

    it('should report running state correctly', () => {
      const mirage = new MirageOAST({ networkName: 'shadow-net-test', runId: 'test-run' });
      expect(mirage.isRunning()).to.equal(false);
    });

    it('removes a container even when startup never reached the running state', async () => {
      const calls: string[][] = [];
      const mirage = new MirageOAST({
        dockerExecutor: createRecordingDockerExecutor(calls),
        networkName: 'shadow-net-test',
        runId: 'cancelled-start',
      });

      await mirage.destroy();

      expect(calls).to.deep.equal([['rm', '-f', 'mirage-oast-cancelled-start']]);
    });

    it('gates the OAST log endpoint behind an unguessable token', async () => {
      const calls: string[][] = [];
      const mirage = new MirageOAST({
        dockerExecutor: createRecordingDockerExecutor(calls),
        networkName: 'shadow-net-test',
        runId: 'token-gated',
      });

      await mirage.start();
      await mirage.syncLog();

      const execCall = calls.find((args) => args[0] === 'exec');
      expect(execCall).to.be.an('array');
      const headerIdx = execCall!.indexOf('--header');
      expect(headerIdx).to.be.greaterThan(-1);
      expect(execCall![headerIdx + 1]).to.match(/^x-mirage-token: [a-f0-9]{32}$/);
    });
  });

  describe('SandboxManager', () => {
    it('should construct with default options', () => {
      const manager = new SandboxManager({
        runId: 'test-run-123',
        targetPath: '/tmp/test-project',
      });

      expect(manager.isRunning()).to.equal(false);
      expect(manager.getExecutionLog()).to.have.length(0);
      expect(manager.getMirage()).to.be.instanceOf(MirageOAST);
    });

    it('should reject exec when not running', async () => {
      const manager = new SandboxManager({
        runId: 'test-run-456',
        targetPath: '/tmp/test-project',
      });

      try {
        await manager.exec('echo hello');
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).to.include('not running');
      }
    });

    it('should reject deploy when not running', async () => {
      const manager = new SandboxManager({
        runId: 'test-run-789',
        targetPath: '/tmp/test-project',
      });

      try {
        await manager.deploy();
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).to.include('not created');
      }
    });

    it('cancels an in-flight Docker operation', async () => {
      const dockerExecutor = cancellableDockerExecutor as unknown as typeof execFile;
      const targetPath = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-dast-test-'));
      try {
        await fs.writeFile(path.join(targetPath, 'package.json'), '{}');
        const manager = new SandboxManager({
          dockerExecutor,
          runId: 'test-cancel',
          targetPath,
        });
        const controller = new AbortController();
        const creation = manager.create(controller.signal);
        setTimeout(() => controller.abort(new Error('cancelled')), 10);

        let error: unknown;
        try {
          await creation;
        } catch (error_) {
          error = error_;
        }

        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.equal('cancelled');
      } finally {
        await fs.rm(targetPath, { force: true, recursive: true });
      }
    });

    it('uses an internal network and a disposable writable workspace', async () => {
      const calls: string[][] = [];
      const targetPath = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-dast-test-'));
      try {
        await fs.writeFile(path.join(targetPath, 'package.json'), '{}');
        const manager = new SandboxManager({
          dockerExecutor: createRecordingDockerExecutor(calls),
          runId: 'test-isolation',
          targetPath,
        });

        await manager.create();

        expect(calls).to.deep.include([
          'network', 'create', '--internal', 'shadow-net-test-isolation',
        ]);
        const createCall = calls.find((args) => args[0] === 'create');
        const mount = createCall?.[createCall.indexOf('-v') + 1];
        expect(mount).to.match(/shadow-dast-.*[\\/]project:\/app:rw$/);
        expect(mount).not.to.equal(`${path.resolve(targetPath)}:/app:rw`);
        await manager.destroy();
      } finally {
        await fs.rm(targetPath, { force: true, recursive: true });
      }
    });

    it('pre-populates dependency directories into the workspace and adds Mirage DNS', async () => {
      const calls: string[][] = [];
      const targetPath = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-dast-deps-'));
      await fs.mkdir(path.join(targetPath, 'node_modules'));
          await fs.writeFile(path.join(targetPath, 'node_modules', 'dep.txt'), 'x');
          const manager = new SandboxManager({
            dockerExecutor: createRecordingDockerExecutor(calls),
            runId: 'test-dependencies',
            targetPath,
          });

          try {
            await manager.create();
            const createCall = calls.find((args) => args[0] === 'create') ?? [];
            // Host dependencies are copied into the disposable workspace instead of
            // being bind-mounted read-only, so the container sees a writable copy
            // and no host reference outlives the sandbox.
            expect(createCall.some((arg) => typeof arg === 'string' && arg.endsWith(':ro'))).to.equal(false);
            const mount = createCall[createCall.indexOf('-v') + 1];
            const workspacePath = mount.slice(0, mount.indexOf(':/app:rw'));
            await fs.access(path.join(workspacePath, 'node_modules', 'dep.txt'));
            // The `--dns` flag points the target at Mirage so DNS-based OAST
            // callbacks resolve on the --internal network (IP from the mocked
            // `inspect --format {{range .NetworkSettings...}}` response).
            expect(createCall).to.include('--dns');
            expect(createCall[createCall.indexOf('--dns') + 1]).to.equal('172.18.0.2');
          } finally {
            await manager.destroy();
            await fs.rm(targetPath, { force: true, recursive: true });
          }
        });

    it('uses the deployment command supplied by the tool invocation', async () => {
      const calls: string[][] = [];
      const targetPath = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-dast-command-'));
      const manager = new SandboxManager({
        dockerExecutor: createRecordingDockerExecutor(calls),
        runId: 'test-command',
        startCommand: 'npm start',
        targetPath,
      });

      try {
        await manager.create();
        await manager.deploy(undefined, 'npm run test-server');
        expect(calls).to.deep.include([
          'exec', 'shadow-target-test-command', 'sh', '-c', 'npm run test-server',
        ]);
      } finally {
        await manager.destroy();
        await fs.rm(targetPath, { force: true, recursive: true });
      }
    });

    it('fails closed when Docker cannot create the internal network', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dast-network-failure-'));
      let calls = 0;
      const executor = (
        _file: string,
        _args: readonly string[],
        _options: object,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        calls++;
        const error = calls === 1 ? Object.assign(new Error('network denied'), { code: 1 }) : null;
        callback(error, '', error ? 'network denied' : '');
        return {};
      };

      const sandbox = new SandboxManager({
        dockerExecutor: executor as unknown as typeof execFile,
        runId: 'network-failure',
        targetPath: tmpDir,
      });

      try {
        await expectRejected(sandbox.create(), 'Failed to create sandbox network');
        expect(sandbox.isRunning()).to.equal(false);
      } finally {
        await sandbox.destroy();
        await fs.rm(tmpDir, { force: true, recursive: true });
      }
    });

    it('fails closed when the target container exits during startup', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dast-start-failure-'));
      const sandbox = new SandboxManager({
        dockerExecutor: immediatelyExitedDockerExecutor as unknown as typeof execFile,
        runId: 'start-failure',
        targetPath: tmpDir,
      });

      try {
        await expectRejected(sandbox.create(), 'exited during startup');
        expect(sandbox.isRunning()).to.equal(false);
      } finally {
        await sandbox.destroy();
        await fs.rm(tmpDir, { force: true, recursive: true });
      }
    });

    it('rejects a failed target deployment command', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dast-deploy-failure-'));
      const sandbox = new SandboxManager({
        dockerExecutor: failedDeployDockerExecutor as unknown as typeof execFile,
        runId: 'deploy-failure',
        startCommand: 'npm start',
        targetPath: tmpDir,
      });

      try {
        await sandbox.create();
        await expectRejected(sandbox.deploy(), 'failed with exit code 7');
      } finally {
        await sandbox.destroy();
        await fs.rm(tmpDir, { force: true, recursive: true });
      }
    });
  });
});

async function expectRejected(promise: Promise<unknown>, message: string): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (error_) {
    error = error_;
  }

  expect(error).to.be.instanceOf(Error);
  expect((error as Error).message).to.include(message);
}
