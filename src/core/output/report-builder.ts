/**
 * Report Builder - Comprehensive report generation pipeline.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { VerificationGates, VerificationResult } from '../verify/gates.js';

import { SCHEMA_VERSION } from '../schema/base.js';
import {
  type EnhancedFinding,
  enhancedFindingSchema,
  type EnhancedReport,
  enhancedReportSchema,
  type ReportMetadata,
  type ReportSummary,
} from './finding-schema.js';
import { generateEnhancedSarifReport } from './sarif.js';

// =============================================================================
// Report Builder
// =============================================================================

export interface ReportBuilderOptions {
  /** Branch name */
  branch?: string;
  
  /** Commit SHA */
  commitSha?: string;
  
  /** Whether to generate JSON report */
  generateJson?: boolean;
  
  /** Whether to generate markdown report */
  generateMarkdown?: boolean;
  
  /** Whether to generate SARIF report */
  generateSarif?: boolean;
  
  /** Output directory */
  outputDir: string;
  
  /** Run ID */
  runId: string;
  
  /** Scan mode */
  scanMode?: string;
  
  /** Target name (repository/project) */
  targetName?: string;
  
  /** Tool version */
  toolVersion?: string;
  
  /** Verification gates for validation */
  verificationGates?: VerificationGates;
}

/**
 * Builds comprehensive security reports.
 */
export class ReportBuilder {
  private filesAnalyzed = 0;
  private filesTotal = 0;
  private readonly findings: EnhancedFinding[] = [];
  private readonly options: Required<ReportBuilderOptions>;
  private readonly rejectedFindings: Array<{
    finding: Partial<EnhancedFinding>;
    reason: string;
    verification?: VerificationResult;
  }> = [];
  private startTime: number = Date.now();
  
  constructor(options: ReportBuilderOptions) {
    this.options = {
      branch: undefined,
      commitSha: undefined,
      generateJson: true,
      generateMarkdown: true,
      generateSarif: true,
      scanMode: undefined,
      targetName: 'unknown',
      toolVersion: '1.0.0',
      verificationGates: undefined,
      ...options,
    } as Required<ReportBuilderOptions>;
  }
  
  /**
   * Add a finding with optional verification.
   */
  addFinding(finding: EnhancedFinding): { added: boolean; reason?: string } {
    // Validate schema
    const parseResult = enhancedFindingSchema.safeParse(finding);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((i) => i.message).join('; ');
      this.rejectedFindings.push({ finding, reason: `Schema validation failed: ${errors}` });
      return { added: false, reason: `Schema validation failed: ${errors}` };
    }
    
    const validFinding = parseResult.data;
    
    // Verify through gates if available
    if (this.options.verificationGates) {
      const verification = this.options.verificationGates.verify({
        assumptions: validFinding.assumptions?.map((a) => a.statement),
        cwe: validFinding.cwe,
        entityIds: validFinding.evidenceRefs
          ?.map((e) => e.entityId)
          .filter((id): id is string => typeof id === 'string'),
        sinkId: validFinding.dataFlowPath?.find((s) => s.isSink)?.location.filePath,
        sourceId: validFinding.dataFlowPath?.find((s) => s.isSource)?.location.filePath,
        title: validFinding.title,
        toolRunRefs: validFinding.toolRunRefs?.map((t) => ({
          timestamp: t.timestamp,
          toolCallId: t.toolRunId,
          toolName: t.toolName,
          truncated: t.truncated,
        })),
      });
      
      if (!verification.canEmit) {
        this.rejectedFindings.push({
          finding,
          reason: `Failed gates: ${verification.failedGates.join(', ')}`,
          verification,
        });
        return { added: false, reason: `Failed verification gates: ${verification.failedGates.join(', ')}` };
      }
      
      // Update confidence from verification
      validFinding.confidence = verification.confidence;
    }
    
    // Check for duplicates
    const existing = this.findings.find((f) => f.vulnId === validFinding.vulnId);
    if (existing) {
      this.rejectedFindings.push({ finding, reason: 'Duplicate vulnId' });
      return { added: false, reason: 'Duplicate finding' };
    }
    
