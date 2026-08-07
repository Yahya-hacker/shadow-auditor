import type { Problem } from './generated.js';

export class ProtocolError extends Error {
  constructor(
    readonly problem: Problem,
    options?: ErrorOptions,
  ) {
    super(problem.detail, options);
    this.name = 'ProtocolError';
  }
}

export function problem(options: {
  code: string;
  detail: string;
  instance?: string;
  status: number;
  title: string;
}): Problem {
  return {
    code: options.code,
    detail: options.detail,
    instance: options.instance,
    retryable: false,
    status: options.status,
    title: options.title,
    type: `urn:shadow-auditor:problem:${options.code.toLowerCase()}`,
  };
}
