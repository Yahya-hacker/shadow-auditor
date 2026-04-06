import type { SecurityFinding, SecurityReport } from './report-schema.js';

type SarifLevel = 'error' | 'note' | 'warning';

function toSarifLevel(severity: SecurityFinding['severity_label']): SarifLevel {
  switch (severity) {
    case 'Critical':
    case 'High': {
      return 'error';
    }

    case 'Medium': {
      return 'warning';
    }

    case 'Low':
    case 'Info':
    default: {
      return 'note';
    }
  }
}

function toPosixPath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function findingMessage(finding: SecurityFinding): string {
  return `${finding.title} (${finding.cwe}, CVSS 3.1: ${finding.cvss_v31_score})`;
}

export function generateSarifReport(report: SecurityReport): Record<string, unknown> {
  const sortedFindings = [...report.findings].sort((a, b) => a.vuln_id.localeCompare(b.vuln_id));
  const uniqueRules = new Map<string, SecurityFinding>();

  for (const finding of sortedFindings) {
    if (!uniqueRules.has(finding.vuln_id)) {
      uniqueRules.set(finding.vuln_id, finding);
    }
  }

  const rules = [...uniqueRules.values()].map((finding) => ({
    id: finding.vuln_id,
    name: finding.title,
    shortDescription: {
      text: finding.title,
    },
  }));

  const results = sortedFindings.map((finding) => ({
    level: toSarifLevel(finding.severity_label),
    locations: finding.file_paths.map((filePath) => ({
      physicalLocation: {
        artifactLocation: {
          uri: toPosixPath(filePath),
        },
      },
    })),
    message: {
      text: findingMessage(finding),
    },
    ruleId: finding.vuln_id,
  }));

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        results,
        tool: {
          driver: {
            informationUri: 'https://github.com/Yahya-hacker/shadow-auditor',
            name: 'shadow-auditor',
            rules,
            version: '1.0.0',
          },
        },
      },
    ],
    version: '2.1.0',
  };
}