    this.findings.push(validFinding);
    return { added: true };
  }
  
  /**
   * Build the complete report.
   */
  build(): EnhancedReport {
    const now = new Date();
    const duration = Date.now() - this.startTime;
    
    const metadata: ReportMetadata = {
      branch: this.options.branch,
      commitSha: this.options.commitSha,
      coverage: {
        filesAnalyzed: this.filesAnalyzed,
        filesTotal: this.filesTotal,
        percentComplete: this.filesTotal > 0 
          ? Math.round((this.filesAnalyzed / this.filesTotal) * 100)
          : 100,
      },
      durationMs: duration,
      generatedAt: now.toISOString(),
      reportId: this.generateReportId(),
      runId: this.options.runId,
      scanMode: this.options.scanMode,
      schemaVersion: SCHEMA_VERSION,
      targetName: this.options.targetName,
      toolVersion: this.options.toolVersion,
    };
    
    const summary = this.computeSummary();
    
    // Sort findings by severity, then confidence
    const sortedFindings = [...this.findings].sort((a, b) => {
      const severityOrder = { Critical: 0, High: 1, Info: 4, Low: 3, Medium: 2 };
      const aSev = severityOrder[a.severityLabel];
      const bSev = severityOrder[b.severityLabel];
      
      if (aSev !== bSev) return aSev - bSev;
      return b.confidence - a.confidence;
    });
    
    return {
      findings: sortedFindings,
      metadata,
      schemaVersion: SCHEMA_VERSION,
      summary,
    };
  }
  
  /**
   * Generate all report outputs.
   */
  async generate(): Promise<{
    jsonPath?: string;
    markdownPath?: string;
    report: EnhancedReport;
    sarifPath?: string;
  }> {
    const report = this.build();
    const result: Awaited<ReturnType<typeof this.generate>> = { report };
    
    // Ensure output directory exists
    await fs.mkdir(this.options.outputDir, { recursive: true });
    
    // Generate JSON report
    if (this.options.generateJson) {
      const jsonPath = path.join(this.options.outputDir, 'report.json');
      await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
      result.jsonPath = jsonPath;
    }
    
    // Generate SARIF report
    if (this.options.generateSarif) {
      const sarif = generateEnhancedSarifReport(report);
      const sarifPath = path.join(this.options.outputDir, 'report.sarif');
      await fs.writeFile(sarifPath, JSON.stringify(sarif, null, 2), 'utf-8');
      result.sarifPath = sarifPath;
    }
    
    // Generate Markdown report
    if (this.options.generateMarkdown) {
      const markdown = this.generateMarkdown(report);
      const mdPath = path.join(this.options.outputDir, 'report.md');
      await fs.writeFile(mdPath, markdown, 'utf-8');
      result.markdownPath = mdPath;
    }
    
    return result;
  }
  
  /**
   * Get rejected findings for review.
   */
  getRejectedFindings(): typeof this.rejectedFindings {
    return [...this.rejectedFindings];
  }
  
  /**
   * Set coverage statistics.
   */
  setCoverage(analyzed: number, total?: number): this {
    this.filesAnalyzed = analyzed;
    this.filesTotal = total ?? analyzed;
    return this;
  }
  
  /**
   * Set analysis start time.
   */
  setStartTime(time: number): this {
    this.startTime = time;
    return this;
  }
  
  // ===========================================================================
  // Private Methods
  // ===========================================================================
  
  private computeSummary(): ReportSummary {
    const bySeverity = {
      critical: 0,
      high: 0,
      info: 0,
      low: 0,
      medium: 0,
    };
    
    const byConfidence = {
      high: 0,
      low: 0,
      medium: 0,
    };
    
    const cweCount = new Map<string, number>();
    let totalRisk = 0;
    
    for (const finding of this.findings) {
      // By severity
      switch (finding.severityLabel) {
        case 'Critical': { bySeverity.critical++; break;
        }

        case 'High': { bySeverity.high++; break;
        }

        case 'Info': { bySeverity.info++; break;
        }

        case 'Low': { bySeverity.low++; break;
        }

        case 'Medium': { bySeverity.medium++; break;
        }
      }
      
      // By confidence
      if (finding.confidence >= 0.8) {
        byConfidence.high++;
      } else if (finding.confidence >= 0.5) {
        byConfidence.medium++;
      } else {
        byConfidence.low++;
      }
      
      // CWE count
      cweCount.set(finding.cwe, (cweCount.get(finding.cwe) ?? 0) + 1);
      
      // Risk score contribution
      const severityMultiplier = {
        Critical: 10,
        High: 7,
        Info: 0.5,
        Low: 2,
        Medium: 4,
      }[finding.severityLabel];
      
      totalRisk += finding.cvssV31Score * severityMultiplier * finding.confidence;
    }
    
    // Top CWEs
    const topCwes = Array.from(cweCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cwe, count]) => ({ count, cwe }));
    
    // Normalize risk score to 0-100
    const maxPossibleRisk = this.findings.length * 10 * 10 * 1; // max CVSS * max multiplier * max confidence
    const riskScore = maxPossibleRisk > 0 
      ? Math.min(100, Math.round((totalRisk / maxPossibleRisk) * 100))
      : 0;
    
    return {
      byConfidence,
      bySeverity,
      riskScore,
      topCwes: topCwes.length > 0 ? topCwes : undefined,
      totalFindings: this.findings.length,
    };
  }
  
  // eslint-disable-next-line complexity
  private generateMarkdown(report: EnhancedReport): string {
    const lines: string[] = [];
    
    // Header
    lines.push('# Security Audit Report', '', `**Generated:** ${report.metadata.generatedAt}`, `**Target:** ${report.metadata.targetName ?? 'Unknown'}`);
    if (report.metadata.commitSha) {
      lines.push(`**Commit:** ${report.metadata.commitSha}`);
    }

    if (report.metadata.branch) {
      lines.push(`**Branch:** ${report.metadata.branch}`);
    }

    lines.push(`**Tool Version:** ${report.metadata.toolVersion}`, '', '## Executive Summary', '', `Total findings: **${report.summary.totalFindings}**`, '', '| Severity | Count |', '|----------|-------|', `| Critical | ${report.summary.bySeverity.critical} |`, `| High | ${report.summary.bySeverity.high} |`, `| Medium | ${report.summary.bySeverity.medium} |`, `| Low | ${report.summary.bySeverity.low} |`, `| Info | ${report.summary.bySeverity.info} |`, '');
    
    if (report.summary.riskScore !== undefined) {
      lines.push(`**Overall Risk Score:** ${report.summary.riskScore}/100`, '');
    }
    
    if (report.summary.topCwes && report.summary.topCwes.length > 0) {
      lines.push('### Top Weakness Categories', '');
      for (const { count, cwe } of report.summary.topCwes) {
        lines.push(`- ${cwe}: ${count} finding(s)`);
      }

      lines.push('');
    }
    
    // Findings
    if (report.findings.length > 0) {
      lines.push('## Findings', '');
      
      for (const finding of report.findings) {
        lines.push(
          `### ${finding.vulnId}: ${finding.title}`,
          '',
          `**Severity:** ${finding.severityLabel} (CVSS ${finding.cvssV31Score})`,
          `**CWE:** ${finding.cwe}`,
          `**Confidence:** ${(finding.confidence * 100).toFixed(0)}%`,
          '',
        );
        
        if (finding.description) {
          lines.push(finding.description, '');
        }
        
        lines.push('#### Affected Locations', '');
        for (const loc of finding.locations) {
          const lineInfo = loc.startLine ? `:${loc.startLine}` : '';
          lines.push(`- \`${loc.filePath}${lineInfo}\``);
          if (loc.snippet) {
            lines.push('  ```', `  ${loc.snippet}`, '  ```');
          }
        }

        lines.push('');
        
        if (finding.dataFlowPath && finding.dataFlowPath.length > 0) {
          lines.push('#### Data Flow', '');
          for (const step of finding.dataFlowPath) {
            const marker = step.isSource ? '📥 SOURCE' : step.isSink ? '📤 SINK' : step.isSanitizer ? '🛡️ SANITIZER' : '→';
            lines.push(`${marker} \`${step.location.filePath}:${step.location.startLine}\`: ${step.description}`);
          }

          lines.push('');
        }
        
        lines.push('#### Root Cause', '', finding.rootCause, '');
        
        if (finding.exploitPathSummary) {
          lines.push('#### Exploit Path', '', finding.exploitPathSummary, '');
        }
        
        lines.push('#### Remediation', '', finding.remediation.summary);
        if (finding.remediation.steps && finding.remediation.steps.length > 0) {
          lines.push('', '**Steps:**');
          for (const step of finding.remediation.steps) {
            lines.push(`1. ${step}`);
          }
        }

        if (finding.remediation.codeExample) {
          lines.push('', '**Example:**', '```', finding.remediation.codeExample, '```');
        }

        lines.push('');
        
        if (finding.assumptions && finding.assumptions.length > 0) {
          lines.push('#### Assumptions', '');
          for (const assumption of finding.assumptions) {
            lines.push(`- ⚠️ [${assumption.impact.toUpperCase()}] ${assumption.statement}`);
          }

          lines.push('');
        }
        
        lines.push('---', '');
      }
    } else {
      lines.push('## Findings', '', 'No security findings identified.', '');
    }
    
    // Footer
    lines.push('---', `*Report generated by Shadow Auditor v${report.metadata.toolVersion}*`);
    
    return lines.join('\n');
  }
  
  private generateReportId(): string {
    const content = JSON.stringify({
      commitSha: this.options.commitSha,
      runId: this.options.runId,
      targetName: this.options.targetName,
      timestamp: Date.now(),
    });
    
    return `report-${crypto.createHash('sha256').update(content).digest('hex').slice(0, 12)}`;
  }
}
