import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { PolicyAuditManager } from '../src/core/policy/policy-audit.js';

describe('policy audit manager', () => {
  it('seeds the sequence counter from loaded entries so new ids do not collide', async () => {
    const auditDir = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-audit-'));
    try {
      const auditPath = path.join(auditDir, 'policy-audit.jsonl');
      const runId = 'run-1';
      const now = new Date().toISOString();
      // Simulate a persisted log with entries already counted past 0002.
      const persisted = [
        {allowed: true, context: {command: 'ls'}, id: `${runId}-policy-0001`, reason: 'ok', runId, schemaVersion: '1', timestamp: now, type: 'command'},
        {allowed: true, context: {command: 'rg'}, id: `${runId}-policy-0002`, reason: 'ok', runId, schemaVersion: '1', timestamp: now, type: 'command'},
      ].map((entry) => JSON.stringify(entry)).join('\n');
      await fs.writeFile(auditPath, persisted, 'utf-8');

      const manager = new PolicyAuditManager(runId, auditDir);
            await manager.load();

      const entry = manager.recordCommandDecision('git status', {allowed: true, reason: 'ok'});

      expect(manager.getEntry(`${runId}-policy-0001`)?.context.command).to.equal('ls');
      expect(entry.id).not.to.equal(`${runId}-policy-0001`);
      expect(manager.getEntry(entry.id)?.context.command).to.equal('git status');
      expect(manager.getAllEntries()).to.have.length(3);
    } finally {
      await fs.rm(auditDir, {force: true, recursive: true});
    }
  });
});