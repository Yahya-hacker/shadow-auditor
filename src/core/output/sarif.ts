import type {
  ArtifactChange,
  Invocation,
  ReportingConfiguration,
  ReportingDescriptor,
  Log as SarifLog,
  Result as SarifResult,
  VersionControlDetails,
} from 'sarif';

import type { EnhancedFinding, EnhancedReport } from './finding-schema.js';
import type { SecurityFinding, SecurityReport } from './report-schema.js';

type SarifLevel = 'error' | 'none' | 'note' | 'warning';

function toSarifLevel(severity: EnhancedFinding['severityLabel'] | SecurityFinding['severity_label']): SarifLevel {
  switch (severity) {
    case 'Critical':
    case 'High': {
      return 'error';
    }

    case 'Low': {
      return 'note';
    }

    case 'Medium': {
      return 'warning';
    }

    case 'Info':
    default: {
      return 'none';
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

export function generateSarifReport(report: SecurityReport): SarifLog {
  const sortedFindings = [...report.findings].sort((a, b) => a.vuln_id.localeCompare(b.vuln_id));
  const uniqueRules = new Map<string, SecurityFinding>();

  for (const finding of sortedFindings) {
    if (!uniqueRules.has(finding.vuln_id)) {
      uniqueRules.set(finding.vuln_id, finding);
    }
  }

  const rules: ReportingDescriptor[] = [...uniqueRules.values()].map((finding) => ({
    defaultConfiguration: {
      level: toSarifLevel(finding.severity_label),
    },
    id: finding.vuln_id,
    name: finding.title,
    shortDescription: {
      text: finding.title,
    },
  }));

  const results: SarifResult[] = sortedFindings.map((finding) => ({
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
export function generateEnhancedSarifReport(report: EnhancedReport): SarifLog {
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

  const results: SarifResult[] = sortedFindings.map((finding) => {
    const result: SarifResult = {
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
      partialFingerprints: finding.locations[0]?.snippetHash
        ? { primaryLocationLineHash: finding.locations[0].snippetHash }
        : undefined,
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

    // Add fixes if code example provided and we have enough info
    // to produce a valid SARIF artifactChange. The `replacements`
    // array MUST be non-empty per SARIF spec §3.55.3 — an empty
    // array is semantically meaningless and rejected by SARIF
    // consumers. We construct a single `replacement` from the
    // code example as a best-effort deletion region covering the
    // primary finding location's line range, then insert the
    // remediated code.
    if (finding.remediation.codeExample && finding.locations[0]?.filePath) {
      const primaryLoc = finding.locations[0];
      const primaryFile = primaryLoc.filePath;
      const replacementRegion = primaryLoc.startLine ? {
        byteLength: 0,
        byteOffset: 0,
        charLength: 0,
        charOffset: 0,
        endColumn: primaryLoc.endColumn ?? 0,
        endLine: primaryLoc.endLine ?? primaryLoc.startLine,
        startColumn: primaryLoc.startColumn ?? 1,
        startLine: primaryLoc.startLine,
      } : undefined;

      const replacement = {
        deletedRegion: replacementRegion ?? {
          byteLength: 0,
          byteOffset: 0,
          charLength: 0,
          charOffset: 0,
          endColumn: 0,
          endLine: 0,
          startColumn: 1,
          startLine: 1,
        },
        insertedContent: {
          text: finding.remediation.codeExample,
        },
      };

      result.fixes = [{
        artifactChanges: [{
          artifactLocation: {
            uri: toPosixPath(primaryFile),
          },
          replacements: [replacement],
        }],
        description: {
          text: finding.remediation.summary,
        },
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
          // Compute startTimeUtc defensively: it MUST be before endTimeUtc
          // per SARIF spec §3.13.3. Fall back to 1s before endTime if
          // durationMs is missing, zero, or negative.
          startTimeUtc: computeSafeStartTime(
            report.metadata.generatedAt,
            report.metadata.durationMs,
          ),
        }],
        properties: {
          runId: report.metadata.runId,
          summary: report.summary,
        },
        results,
        tool: {
          driver: {
            fullName: 'Shadow Auditor — AI-Native SAST',
            informationUri: 'https://github.com/Yahya-hacker/shadow-auditor',
            name: 'shadow-auditor',
            organization: 'Shadow Auditor',
            rules,
            semanticVersion: report.metadata.toolVersion,
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

// =============================================================================
// Helpers
// =============================================================================

/**
 * Compute a safe startTimeUtc that is always strictly before endTimeUtc.
 * Per SARIF spec §3.13.3, startTimeUtc MUST precede endTimeUtc.
 *
 * Guards against NaN from malformed ISO 8601 inputs — if Date.parse fails,
 * endMs is NaN and all arithmetic cascades to 0 (epoch). We defensively
 * fall back to one second before the current time so the result is always
 * a valid ISO 8601 timestamp where startTime < endTime.
 */
function computeSafeStartTime(
  endTimeIso: string,
  durationMs?: number,
): string {
  const endMs = new Date(endTimeIso).getTime();
  if (Number.isNaN(endMs)) {
    // Defensive fallback: use current time as endTime
    const now = Date.now();
    return new Date(now - 1000).toISOString();
  }
  if (durationMs != null && durationMs > 0) {
    const startMs = Math.max(0, endMs - durationMs);
    // Ensure startTime is strictly before endTime (minimum 1ms gap)
    if (startMs >= endMs) {
      return new Date(endMs - 1000).toISOString();
    }
    return new Date(startMs).toISOString();
  }
  // Fallback: assume at least 1 second before endTime
  return new Date(Math.max(0, endMs - 1000)).toISOString();
}
