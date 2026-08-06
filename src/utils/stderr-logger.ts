/**
 * Writes a diagnostic message to stderr with the [ShadowAuditor] prefix.
 * Used project-wide to avoid corrupting the TUI's stdout rendering.
 */
export function logToStderr(message: string): void {
  process.stderr.write(`[ShadowAuditor] ${message}\n`);
}
