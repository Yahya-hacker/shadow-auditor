import { expect } from 'chai';

import { extractJsonBlock, validateAndRepairReport } from '../src/core/output/report-validator.js';

describe('report validator', () => {
  it('extracts JSON blocks from markdown output', () => {
    const block = extractJsonBlock('Analysis text\n```json\n{"findings":[]}\n```');
    expect(block).to.equal('{"findings":[]}');
  });

  it('repairs invalid report payloads using provided repair callback', async () => {
    const invalidResponse = `Findings below:
\`\`\`json
{"findings":[{"title":"Missing required fields"}]}
\`\`\``;

    const result = await validateAndRepairReport({
      maxRetries: 2,
      repair: async () =>
        JSON.stringify({
          findings: [
            {
              cwe: 'CWE-79',
              cvss_v31_score: 7.5,
              cvss_v31_vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N',
              cvss_v40_score: null,
              file_paths: ['src/ui/render.ts'],
              severity_label: 'High',
              title: 'Reflected XSS via unsanitized HTML sink',
              vuln_id: 'SHADOW-001',
            },
          ],
        }),
      responseText: invalidResponse,
    });

    expect(result.repaired).to.equal(true);
    expect(result.attempts).to.equal(1);
    expect(result.report.findings[0].vuln_id).to.equal('SHADOW-001');
  });
});
