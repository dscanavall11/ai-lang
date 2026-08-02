/**
 * Minimal argument parsing.
 *
 * A dependency would buy help formatting and little else, and the language this
 * tool compiles exists to argue against dependencies nobody needs.
 */

export interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | boolean>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }
    const name = token.replace(/^--?/, '');
    const equals = name.indexOf('=');
    if (equals >= 0) {
      flags.set(name.slice(0, equals), name.slice(equals + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      flags.set(name, next);
      i += 1;
      continue;
    }
    flags.set(name, true);
  }

  return { command: positional.shift(), positional, flags };
}

export function flagString(args: ParsedArgs, name: string, fallback: string): string {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : fallback;
}

export function flagBoolean(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === 'true';
}

export function flagList(args: ParsedArgs, name: string): string[] {
  const value = args.flags.get(name);
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
