import { type SecurityReport, securityReportSchema } from './report-schema.js';

export interface RepairContext {
  attempt: number;
  lastCandidate: null | string;
  validationError: string;
}

export interface ValidateAndRepairOptions {
  maxRetries?: number;
  repair?: (context: RepairContext) => Promise<string>;
  responseText: string;
}

export interface ValidateAndRepairResult {
  attempts: number;
  jsonText: string;
  repaired: boolean;
  report: SecurityReport;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function extractJsonBlock(text: string): null | string {
  const fencedRegex = /```(?:json)?\s*([\s\S]*?)```/giu;
  const fencedBlocks = [...text.matchAll(fencedRegex)];

  for (const block of fencedBlocks) {
    const candidate = block[1].trim();
    if (candidate.includes('"findings"')) {
      return candidate;
    }
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }

  return null;
}

function validateCandidate(candidate: null | string): {
  error?: string;
  report?: SecurityReport;
} {
  if (!candidate) {
    return {
      error: 'No JSON block found in model output.',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return {
      error: `Invalid JSON: ${stringifyError(error)}`,
    };
  }

  const validation = securityReportSchema.safeParse(parsed);
  if (!validation.success) {
    return {
      error: validation.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; '),
    };
  }

  return { report: validation.data };
}

export async function validateAndRepairReport({
  maxRetries = 2,
  repair,
  responseText,
}: ValidateAndRepairOptions): Promise<ValidateAndRepairResult> {
  let candidate = extractJsonBlock(responseText);

  // At most (maxRetries + 1) total attempts: the initial parse plus up to
  // maxRetries repair rounds. The loop condition is explicit rather than
  // while(true) so the bound is visible at the declaration site.
  const maxTotalAttempts = maxRetries + 1;
  for (let attempt = 0; attempt < maxTotalAttempts; attempt++) {
    const validation = validateCandidate(candidate);
    if (validation.report) {
      return {
        attempts: attempt,
        jsonText: candidate ?? JSON.stringify(validation.report),
        repaired: attempt > 0,
        report: validation.report,
      };
    }

    // No repair function or we're on the last allowed attempt — fail fast.
    if (!repair || attempt >= maxRetries) {
      throw new Error(`Unable to validate report JSON. ${validation.error ?? 'Unknown validation failure.'}`);
    }

    const repairedOutput = await repair({
      attempt: attempt + 1,
      lastCandidate: candidate,
      validationError: validation.error ?? 'Unknown validation failure.',
    });

    candidate = extractJsonBlock(repairedOutput) ?? repairedOutput.trim();
  }

  // Should be unreachable (the loop always throws or returns), but the
  // exhaustive check satisfies TypeScript's control-flow analysis.
  throw new Error('Report validation exceeded maximum repair attempts.');
}
