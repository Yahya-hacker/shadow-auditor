import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { RemediationLoop } from '../src/core/remediation/remediation-loop.js';
import { createRemediationTools } from '../src/core/remediation/remediation-tools.js';
import { type TestFingerprint, TestRunner } from '../src/core/remediation/test-runner.js';
import { removePathResilient } from '../src/utils/fs-atomic.js';

describe('remediation', () => {
  describe('TestRunner', () => {
    describe('detect', () => {
      it('should detect npm from package.json', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-test-'));
        try {
          await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
          const runner = await TestRunner.detect({ projectRoot: tmpDir, useDocker: false });
          const framework = runner.getFramework();
          expect(framework.name).to.equal('npm');
          expect(framework.command).to.equal('npm test');
        } finally {
          await fs.rm(tmpDir, { force: true, recursive: true });
        }
      });

      it('should detect pytest from pyproject.toml', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-test-'));
        try {
          await fs.writeFile(path.join(tmpDir, 'pyproject.toml'), '[tool.pytest]');
          const runner = await TestRunner.detect({ projectRoot: tmpDir, useDocker: false });
          const framework = runner.getFramework();
          expect(framework.name).to.equal('pytest');
          expect(framework.command).to.equal('pytest -vv');
        } finally {
          await fs.rm(tmpDir, { force: true, recursive: true });
        }
      });

      it('should detect go from go.mod', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-test-'));
        try {
          await fs.writeFile(path.join(tmpDir, 'go.mod'), 'module example.com/test');
          const runner = await TestRunner.detect({ projectRoot: tmpDir, useDocker: false });
          const framework = runner.getFramework();
          expect(framework.name).to.equal('go');
          expect(framework.command).to.equal('go test -json ./...');
        } finally {
          await fs.rm(tmpDir, { force: true, recursive: true });
        }
      });

      it('should detect cargo from Cargo.toml', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-test-'));
        try {
          await fs.writeFile(path.join(tmpDir, 'Cargo.toml'), '[package]');
          const runner = await TestRunner.detect({ projectRoot: tmpDir, useDocker: false });
          const framework = runner.getFramework();
          expect(framework.name).to.equal('cargo');
        } finally {
          await fs.rm(tmpDir, { force: true, recursive: true });
        }
      });

      it('should return unknown when no manifest found', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-test-'));
        try {
          const runner = await TestRunner.detect({ projectRoot: tmpDir, useDocker: false });
          const framework = runner.getFramework();
          expect(framework.name).to.equal('unknown');
        } finally {
          await fs.rm(tmpDir, { force: true, recursive: true });
        }
      });

      it('should use custom test command when provided', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-test-'));
        try {
          const runner = await TestRunner.detect({
            projectRoot: tmpDir,
            testCommand: 'make test',
            useDocker: false,
          });

          // The custom command doesn't change the detected framework name
          const framework = runner.getFramework();
          expect(framework.name).to.equal('unknown');
        } finally {
          await fs.rm(tmpDir, { force: true, recursive: true });
        }
      });

      it('separates dependency preparation from networkless repository tests', () => {
        const runner = TestRunner.fromFramework(
          {
            projectRoot: path.join(os.tmpdir(), 'shadow-network-contract'),
            testCommand: 'npm test',
            useDocker: true,
          },
          {command: 'npm test', image: 'node:24', name: 'npm'},
        );
        const internals = runner as unknown as {
          buildCommand(root: string): {args: string[]};
          buildDependencyCommands(root: string): Array<{args: string[]}>;
        };

        const testCommand = internals.buildCommand('/tmp/disposable-project').args;
        const [dependencyCommand = {args: []}] =
          internals.buildDependencyCommands('/tmp/disposable-project');
        expect(testCommand).to.include.members(['--network', 'none']);
        expect(testCommand.at(-1)).to.equal('npm test');
        expect(testCommand.join(' ')).not.to.include('npm install');
        expect(dependencyCommand.args.join(' ')).to.include('npm ci --ignore-scripts');
        expect(dependencyCommand.args).not.to.include('none');
      });

      it('persists Cargo dependency caches and keeps test execution offline', () => {
        const runner = TestRunner.fromFramework(
          {
            projectRoot: path.join(os.tmpdir(), 'shadow-cargo-contract'),
            testCommand: 'cargo test',
            useDocker: true,
          },
          {command: 'cargo test', image: 'rust:1.83', name: 'cargo'},
        );
        const internals = runner as unknown as {
          buildCommand(root: string): {args: string[]};
          buildDependencyCommands(root: string): Array<{args: string[]}>;
        };

        const testArgs = internals.buildCommand('/tmp/disposable-project').args;
        const [preparation] = internals.buildDependencyCommands('/tmp/disposable-project');
        expect(preparation?.args.join(' ')).to.include('/cargo-home/registry');
        expect(preparation?.args.join(' ')).to.include('/cargo-home/git');
        expect(testArgs.join(' ')).to.include('/cargo-home/registry:ro');
        expect(testArgs.join(' ')).to.include('/cargo-home/git:ro');
        expect(testArgs).to.include.members(['--network', 'none', 'CARGO_NET_OFFLINE=true']);
      });

      it('downloads only Python wheels before installing them without network access', () => {
        const runner = TestRunner.fromFramework(
          {
            projectRoot: path.join(os.tmpdir(), 'shadow-python-contract'),
            testCommand: 'pytest',
            useDocker: true,
          },
          {command: 'pytest', image: 'python:3.12', name: 'pytest'},
        );
        const internals = runner as unknown as {
          buildDependencyCommands(root: string): Array<{args: string[]}>;
        };

        const [download, install] =
          internals.buildDependencyCommands('/tmp/disposable-project');
        expect(download?.args.join(' ')).to.include('pip download');
        expect(download?.args.join(' ')).to.include('--only-binary=:all:');
        expect(install?.args).to.include.members(['--network', 'none']);
        expect(install?.args.join(' ')).to.include('--no-index');
        expect(install?.args.join(' ')).to.include('/wheels:ro');
      });

      it('rejects executable Python dependency sources before starting Docker', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-python-requirements-'));
        try {
          await fs.writeFile(path.join(tmpDir, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
          await fs.writeFile(
            path.join(tmpDir, 'requirements.txt'),
            'malicious @ git+https://example.invalid/malicious.git\n',
          );
          const runner = TestRunner.fromFramework(
            {projectRoot: tmpDir, testCommand: 'pytest', useDocker: true},
            {command: 'pytest', image: 'python:3.12', name: 'pytest'},
          );

          let error: unknown;
          try {
            await runner.run();
          } catch (error_) {
            error = error_;
          }

          expect(error).to.be.instanceOf(Error);
          expect((error as Error).message).to.include('Unsafe Python requirement');
        } finally {
          await fs.rm(tmpDir, {force: true, recursive: true});
        }
      });
    });

    describe('baseline fingerprinting', () => {
      it('should capture and store a baseline', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-test-'));
        try {
          await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
          const runner = await TestRunner.detect({
            projectRoot: tmpDir,
            testCommand: 'echo "✔ test_a" && echo "1) test_b"',
            useDocker: false,
          });

          const baseline = await runner.captureBaseline();
          expect(baseline.framework).to.equal('npm');
          expect(baseline.hash).to.be.a('string').with.length.greaterThan(0);
          expect(baseline.entries).to.have.length(2);
          expect(baseline.entries[0]).to.deep.include({ status: 'pass', testName: 'test_a' });
          expect(baseline.entries[1]).to.deep.include({ status: 'fail', testName: 'test_b' });
        } finally {
          await fs.rm(tmpDir, { force: true, recursive: true });
        }
      });

      it('should serialize/deserialize baseline via setBaseline', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-test-'));
        try {
          await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
          const runner = await TestRunner.detect({ projectRoot: tmpDir, useDocker: false });

          const baseline: TestFingerprint = {
            entries: [
              { status: 'pass', testName: 'test_a' },
              { status: 'fail', testName: 'test_b' },
            ],
            exitCode: 0,
            framework: 'npm',
            hash: 'abc123',
            outputLineCount: 2,
            timestamp: new Date().toISOString(),
          };

          runner.setBaseline(baseline);
          expect(runner.getBaseline()).to.deep.equal(baseline);
        } finally {
          await fs.rm(tmpDir, { force: true, recursive: true });
        }
      });

      it('rejects a successful baseline with no machine-readable tests', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-test-'));
        try {
          await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
          const runner = await TestRunner.detect({
            projectRoot: tmpDir,
            testCommand: 'echo ok',
            useDocker: false,
          });

          let error: unknown;
          try {
            await runner.captureBaseline();
          } catch (error_) {
            error = error_;
          }

          expect((error as Error).message).to.include('baseline reported no tests');
        } finally {
          await fs.rm(tmpDir, { force: true, recursive: true });
        }
      });

      it('parses default verbose output for pytest, Go, and Cargo', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-test-'));
        try {
          for (const [framework, output] of [
            ['pytest', 'tests/test_app.py::test_safe PASSED [100%]'],
            ['go', '{"Action":"pass","Package":"example.com/app","Test":"TestSafe"}'],
            ['cargo', 'test tests::safe ... ok'],
          ] as const) {
            const runner = TestRunner.fromFramework(
              {
                projectRoot: tmpDir,
                testCommand: `printf '%s\\n' '${output}'`,
                useDocker: false,
              },
              { command: 'unused', image: 'unused', name: framework },
            );
            expect((await runner.captureBaseline()).entries).to.have.length(1);
          }
        } finally {
          await fs.rm(tmpDir, { force: true, recursive: true });
        }
      });
    });

    describe('degradation detection', () => {
      it('should detect no degradation when same tests fail', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-test-'));
        try {
          await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');

          // Simulate: test_b fails in both baseline and run
          const runner = await TestRunner.detect({
            projectRoot: tmpDir,
            testCommand: 'echo "✔ test_a" && echo "1) test_b"',
            useDocker: false,
          });

          // Capture baseline (test_b fails)
          await runner.captureBaseline();

          // Run again (same failures)
          const result = await runner.run();
          expect(result.degraded).to.equal(false);
          expect(result.passed).to.equal(true);
          expect(result.newFailures).to.have.length(0);
        } finally {
          await fs.rm(tmpDir, { force: true, recursive: true });
        }
      });

      it('should detect degradation when new test fails', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-test-'));
        try {
          await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');

          // Baseline: only test_b fails
          const runner = await TestRunner.detect({
            projectRoot: tmpDir,
            testCommand: 'echo "✔ test_a" && echo "1) test_b"',
            useDocker: false,
          });

          const baseline: TestFingerprint = {
            entries: [
              { status: 'pass', testName: 'test_a' },
              // test_b not in baseline = new failure
            ],
            exitCode: 0,
            framework: 'npm',
            hash: 'original',
            outputLineCount: 2,
            timestamp: new Date().toISOString(),
          };
          runner.setBaseline(baseline);

          // Run: test_b now fails
          const result = await runner.run();
          expect(result.degraded).to.equal(true);
          expect(result.passed).to.equal(false);
          expect(result.newFailures).to.include('test_b');
        } finally {
          await fs.rm(tmpDir, { force: true, recursive: true });
        }
      });

      it('should detect resolved failures', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-test-'));
        try {
          await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');

          const runner = await TestRunner.detect({
            projectRoot: tmpDir,
            testCommand: 'echo "✔ test_a" && echo "✔ test_b"',
            useDocker: false,
          });

          // Baseline had test_b failing
          const baseline: TestFingerprint = {
            entries: [
              { status: 'pass', testName: 'test_a' },
              { status: 'fail', testName: 'test_b' },
            ],
            exitCode: 0,
            framework: 'npm',
            hash: 'with-failure',
            outputLineCount: 2,
            timestamp: new Date().toISOString(),
          };
          runner.setBaseline(baseline);

          // Now test_b passes — resolved
          const result = await runner.run();
          expect(result.degraded).to.equal(false);
          expect(result.resolvedFailures).to.include('test_b');
        } finally {
          await fs.rm(tmpDir, { force: true, recursive: true });
        }
      });

      it('should reject a run whose validation output disappears', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-test-'));
        try {
          await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
          const runner = await TestRunner.detect({
            projectRoot: tmpDir,
            testCommand: 'node -e ""',
            useDocker: false,
          });

          runner.setBaseline({
            entries: [{ status: 'pass', testName: 'baseline test' }],
            exitCode: 0,
            framework: 'npm',
            hash: 'baseline',
            outputLineCount: 1,
            timestamp: new Date().toISOString(),
          });

          const result = await runner.run();

          expect(result.degraded).to.equal(true);
          expect(result.passed).to.equal(false);
        } finally {
          await fs.rm(tmpDir, { force: true, recursive: true });
        }
      });

      it('rejects replacement tests even when the total count is unchanged', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-test-'));
        try {
          const runner = TestRunner.fromFramework(
            {
              projectRoot: tmpDir,
              testCommand: 'echo "✔ replacement_test"',
              useDocker: false,
            },
            { command: 'unused', image: 'unused', name: 'npm' },
          );
          runner.setBaseline({
            entries: [{ status: 'pass', testName: 'protected_test' }],
            exitCode: 0,
            framework: 'npm',
            hash: 'baseline',
            outputLineCount: 1,
            timestamp: new Date().toISOString(),
          });

          expect((await runner.run()).degraded).to.equal(true);
        } finally {
          await fs.rm(tmpDir, { force: true, recursive: true });
        }
      });

      it('distinguishes duplicate Go test names across packages', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-test-'));
        try {
          const output = [
            '{"Action":"pass","Package":"example.com/app/a","Test":"TestShared"}',
            '{"Action":"fail","Package":"example.com/app/b","Test":"TestShared"}',
          ];
          const runner = TestRunner.fromFramework(
            {
              projectRoot: tmpDir,
              testCommand: `printf '%s\\n' '${output.join("' '")}'`,
              useDocker: false,
            },
            { command: 'unused', image: 'unused', name: 'go' },
          );
          runner.setBaseline({
            entries: [
              { status: 'fail', testName: 'example.com/app/a/TestShared' },
              { status: 'pass', testName: 'example.com/app/b/TestShared' },
            ],
            exitCode: 1,
            framework: 'go',
            hash: 'baseline',
            outputLineCount: 2,
            timestamp: new Date().toISOString(),
          });

          const result = await runner.run();

          expect(result.degraded).to.equal(true);
          expect(result.newFailures).to.deep.equal(['example.com/app/b/TestShared']);
        } finally {
          await fs.rm(tmpDir, { force: true, recursive: true });
        }
      });

      it('detects new Go package build failures when the baseline already fails', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-test-'));
        try {
          const output = [
            '{"Action":"fail","Package":"example.com/app/a","Test":"TestExisting"}',
            '{"Action":"fail","Package":"example.com/app/a"}',
            '{"Action":"fail","Package":"example.com/app/b"}',
          ];
          const runner = TestRunner.fromFramework(
            {
              projectRoot: tmpDir,
              testCommand: `printf '%s\\n' '${output.join("' '")}'`,
              useDocker: false,
            },
            { command: 'unused', image: 'unused', name: 'go' },
          );
          runner.setBaseline({
            entries: [
              { status: 'fail', testName: 'example.com/app/a/TestExisting' },
              { status: 'fail', testName: 'example.com/app/a/<package>' },
              { status: 'pass', testName: 'example.com/app/b/<package>' },
            ],
            exitCode: 1,
            framework: 'go',
            hash: 'baseline',
            outputLineCount: 3,
            timestamp: new Date().toISOString(),
          });

          const result = await runner.run();

          expect(result.degraded).to.equal(true);
          expect(result.newFailures).to.deep.equal(['example.com/app/b/<package>']);
        } finally {
          await fs.rm(tmpDir, { force: true, recursive: true });
        }
      });

      it('isolates test-generated repository mutations', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-test-'));
        try {
          const runner = TestRunner.fromFramework(
            {
              projectRoot: tmpDir,
              testCommand: 'touch test-payload && echo "✔ isolated"',
              useDocker: false,
            },
            { command: 'unused', image: 'unused', name: 'npm' },
          );

          await runner.captureBaseline();
          await expectMissing(path.join(tmpDir, 'test-payload'));
        } finally {
          await fs.rm(tmpDir, { force: true, recursive: true });
        }
      });
    });
  });

  describe('RemediationLoop', () => {
    it('should construct with valid options', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-test-'));
      try {
        await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
        const runner = await TestRunner.detect({ projectRoot: tmpDir, useDocker: false });

        const loop = new RemediationLoop({
          autoRevert: true,
          projectRoot: tmpDir,
          testRunner: runner,
        });

        expect(loop).to.be.instanceOf(RemediationLoop);
      } finally {
        await fs.rm(tmpDir, { force: true, recursive: true });
      }
    });

    it('keeps user-owned changes while applying a validated patch', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-remediation-'));
      try {
        await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
        await fs.writeFile(path.join(tmpDir, 'target.txt'), 'before\n');
        await fs.writeFile(path.join(tmpDir, 'user.txt'), 'user-original\n');
        await initializeGitRepository(tmpDir);
        await fs.writeFile(path.join(tmpDir, 'user.txt'), 'user-change\n');
        const runner = await TestRunner.detect({
          projectRoot: tmpDir,
          testCommand: 'echo "✔ validation"',
          useDocker: false,
        });
        const loop = new RemediationLoop({
          autoRevert: true,
          projectRoot: tmpDir,
          testRunner: runner,
        });

        const result = await loop.execute('finding-1', targetPatch);

        expect(result.status).to.equal('applied');
        expect(await fs.readFile(path.join(tmpDir, 'target.txt'), 'utf8')).to.equal('after\n');
        expect(await fs.readFile(path.join(tmpDir, 'user.txt'), 'utf8')).to.equal('user-change\n');
      } finally {
        await fs.rm(tmpDir, { force: true, recursive: true });
      }
    });

    it('validates a patch off-host and applies it only with its one-use token', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-remediation-'));
      try {
        await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
        await fs.writeFile(path.join(tmpDir, 'target.txt'), 'before\n');
        await initializeGitRepository(tmpDir);
        const runner = await TestRunner.detect({
          projectRoot: tmpDir,
          testCommand: 'echo "✔ validation"',
          useDocker: false,
        });
        const loop = new RemediationLoop({ projectRoot: tmpDir, testRunner: runner });

        const validation = await loop.validatePatch('finding-1', targetPatch);

        expect(validation.testResult.passed).to.equal(true);
        expect(await fs.readFile(path.join(tmpDir, 'target.txt'), 'utf8')).to.equal('before\n');
        await loop.applyValidatedPatch(validation.token, targetPatch);
        expect(await fs.readFile(path.join(tmpDir, 'target.txt'), 'utf8')).to.equal('after\n');

        let replayError: unknown;
        try {
          await loop.applyValidatedPatch(validation.token, targetPatch);
        } catch (error) {
          replayError = error;
        }

        expect((replayError as Error).message).to.include('already used');
      } finally {
        await fs.rm(tmpDir, { force: true, recursive: true });
      }
    });

    it('invalidates validation when an affected source file changes', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-remediation-'));
      try {
        await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
        await fs.writeFile(path.join(tmpDir, 'target.txt'), 'before\n');
        await initializeGitRepository(tmpDir);
        const runner = await TestRunner.detect({
          projectRoot: tmpDir,
          testCommand: 'echo "✔ validation"',
          useDocker: false,
        });
        const loop = new RemediationLoop({ projectRoot: tmpDir, testRunner: runner });
        const validation = await loop.validatePatch('finding-1', targetPatch);
        await fs.writeFile(path.join(tmpDir, 'target.txt'), 'user changed this\n');

        let applyError: unknown;
        try {
          await loop.applyValidatedPatch(validation.token, targetPatch);
        } catch (error) {
          applyError = error;
        }

        expect((applyError as Error).message).to.include('changed after validation');
        expect(await fs.readFile(path.join(tmpDir, 'target.txt'), 'utf8')).to.equal('user changed this\n');
      } finally {
        await fs.rm(tmpDir, { force: true, recursive: true });
      }
    });

    it('rejects path-escaping patches before validation', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-remediation-'));
      try {
        await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
        const runner = await TestRunner.detect({
          projectRoot: tmpDir,
          testCommand: 'echo "✔ validation"',
          useDocker: false,
        });
        const loop = new RemediationLoop({ projectRoot: tmpDir, testRunner: runner });
        const unsafePatch = targetPatch
          .replaceAll('a/target.txt', 'a/../outside.txt')
          .replaceAll('b/target.txt', 'b/../outside.txt');

        let validationError: unknown;
        try {
          await loop.validatePatch('finding-1', unsafePatch);
        } catch (error) {
          validationError = error;
        }

        expect((validationError as Error).message).to.include('unsafe path');
      } finally {
        await fs.rm(tmpDir, { force: true, recursive: true });
      }
    });

    it('reverts only its own patch when validation degrades', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-remediation-'));
      try {
        await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
        await fs.writeFile(path.join(tmpDir, 'target.txt'), 'before\n');
        await fs.writeFile(path.join(tmpDir, 'user.txt'), 'user-original\n');
        await initializeGitRepository(tmpDir);
        await fs.writeFile(path.join(tmpDir, 'user.txt'), 'user-change\n');
        const runner = await TestRunner.detect({
          projectRoot: tmpDir,
          testCommand: 'echo "1) regression"',
          useDocker: false,
        });
        runner.setBaseline({
          entries: [{ status: 'pass', testName: 'regression' }],
          exitCode: 0,
          framework: 'npm',
          hash: 'baseline',
          outputLineCount: 1,
          timestamp: new Date().toISOString(),
        });
        const loop = new RemediationLoop({
          autoRevert: true,
          projectRoot: tmpDir,
          testRunner: runner,
        });

        const result = await loop.execute('finding-1', targetPatch);

        expect(result.status).to.equal('reverted');
        expect(await fs.readFile(path.join(tmpDir, 'target.txt'), 'utf8')).to.equal('before\n');
        expect(await fs.readFile(path.join(tmpDir, 'user.txt'), 'utf8')).to.equal('user-change\n');
      } finally {
        await fs.rm(tmpDir, { force: true, recursive: true });
      }
    });

    it('reverts only its own patch when validation is cancelled', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-remediation-'));
      try {
        await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
        await fs.writeFile(path.join(tmpDir, 'target.txt'), 'before\n');
        await fs.writeFile(path.join(tmpDir, 'user.txt'), 'user-original\n');
        await initializeGitRepository(tmpDir);
        await fs.writeFile(path.join(tmpDir, 'user.txt'), 'user-change\n');
        const runner = await TestRunner.detect({
          projectRoot: tmpDir,
          testCommand: 'node -e "setTimeout(() => {}, 10000)"',
          useDocker: false,
        });
        const loop = new RemediationLoop({
          autoRevert: true,
          projectRoot: tmpDir,
          testRunner: runner,
        });
        const controller = new AbortController();
        const execution = loop.execute('finding-1', targetPatch, controller.signal);
        setTimeout(() => controller.abort(new Error('cancelled')), 50);

        let error: unknown;
        try {
          await execution;
        } catch (error_) {
          error = error_;
        }

        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.equal('cancelled');
        expect(await fs.readFile(path.join(tmpDir, 'target.txt'), 'utf8')).to.equal('before\n');
        expect(await fs.readFile(path.join(tmpDir, 'user.txt'), 'utf8')).to.equal('user-change\n');
      } finally {
        // The aborted test-runner child can leave a directory handle briefly on
        // Windows, so retry removal rather than failing the test.
        await removePathResilient(tmpDir);
      }
    });

    it('reverts a patch when the test runner crashes without named failures', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-remediation-'));
      try {
        await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
        await fs.writeFile(path.join(tmpDir, 'target.txt'), 'before\n');
        await initializeGitRepository(tmpDir);
        const runner = await TestRunner.detect({
          projectRoot: tmpDir,
          testCommand: 'node -e "process.stderr.write(\'compile error\'); process.exit(1)"',
          useDocker: false,
        });
        runner.setBaseline({
          entries: [{ status: 'pass', testName: 'existing test' }],
          exitCode: 0,
          framework: 'npm',
          hash: 'baseline',
          outputLineCount: 1,
          timestamp: new Date().toISOString(),
        });
        const loop = new RemediationLoop({
          autoRevert: true,
          projectRoot: tmpDir,
          testRunner: runner,
        });

        const result = await loop.execute('finding-1', targetPatch);

        expect(result.status).to.equal('reverted');
        expect(result.testResult?.degraded).to.equal(true);
        expect(await fs.readFile(path.join(tmpDir, 'target.txt'), 'utf8')).to.equal('before\n');
      } finally {
        await fs.rm(tmpDir, { force: true, recursive: true });
      }
    });
  });

  describe('createRemediationTools', () => {
    it('reports applied_unrecorded when the audit write fails after a successful apply', async () => {
      const validation = {
        findingId: 'finding-1',
        patchHash: 'hash-1',
        sourceFingerprint: 'fp-1',
        testResult: {
          command: 'npm test',
          degraded: false,
          durationMs: 1,
          exitCode: 0,
          framework: 'npm',
          newFailures: [],
          passed: true,
          resolvedFailures: [],
          stderr: '',
          stdout: 'ok',
        },
        token: 'token-1',
      };
      const applyCalls: string[] = [];
      const fakeLoop = {
        async applyValidatedPatch(token: string) {
          applyCalls.push(token);
        },
        discardValidation() {},
        recordDecision,
        validatePatch: async () => validation,
      };

      const tools = createRemediationTools({
        confirmPatch: async () => ({ action: 'apply' as const }),
        projectRoot: '/tmp/fake',
        remediationLoop: fakeLoop as unknown as RemediationLoop,
        testRunner: {} as TestRunner,
      });
      const tool = tools.apply_and_test_patch as {
        execute: (input: { diff: string; findingId: string }, options: unknown) => Promise<unknown>;
      };

      const raw = await tool.execute({ diff: targetPatch, findingId: 'finding-1' }, {});
      const result = JSON.parse(String(raw)) as Record<string, unknown>;

      expect(applyCalls).to.deep.equal(['token-1']);
      expect(result.status).to.equal('applied_unrecorded');
      expect(result.recordError).to.equal('disk full');
      expect(result.testPassed).to.equal(true);
    });
});
  });

  const targetPatch = `diff --git a/target.txt b/target.txt
index 90be1f3..3b18e51 100644
--- a/target.txt
+++ b/target.txt
@@ -1 +1 @@
-before
+after
`;

async function recordDecision(): Promise<never> {
  throw new Error('disk full');
}

async function initializeGitRepository(directory: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  await run('git', ['init', '--quiet'], { cwd: directory });
  await run('git', ['add', '.'], { cwd: directory });
}

async function expectMissing(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
    expect.fail(`Expected ${filePath} not to exist.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
