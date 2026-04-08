import type { EnhancedFinding, EnhancedReport } from './finding-schema.js';
import type { SecurityFinding, SecurityReport } from './report-schema.js';

type SarifLevel = 'error' | 'note' | 'warning';

function toSarifLevel(severity: EnhancedFinding['severityLabel'] | SecurityFinding['severity_label']): SarifLevel {
  switch (severity) {
    case 'Critical':
    case 'High': {
      return 'error';
    }

    case 'Medium': {
      return 'warning';
    }

    case 'Info':
    case 'Low':
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

function enhancedFindingMessage(finding: EnhancedFinding): string {
  return `${finding.title} (${finding.cwe}, CVSS 3.1: ${finding.cvssV31Score}, Confidence: ${(finding.confidence * 100).toFixed(0)}%)`;
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

/**
 * Generate SARIF 2.1.0 report from enhanced report format.
 */
export function generateEnhancedSarifReport(report: EnhancedReport): Record<string, unknown> {
  const sortedFindings = [...report.findings].sort((a, b) => a.vulnId.localeCompare(b.vulnId));
  const uniqueRules = new Map<string, EnhancedFinding>();

  for (const finding of sortedFindings) {
    if (!uniqueRules.has(finding.vulnId)) {
      uniqueRules.set(finding.vulnId, finding);
    }
  }

  const rules = [...uniqueRules.values()].map((finding) => ({
    defaultConfiguration: {
      level: toSarifLevel(finding.severityLabel),
    },
    fullDescription: finding.description ? {
      text: finding.description,
    } : undefined,
    help: {
      markdown: finding.remediation.codeExample
        ? `${finding.remediation.summary}\n\n\`\`\`\n${finding.remediation.codeExample}\n\`\`\``
        : finding.remediation.summary,
      text: finding.remediation.summary,
    },
    id: finding.vulnId,
    name: finding.title,
    properties: {
      'security-severity': finding.cvssV31Score.toString(),
      tags: [
        'security',
        finding.cwe,
        ...(finding.tags ?? []),
      ],
    },
    relationships: finding.additionalCwes?.map((cwe) => ({
      kinds: ['relevant'],
      target: {
        id: cwe,
        toolComponent: {
          name: 'CWE',
        },
      },
    })),
    shortDescription: {
      text: finding.title,
    },
  }));

  const results = sortedFindings.map((finding) => {
    const result: Record<string, unknown> = {
      level: toSarifLevel(finding.severityLabel),
      locations: finding.locations.map((loc) => ({
        logicalLocations: loc.functionName || loc.className ? [
          {
            fullyQualifiedName: loc.className 
              ? `${loc.className}.${loc.functionName ?? ''}`
              : loc.functionName,
            kind: loc.className ? 'member' : 'function',
            name: loc.functionName,
          },
        ] : undefined,
        physicalLocation: {
          artifactLocation: {
            uri: toPosixPath(loc.filePath),
          },
          region: loc.startLine ? {
            endColumn: loc.endColumn,
            endLine: loc.endLine ?? loc.startLine,
            snippet: loc.snippet ? {
              text: loc.snippet,
            } : undefined,
            startColumn: loc.startColumn,
            startLine: loc.startLine,
          } : undefined,
        },
      })),
      message: {
        text: enhancedFindingMessage(finding),
      },
      partialFingerprints: {
        'primaryLocationLineHash': finding.locations[0]?.snippetHash,
      },
      properties: {
        attackerPersonas: finding.attackerPersonas,
        confidence: finding.confidence,
        exploitability: finding.exploitability,
        rootCause: finding.rootCause,
      },
      ruleId: finding.vulnId,
    };

    // Add data flow (codeFlows) if present
    if (finding.dataFlowPath && finding.dataFlowPath.length > 0) {
      result.codeFlows = [{
        threadFlows: [{
          locations: finding.dataFlowPath.map((step, index) => ({
            executionOrder: index + 1,
            kinds: [
              ...(step.isSource ? ['source'] : []),
              ...(step.isSink ? ['sink'] : []),
              ...(step.isSanitizer ? ['sanitizer'] : []),
            ].filter(Boolean),
            location: {
              message: {
                text: step.description,
              },
              physicalLocation: {
                artifactLocation: {
                  uri: toPosixPath(step.location.filePath),
                },
                region: step.location.startLine ? {
                  endLine: step.location.endLine ?? step.location.startLine,
                  startLine: step.location.startLine,
                } : undefined,
              },
            },
            nestingLevel: 0,
          })),
        }],
      }];
    }

    // Add related locations
    if (finding.evidenceRefs && finding.evidenceRefs.length > 0) {
      result.relatedLocations = finding.evidenceRefs
        .filter((ref) => ref.filePath)
        .map((ref, index) => ({
          id: index,
          message: {
            text: `Evidence: ${ref.type}`,
          },
          physicalLocation: {
            artifactLocation: {
              uri: toPosixPath(ref.filePath!),
            },
            region: ref.lineNumber ? {
              startLine: ref.lineNumber,
            } : undefined,
          },
        }));
    }

    // Add fixes if code example provided
    if (finding.remediation.codeExample) {
      result.fixes = [{
        description: {
          text: finding.remediation.summary,
        },
        // Note: SARIF fixes require specific replacements, simplified here
      }];
    }

    return result;
  });

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        invocations: [{
          endTimeUtc: report.metadata.generatedAt,
          executionSuccessful: true,
          startTimeUtc: report.metadata.generatedAt,
        }],
        properties: {
          runId: report.metadata.runId,
          summary: report.summary,
        },
        results,
        tool: {
          driver: {
            informationUri: 'https://github.com/Yahya-hacker/shadow-auditor',
            name: 'shadow-auditor',
            rules,
            version: report.metadata.toolVersion,
          },
        },
        versionControlProvenance: report.metadata.commitSha ? [{
          branch: report.metadata.branch,
          repositoryUri: `https://github.com/${report.metadata.targetName ?? 'unknown'}`,
          revisionId: report.metadata.commitSha,
        }] : undefined,
      },
    ],
    version: '2.1.0',
  };
}
