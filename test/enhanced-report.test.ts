import { expect } from 'chai';

import {
  enhancedFindingSchema,
  type EnhancedReport,
  enhancedReportSchema,
  FindingBuilder,
  validateFinding,
  validateReport,
} from '../src/core/output/finding-schema.js';
import { generateEnhancedSarifReport } from '../src/core/output/sarif.js';

type SarifResult = {
  level: string;
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region?: { startLine?: number };
    };
  }>;
  ruleId: string;
};

type SarifRun = {
  results: SarifResult[];
  tool: {
    driver: {
      name: string;
      rules: Array<{ id: string }>;
      version: string;
    };
  };
};

type SarifPayload = {
  $schema: string;
  runs: SarifRun[];
  version: string;
};

const validFindingInput = {
  attackerPersonas: ['unauthenticated_remote' as const],
  confidence: 0.92,
  cvssV31Score: 8.6,
  cvssV31Vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:L/A:L',
  cwe: 'CWE-89',
  description: 'User input is passed directly to SQL query',
  exploitability: 'easy' as const,
  locations: [{
    filePath: 'src/auth/login.ts',
    snippet: String.raw`db.query(\`SELECT * FROM users WHERE id = \${userId}\`)`,
    startLine: 42,
  }],
  remediation: {
    breakingChange: false,
    codeExample: 'db.query("SELECT * FROM users WHERE id = ?", [userId])',
    summary: 'Use parameterized queries or prepared statements',
  },
  rootCause: 'String concatenation used instead of parameterized queries',
  severityLabel: 'High' as const,
  title: 'SQL Injection in Login',
  vulnId: 'VULN-001',
};

function createValidEnhancedReport(): EnhancedReport {
  return enhancedReportSchema.parse({
    findings: [{
      attackerPersonas: ['unauthenticated_remote'],
      confidence: 0.9,
      cvssV31Score: 7.5,
      cvssV31Vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
      cwe: 'CWE-89',
      exploitability: 'easy',
      locations: [{ filePath: 'src/db.ts', startLine: 42 }],
      remediation: {
        breakingChange: false,
        summary: 'Use prepared statements',
      },
      rootCause: 'Unparameterized query',
      severityLabel: 'High',
      title: 'SQL Injection',
      vulnId: 'VULN-001',
    }],
    metadata: {
      generatedAt: new Date().toISOString(),
      reportId: 'report-001',
      runId: 'run-001',
      toolVersion: '1.0.0',
    },
    summary: {
      byConfidence: { high: 1, low: 0, medium: 0 },
      bySeverity: { critical: 0, high: 1, info: 0, low: 0, medium: 0 },
      totalFindings: 1,
    },
  });
}

function toSarif(payload: Record<string, unknown>): SarifPayload {
  return payload as unknown as SarifPayload;
}

