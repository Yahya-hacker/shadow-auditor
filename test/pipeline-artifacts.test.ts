import { expect } from 'chai';

import {
  parseDevilsAdvocateArtifact,
  parseSastAuditArtifact,
} from '../src/core/graph/pipeline-artifacts.js';

const candidate = {
  affectedLocations: [{filePath: 'src/route.ts', lineNumber: 12}],
  confidence: 0.9,
  cwe: 'CWE-22',
  evidence: ['src/route.ts:12 request path reaches readFile'],
  findingId: 'CAND-001',
  impact: 'An unauthenticated caller can read files outside the intended root.',
  prerequisites: ['The route is externally reachable.'],
  proofOfConcept: {
    content: '../safe-fixture',
    executionStatus: 'not_run',
    kind: 'payload',
    safetyNotes: 'References a local non-sensitive fixture only.',
  },
  reachability: 'likely',
  remediation: 'Resolve the path and reject values outside the trusted root.',
  reproductionSteps: ['Send the safe traversal payload to the route.'],
  severity: 'high',
  sourceToSink: [
    {
      description: 'Attacker-controlled route parameter',
      kind: 'source',
      location: {filePath: 'src/route.ts', lineNumber: 12},
    },
    {
      description: 'Path decoding transformation',
      kind: 'transform',
      location: {filePath: 'src/route.ts', lineNumber: 13},
    },
    {
      description: 'Unconstrained file read',
      kind: 'sink',
      location: {filePath: 'src/storage.ts', lineNumber: 40},
    },
  ],
  summary: 'An untrusted path reaches a file-read sink without root confinement.',
  title: 'Path traversal in download route',
};

describe('pipeline artifact contracts', () => {
  it('preserves evidence needed for source-to-sink and PoC reporting', () => {
    const artifact = parseSastAuditArtifact(
      `<sast_report>Candidate report</sast_report>` +
      `<sast_candidates_json>${JSON.stringify([candidate])}</sast_candidates_json>`,
    );

    expect(artifact.candidates[0]?.sourceToSink.map((step) => step.kind))
      .to.deep.equal(['source', 'propagation', 'sink']);
    expect(artifact.candidates[0]?.proofOfConcept.executionStatus).to.equal('not_run');
  });

  it('normalizes common provider location aliases without weakening line provenance', () => {
    const providerCandidate = {
      ...candidate,
      affectedLocations: [
        {path: 'src/route.ts', startLine: 12},
        {file: 'src/storage.ts:40'},
      ],
      sourceToSink: [
        {
          description: 'Attacker-controlled route parameter',
          kind: 'source',
          location: {filePath: 'src/route.ts', line: '12'},
        },
        {
          description: 'Unconstrained file read',
          kind: 'sink',
          location: {filename: 'src/storage.ts', start: {line: 40}},
        },
      ],
    };
    const artifact = parseSastAuditArtifact(
      `<sast_report>Candidate report</sast_report>` +
      `<sast_candidates_json>${JSON.stringify([providerCandidate])}</sast_candidates_json>`,
    );

    expect(artifact.candidates[0]?.affectedLocations[0]).to.deep.equal({
      filePath: 'src/route.ts',
      lineNumber: 12,
    });
    expect(artifact.candidates[0]?.affectedLocations[1]).to.include({
      filePath: 'src/storage.ts',
      lineNumber: 40,
    });
    expect(artifact.candidates[0]?.sourceToSink.map((step) => step.location.lineNumber))
      .to.deep.equal([12, 40]);
  });

  it('still rejects locations that contain no verifiable line', () => {
    const providerCandidate = {
      ...candidate,
      affectedLocations: [{filePath: 'src/route.ts'}],
    };

    expect(() => parseSastAuditArtifact(
      `<sast_report>Candidate report</sast_report>` +
      `<sast_candidates_json>${JSON.stringify([providerCandidate])}</sast_candidates_json>`,
    )).to.throw(
      'SAST handoff failed validation: candidates.0.affectedLocations.0.lineNumber',
    );
  });

  it('rejects confirmation without verified reachability or reproduction', () => {
    const verdicts = [{
      evidence: ['src/route.ts:12'],
      findingId: 'CAND-001',
      rationale: 'Static evidence exists but reproduction was not completed.',
      verdict: 'CONFIRMED',
      verification: {
        method: 'Static inspection',
        observations: ['The runtime configuration remains unknown.'],
        status: 'not_reproduced',
      },
    }];

    expect(() => parseDevilsAdvocateArtifact(
      `<adversarial_report>Validation report</adversarial_report>` +
      `<verdicts_json>${JSON.stringify(verdicts)}</verdicts_json>`,
    )).to.throw('A confirmed verdict requires verified reachability or reproduction');
  });
});
