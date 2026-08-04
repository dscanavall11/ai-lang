/**
 * Minimal argument parsing.
 *
 * A dependency would buy help formatting and little else, and the language this
 * tool compiles exists to argue against dependencies nobody needs.
 *
 * The one thing it cannot do without is knowing which flags take a value. A
 * parser that guesses — "the next word, unless it starts with a dash" — reads
 * `haic fmt --check src` as `--check=src` with no paths at all, and then
 * formats the current directory instead of checking the one you named. It did
 * exactly that. So the caller passes the set, taken from the command's own
 * documentation, and every other flag stands alone.
 */

export interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | boolean>;
}

export function parseArgs(argv: readonly string[], valueFlags: ReadonlySet<string> = new Set()): ParsedArgs {
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
      // `--out=dir` says what it means whether or not the flag is known.
      flags.set(name.slice(0, equals), name.slice(equals + 1));
      continue;
    }
    const next = argv[i + 1];
    if (valueFlags.has(name) && next !== undefined && !next.startsWith('-')) {
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
