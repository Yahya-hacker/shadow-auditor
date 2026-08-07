import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { scoreCvssVector } from './cvss-scorer.js';
import { type SecurityReport, securityReportSchema } from './report-schema.js';

function renderMarkdown(report: SecurityReport): string {
  const lines = ['# Security Audit Report', '', `Findings: **${report.findings.length}**`, ''];
  for (const finding of report.findings) {
    const safeTitle = finding.title.replaceAll(/[\r\n]+/g, ' ');
    lines.push(
      `## ${finding.vuln_id}: ${safeTitle}`,
      '',
      `- Severity: ${finding.severity_label}`,
      `- CVSS 3.1: ${finding.cvss_v31_score} (\`${finding.cvss_v31_vector}\`)`,
      `- CWE: ${finding.cwe}`,
      '- Files:',
      ...finding.file_paths.map((filePath) => `  - \`${filePath.replaceAll('`', '\\`')}\``),
      '',
    );
  }

  return `${lines.join('\n')}\n`;
}

export async function validateLocalReport(
  input: SecurityReport,
  repositoryPath: string,
): Promise<{ markdown: string; report: SecurityReport }> {
  const report = securityReportSchema.parse(input);
  const root = await fs.realpath(path.resolve(repositoryPath));
  for (const finding of report.findings) {
    const computed = scoreCvssVector(finding.cvss_v31_vector);
    if (
      !computed ||
      computed.baseScore !== finding.cvss_v31_score ||
      computed.severityLabel !== finding.severity_label
    ) {
      throw new Error(`Finding ${finding.vuln_id} has inconsistent CVSS vector, score, or severity`);
    }

    for (const filePath of finding.file_paths) {
      const resolved = await fs.realpath(path.resolve(root, filePath));
      const relative = path.relative(root, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Finding ${finding.vuln_id} references a file outside the repository`);
      }

      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        throw new Error(`Finding ${finding.vuln_id} evidence path is not a file: ${filePath}`);
      }
    }
  }

  return { markdown: renderMarkdown(report), report };
}
