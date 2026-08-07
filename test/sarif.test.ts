import { expect } from 'chai';

import { generateSarifReport } from '../src/core/output/sarif.js';

describe('sarif output', () => {
  it('generates valid SARIF basics for findings', () => {
    const sarif = generateSarifReport({
      findings: [
        {
          cvss_v31_score: 9.1,
          cvss_v31_vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:L',
          cvss_v40_score: null,
          cwe: 'CWE-89',
          file_paths: ['src/db/query.ts', 'src/api/user.ts'],
          severity_label: 'Critical',
          title: 'SQL injection through string concatenation',
          vuln_id: 'SHADOW-SQLI-001',
        },
      ],
    });

    expect(sarif.version).to.equal('2.1.0');
    const run = (sarif.runs as Array<Record<string, unknown>>)[0];
    const results = run.results as Array<Record<string, unknown>>;
    expect(results).to.have.length(1);
    expect(results[0].ruleId).to.equal('SHADOW-SQLI-001');
  });
});
