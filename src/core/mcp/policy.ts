/**
 * @deprecated This module has been unified into `src/core/policy/mcp-policy.ts`.
 *
 * This file re-exports the compatibility bridge for backward compatibility.
 * New code should import directly from `../policy/mcp-policy.js`.
 */
export { evaluateMcpPolicy, type MCPPolicyDecision } from '../policy/mcp-policy.js';