describe('enhanced reporting pipeline', () => {
  describe('enhanced finding schema', () => {
    const parsedFinding = enhancedFindingSchema.parse(validFindingInput);

    describe('schema validation', () => {
      it('accepts valid finding', () => {
        const result = enhancedFindingSchema.safeParse(validFindingInput);
        expect(result.success).to.equal(true);
      });

      it('rejects finding without required fields', () => {
        const result = enhancedFindingSchema.safeParse({ title: 'Test' });
        expect(result.success).to.equal(false);
      });

      it('validates CVSS vector format', () => {
        const result = enhancedFindingSchema.safeParse({
          ...validFindingInput,
          cvssV31Vector: 'invalid-vector',
        });
        expect(result.success).to.equal(false);
      });

      it('validates CWE format', () => {
        const result = enhancedFindingSchema.safeParse({
          ...validFindingInput,
          cwe: 'SQL-INJECTION',
        });
        expect(result.success).to.equal(false);
      });

      it('validates confidence range', () => {
        const result = enhancedFindingSchema.safeParse({
          ...validFindingInput,
          confidence: 1.5,
        });
        expect(result.success).to.equal(false);
      });

      it('validates attacker personas enum', () => {
        const result = enhancedFindingSchema.safeParse({
          ...validFindingInput,
          attackerPersonas: ['hacker'],
        });
        expect(result.success).to.equal(false);
      });
    });

    describe('validateFinding', () => {
      it('returns valid: true for valid finding', () => {
        const result = validateFinding(parsedFinding);
        expect(result.valid).to.equal(true);
        expect(result.errors).to.be.empty;
      });

      it('returns detailed errors for invalid finding', () => {
        const result = validateFinding({
          cvssV31Score: 'not-a-number',
          title: 'Test',
        });
        expect(result.valid).to.equal(false);
        expect(result.errors.length).to.be.greaterThan(0);
      });
    });

    describe('FindingBuilder', () => {
      it('builds valid finding with fluent interface', () => {
        const finding = new FindingBuilder('VULN-002', 'XSS Vulnerability')
          .severity('Medium', 6.1, 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N')
          .cwe('CWE-79')
          .attackers('unauthenticated_remote')
          .exploitability('easy')
          .location({
            filePath: 'src/views/profile.tsx',
            startLine: 100,
          })
          .rootCause('User input rendered without escaping')
          .remediation({
            breakingChange: false,
            summary: 'Escape user input before rendering',
          })
          .confidence(0.85)
          .build();

        expect(finding.vulnId).to.equal('VULN-002');
        expect(finding.severityLabel).to.equal('Medium');
        expect(finding.cwe).to.equal('CWE-79');
      });

      it('supports multiple locations', () => {
        const finding = new FindingBuilder('VULN-003', 'Multi-location Issue')
          .severity('Low', 3, 'CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N')
          .cwe('CWE-200')
          .attackers('authenticated_user')
          .exploitability('moderate')
          .location({ filePath: 'src/a.ts', startLine: 1 })
          .location({ filePath: 'src/b.ts', startLine: 2 })
          .rootCause('Information exposure')
          .remediation({ breakingChange: false, summary: 'Restrict access' })
          .confidence(0.7)
          .build();

        expect(finding.locations).to.have.lengthOf(2);
      });

      it('supports assumptions', () => {
        const finding = new FindingBuilder('VULN-004', 'Assumed Vulnerability')
          .severity('High', 7.5, 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N')
          .cwe('CWE-22')
          .attackers('unauthenticated_remote')
          .exploitability('moderate')
          .location({ filePath: 'src/files.ts', startLine: 50 })
          .rootCause('Path traversal possible')
          .remediation({ breakingChange: false, summary: 'Validate paths' })
          .confidence(0.6)
          .assumption('Input comes from user request', 'major')
          .assumption('No WAF in place', 'minor', 'Based on scan results')
          .build();

        expect(finding.assumptions).to.have.lengthOf(2);
        expect(finding.assumptions?.[0].impact).to.equal('major');
      });
    });
  });

  describe('enhanced report schema', () => {
    it('validates complete report', () => {
      const report = createValidEnhancedReport();
      const result = enhancedReportSchema.safeParse(report);
      expect(result.success).to.equal(true);
    });

    it('rejects report with invalid summary', () => {
      const report = createValidEnhancedReport();
      report.summary.totalFindings = -1;
      const result = enhancedReportSchema.safeParse(report);
      expect(result.success).to.equal(false);
    });

    it('validateReport returns schema errors for invalid report', () => {
      const report = createValidEnhancedReport();
      report.metadata.runId = '';
      const result = validateReport(report);
      expect(result.valid).to.equal(false);
      expect(result.errors.length).to.be.greaterThan(0);
    });
  });

  describe('enhanced SARIF generation', () => {
    it('generates valid SARIF 2.1.0 structure', () => {
      const sarif = toSarif(generateEnhancedSarifReport(createValidEnhancedReport()));
      expect(sarif.version).to.equal('2.1.0');
      expect(sarif.$schema).to.include('sarif-2.1.0');
      expect(sarif.runs).to.have.lengthOf(1);
    });

    it('includes tool information', () => {
      const run = toSarif(generateEnhancedSarifReport(createValidEnhancedReport())).runs[0];
      expect(run.tool.driver.name).to.equal('shadow-auditor');
      expect(run.tool.driver.version).to.equal('1.0.0');
    });

    it('maps findings to results', () => {
      const run = toSarif(generateEnhancedSarifReport(createValidEnhancedReport())).runs[0];
      expect(run.results).to.have.lengthOf(1);
      expect(run.results[0].ruleId).to.equal('VULN-001');
      expect(run.results[0].level).to.equal('error');
    });

    it('includes location information', () => {
      const result = toSarif(generateEnhancedSarifReport(createValidEnhancedReport())).runs[0].results[0];
      expect(result.locations).to.have.lengthOf(1);
      expect(result.locations[0].physicalLocation.artifactLocation.uri).to.equal('src/db.ts');
      expect(result.locations[0].physicalLocation.region?.startLine).to.equal(42);
    });

    it('creates rules for unique findings', () => {
      const run = toSarif(generateEnhancedSarifReport(createValidEnhancedReport())).runs[0];
      expect(run.tool.driver.rules).to.have.lengthOf(1);
      expect(run.tool.driver.rules[0].id).to.equal('VULN-001');
    });
  });
});
