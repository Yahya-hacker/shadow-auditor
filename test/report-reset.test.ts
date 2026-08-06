import { expect } from 'chai';

import { enhancedFindingSchema } from '../src/core/output/finding-schema.js';
import { ReportBuilder } from '../src/core/output/report-builder.js';

describe('ReportBuilder audit isolation', () => {
  it('does not fabricate complete coverage when the repository total is unknown', () => {
    const builder = new ReportBuilder({
      generateJson: false,
      generateMarkdown: false,
      generateSarif: false,
      outputDir: '.',
      runId: 'unknown-coverage-test',
    });

    const coverage = builder.build().metadata.coverage!;
    expect(coverage.filesAnalyzed).to.equal(0);
    expect(coverage.filesTotal).to.equal(0);
    expect(coverage.percentComplete).to.equal(0);
  });

  it('resets findings, identities, and coverage between audits', () => {
    const builder = new ReportBuilder({
      generateJson: false,
      generateMarkdown: false,
      generateSarif: false,
      outputDir: '.',
      runId: 'reset-test',
    });
    const finding = enhancedFindingSchema.parse({
      attackerPersonas: ['unauthenticated_remote'],
      confidence: 0.9,
      cvssV31Score: 8.6,
      cvssV31Vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:L/A:L',
      cwe: 'CWE-89',
      description: 'Untrusted input reaches a SQL query.',
      exploitability: 'easy',
      locations: [{ filePath: 'src/db.ts', startLine: 42 }],
      remediation: { breakingChange: false, summary: 'Use a parameterized query.' },
      rootCause: 'The query interpolates untrusted input.',
      severityLabel: 'High',
      title: 'SQL injection',
      vulnId: 'VULN-RESET-001',
    });

    expect(builder.addFinding(finding).added).to.equal(true);
    builder.setCoverage(12, 20);
    expect(builder.build().summary.totalFindings).to.equal(1);

    builder.reset();

    expect(builder.build().summary.totalFindings).to.equal(0);
    expect(builder.addFinding(finding).added).to.equal(true);
  });
});
