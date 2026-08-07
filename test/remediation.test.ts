import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { RemediationLoop } from '../src/core/remediation/remediation-loop.js';
import { type TestFingerprint, TestRunner } from '../src/core/remediation/test-runner.js';

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
          expect(framework.command).to.equal('pytest');
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
          expect(framework.command).to.equal('go test ./...');
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
            framework: 'npm',
            hash: 'abc123',
            timestamp: new Date().toISOString(),
          };

          runner.setBaseline(baseline);
          expect(runner.getBaseline()).to.deep.equal(baseline);
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
            framework: 'npm',
            hash: 'original',
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
            framework: 'npm',
            hash: 'with-failure',
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
  });
});
