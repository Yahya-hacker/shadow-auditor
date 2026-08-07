const DEFAULT_COMMAND = 'shell';
const EXPLICIT_COMMANDS = new Set(['help', 'shell']);
const ROOT_FLAGS = new Set(['--version']);

export function routeDefaultCommand(argv: string[]): string[] {
  const routed = [...argv];
  if (routed[2] === '-v') routed[2] = '--version';
  const firstArgument = routed[2];

  if (
    firstArgument === undefined ||
    (!EXPLICIT_COMMANDS.has(firstArgument) && !ROOT_FLAGS.has(firstArgument))
  ) {
    routed.splice(2, 0, DEFAULT_COMMAND);
  }

  return routed;
}
