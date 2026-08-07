import { z } from 'zod';

const MAX_ARTIFACT_LENGTH = 2_000_000;

export const auditStageSchema = z.enum([
  'codebase_intelligence',
  'sast_audit',
  'devils_advocate',
  'reporting',
]);

export type AuditStage = z.infer<typeof auditStageSchema>;

export const codebaseIntelligenceArtifactSchema = z.object({
  repoMap: z.string().min(1).max(MAX_ARTIFACT_LENGTH),
  reportMarkdown: z.string().min(1).max(MAX_ARTIFACT_LENGTH),
});

export type CodebaseIntelligenceArtifact = z.infer<
  typeof codebaseIntelligenceArtifactSchema
>;

function normalizeCandidateLocation(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;

  const location = value as Record<string, unknown>;
  const start = location.start && typeof location.start === 'object'
    ? location.start as Record<string, unknown>
    : undefined;
  let filePath = location.filePath ?? location.path ?? location.file ?? location.filename;
  let lineNumber =
    location.lineNumber ??
    location.startLine ??
    location.line ??
    location.line_number ??
    location.start_line ??
    start?.line;

  if (typeof filePath === 'string' && lineNumber === undefined) {
    const pathWithLine = /^(.*):(\d+)(?::\d+)?$/.exec(filePath.trim());
    if (pathWithLine) {
      filePath = pathWithLine[1];
      lineNumber = pathWithLine[2];
    }
  }

  return {
    ...location,
    filePath,
    lineNumber,
  };
}

const candidateLocationSchema = z.preprocess(normalizeCandidateLocation, z.object({
  filePath: z.string().min(1).max(4000),
  lineNumber: z.preprocess(
    (value) => typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value)
      : value,
    z.number().int().positive(),
  ),
  snippet: z.string().min(1).max(20_000).optional(),
  symbol: z.string().min(1).max(500).optional(),
}));

const candidateDataFlowStepSchema = z.object({
  description: z.string().min(1).max(5000),
  kind: z.preprocess(
    (value) => value === 'transform' ? 'propagation' : value,
    z.enum(['source', 'propagation', 'sanitizer', 'sink']),
  ),
  location: candidateLocationSchema,
});

const proofOfConceptSchema = z.object({
  content: z.string().min(1).max(50_000),
  evidenceArtifactIds: z.array(z.string().uuid()).max(100).default([]),
  executionStatus: z.enum(['not_run', 'verified', 'failed']),
  kind: z.enum(['curl', 'http', 'script', 'payload', 'test']),
  observedResult: z.string().min(1).max(20_000).optional(),
  safetyNotes: z.string().min(1).max(5000),
});

export const sastCandidateSchema = z.object({
  affectedLocations: z.array(candidateLocationSchema).min(1).max(100),
  confidence: z.number().min(0).max(1),
  cwe: z.string().regex(/^CWE-\d+$/),
  evidence: z.array(z.string().min(1)).min(1).max(100),
  findingId: z.string().min(1).max(200),
  impact: z.string().min(1).max(20_000),
  prerequisites: z.array(z.string().min(1).max(5000)).max(50),
  proofOfConcept: proofOfConceptSchema,
  reachability: z.enum(['verified', 'likely', 'unverified']),
  remediation: z.string().min(1).max(20_000),
  reproductionSteps: z.array(z.string().min(1).max(5000)).min(1).max(50),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'informational']),
  sourceToSink: z.array(candidateDataFlowStepSchema).min(2).max(100),
  summary: z.string().min(1).max(20_000),
  title: z.string().min(1).max(500),
});

export type SastCandidate = z.infer<typeof sastCandidateSchema>;

export const sastAuditArtifactSchema = z.object({
  candidates: z.array(sastCandidateSchema).max(1000),
  reportMarkdown: z.string().min(1).max(MAX_ARTIFACT_LENGTH),
});

export type SastAuditArtifact = z.infer<typeof sastAuditArtifactSchema>;

