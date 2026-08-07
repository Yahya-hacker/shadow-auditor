import type { TestResult } from './test-runner.js';

export type PatchReviewDecision =
  | { action: 'apply' }
  | { action: 'reject' }
  | { action: 'revise'; instructions: string };

export interface PatchReviewRequest {
  diff: string;
  findingId: string;
  testResult: TestResult;
}
