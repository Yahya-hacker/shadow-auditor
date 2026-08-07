import { expect } from 'chai';

import {
  type DastValidationResult,
  dastValidationResultSchema,
  type ExploitProofOfConcept,
  exploitProofOfConceptSchema,
  type OastCallback,
  oastCallbackSchema,
  type SandboxExecResult,
  sandboxExecResultSchema,
} from '../src/core/dast/dast-schema.js';
import { MirageOAST } from '../src/core/dast/mirage-oast.js';
import { SandboxManager } from '../src/core/dast/sandbox-manager.js';

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
  });
});