export const adversarialVerdictSchema = z.object({
  adjustedSeverity: z
    .enum(['critical', 'high', 'medium', 'low', 'informational'])
    .optional(),
  evidence: z.array(z.string().min(1)).min(1).max(100),
  findingId: z.string().min(1).max(200),
  rationale: z.string().min(1).max(20_000),
  verdict: z.enum(['CONFIRMED', 'DISMISSED', 'UNVERIFIABLE']),
  verification: z.object({
    evidenceArtifactIds: z.array(z.string().uuid()).max(100).default([]),
    method: z.string().min(1).max(5000),
    observations: z.array(z.string().min(1).max(5000)).min(1).max(100),
    status: z.enum(['verified', 'refuted', 'not_reproduced']),
  }),
}).superRefine((value, context) => {
  if (value.verdict === 'CONFIRMED' && value.verification.status !== 'verified') {
    context.addIssue({
      code: 'custom',
      message: 'A confirmed verdict requires verified reachability or reproduction.',
      path: ['verification', 'status'],
    });
  }

  if (value.verdict === 'DISMISSED' && value.verification.status !== 'refuted') {
    context.addIssue({
      code: 'custom',
      message: 'A dismissed verdict requires refuting evidence.',
      path: ['verification', 'status'],
    });
  }
});

export type AdversarialVerdict = z.infer<typeof adversarialVerdictSchema>;

export const devilsAdvocateArtifactSchema = z.object({
  reportMarkdown: z.string().min(1).max(MAX_ARTIFACT_LENGTH),
  verdicts: z.array(adversarialVerdictSchema).max(1000),
});

export type DevilsAdvocateArtifact = z.infer<
  typeof devilsAdvocateArtifactSchema
>;

function extractTaggedSection(
  text: string,
  tag: string,
  format: 'json' | 'markdown',
): string {
  const expression = new RegExp(
    `<${tag}>\\s*(?:\`\`\`${format}\\s*)?([\\s\\S]*?)(?:\`\`\`\\s*)?</${tag}>`,
    'i',
  );
  const value = expression.exec(text)?.[1]?.trim();
  if (!value) {
    throw new Error(`Stage output is missing a non-empty <${tag}> section.`);
  }

  return value;
}

function parseArtifact<Schema extends z.ZodType>(
  label: string,
  schema: Schema,
  value: unknown,
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const displayedIssues = result.error.issues.slice(0, 8).map((issue) => {
    const location = issue.path.length > 0 ? issue.path.join('.') : 'artifact';
    return `${location}: ${issue.message}`;
  });
  const remaining = result.error.issues.length - displayedIssues.length;
  throw new Error(
    `${label} failed validation: ${displayedIssues.join('; ')}` +
    (remaining > 0 ? `; plus ${remaining} additional issue(s).` : '.'),
  );
}

export function parseCodebaseIntelligenceArtifact(
  text: string,
): CodebaseIntelligenceArtifact {
  return parseArtifact('Codebase Intelligence handoff', codebaseIntelligenceArtifactSchema, {
    repoMap: extractTaggedSection(text, 'repo_map', 'markdown'),
    reportMarkdown: extractTaggedSection(
      text,
      'codebase_report',
      'markdown',
    ),
  });
}

export function parseSastAuditArtifact(text: string): SastAuditArtifact {
  const candidatesText = extractTaggedSection(text, 'sast_candidates_json', 'json');
  let candidates: unknown;
  try {
    candidates = JSON.parse(candidatesText);
  } catch (error) {
    throw new Error(
      `SAST candidates are not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const artifact = parseArtifact('SAST handoff', sastAuditArtifactSchema, {
    candidates,
    reportMarkdown: extractTaggedSection(text, 'sast_report', 'markdown'),
  });
  const duplicateFindingIds = artifact.candidates
    .map((candidate) => candidate.findingId)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateFindingIds.length > 0) {
    throw new Error(
      `SAST returned duplicate candidates for: ${[
        ...new Set(duplicateFindingIds),
      ].join(', ')}.`,
    );
  }

  return artifact;
}

export function parseDevilsAdvocateArtifact(
  text: string,
): DevilsAdvocateArtifact {
  const verdictsText = extractTaggedSection(text, 'verdicts_json', 'json');
  let verdicts: unknown;
  try {
    verdicts = JSON.parse(verdictsText);
  } catch (error) {
    throw new Error(
      `Devil's Advocate verdicts are not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const artifact = parseArtifact("Devil's Advocate handoff", devilsAdvocateArtifactSchema, {
    reportMarkdown: extractTaggedSection(
      text,
      'adversarial_report',
      'markdown',
    ),
    verdicts,
  });
  const duplicateFindingIds = artifact.verdicts
    .map((verdict) => verdict.findingId)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateFindingIds.length > 0) {
    throw new Error(
      `Devil's Advocate returned duplicate verdicts for: ${[
        ...new Set(duplicateFindingIds),
      ].join(', ')}.`,
    );
  }

  return artifact;
}
