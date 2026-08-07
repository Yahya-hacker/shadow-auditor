import { expect } from 'chai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SecurityReport } from '../src/core/output/report-schema.js';

import { scoreCvssVector } from '../src/core/output/cvss-scorer.js';
import { validateLocalReport } from '../src/core/output/report-safety.js';

const VECTOR = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';

function report(filePath: string): SecurityReport {
  const score = scoreCvssVector(VECTOR);
  if (!score) throw new Error('Test vector must be valid');
  return {
    findings: [{
      cvss_v31_score: score.baseScore,
      cvss_v31_vector: VECTOR,
      cwe: 'CWE-78',
      file_paths: [filePath],
      severity_label: score.severityLabel,
      title: 'Command injection\nwith untrusted input',
      vuln_id: 'SA-001',
    }],
  };
}

describe('local report safety', () => {
  let outsidePath: string;
  let repositoryPath: string;

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-auditor-report-'));
    repositoryPath = path.join(base, 'repository');
    outsidePath = path.join(base, 'outside.ts');
    await fs.mkdir(path.join(repositoryPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(repositoryPath, 'src', 'safe.ts'), 'export const safe = true;\n');
    await fs.writeFile(outsidePath, 'secret\n');
  });

  afterEach(async () => {
    await fs.rm(path.dirname(repositoryPath), { force: true, recursive: true });
  });

  it('accepts consistent CVSS data and repository-contained evidence', async () => {
    const validated = await validateLocalReport(report('src/safe.ts'), repositoryPath);
    expect(validated.report.findings[0]?.file_paths).to.deep.equal(['src/safe.ts']);
    expect(validated.markdown).to.include('## SA-001: Command injection with untrusted input');
  });

  it('rejects CVSS mismatches and missing evidence', async () => {
    const invalidScore = report('src/safe.ts');
    invalidScore.findings[0] = { ...invalidScore.findings[0]!, cvss_v31_score: 1 };
    let scoreFailure: unknown;
    try {
      await validateLocalReport(invalidScore, repositoryPath);
    } catch (error) {
      scoreFailure = error;
    }

    expect(String(scoreFailure)).to.include('inconsistent CVSS');

    let evidenceFailure: unknown;
    try {
      await validateLocalReport(report('src/missing.ts'), repositoryPath);
    } catch (error) {
      evidenceFailure = error;
    }

    expect(String(evidenceFailure)).to.include('ENOENT');
  });

  it('rejects evidence symlinks that escape the repository', async function () {
    const symlinkPath = path.join(repositoryPath, 'src', 'escape.ts');
    try {
      await fs.symlink(outsidePath, symlinkPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        this.skip();
        return;
      }

      throw error;
    }

    let failure: unknown;
    try {
      await validateLocalReport(report('src/escape.ts'), repositoryPath);
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).to.include('outside the repository');
  });
});
