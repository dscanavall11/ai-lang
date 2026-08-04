/** Command registry. Adding a command means registering one more object. */
import type { ParsedArgs } from './args.js';

export interface CommandContext {
  args: ParsedArgs;
  cwd: string;
}

export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  /**
   * Flag documentation shown by `haic help <command>`, and the only description
   * of which flags exist. A name written as `--out <dir>` takes a value; one
   * written as `--strict` does not, and the parser is told which is which from
   * exactly this list — so a flag missing here is a flag the command refuses.
   */
  readonly flags?: ReadonlyArray<{ name: string; description: string }>;
  /** Accepted but not worth a line of help, such as every language name on `build`. */
  readonly extraFlags?: readonly string[];
  /** Returns the process exit code. */
  run(context: CommandContext): number | Promise<number>;
}

/** Flags every command that loads sources understands. */
export const GLOBAL_FLAGS: ReadonlyArray<{ name: string; takesValue: boolean }> = [
  { name: 'project', takesValue: true },
  { name: 'help', takesValue: false },
  { name: 'h', takesValue: false },
  { name: 'version', takesValue: false },
  { name: 'v', takesValue: false },
];

/** Flag names that take a value: `--out <dir>` does, `--strict` does not. */
export function valueFlagsOf(command: Command | undefined): Set<string> {
  const names = new Set(GLOBAL_FLAGS.filter((flag) => flag.takesValue).map((flag) => flag.name));
  for (const flag of command?.flags ?? []) {
    const [written, ...argument] = flag.name.split(/\s+/);
    if (argument.length > 0) names.add(bare(written!));
  }
  return names;
}

/** Every flag name the command accepts, whether or not it takes a value. */
export function knownFlagsOf(command: Command | undefined): Set<string> {
  const names = new Set(GLOBAL_FLAGS.map((flag) => flag.name));
  for (const flag of command?.flags ?? []) names.add(bare(flag.name.split(/\s+/)[0]!));
  for (const extra of command?.extraFlags ?? []) names.add(extra);
  return names;
}

function bare(written: string): string {
  return written.replace(/^--?/, '');
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  register(command: Command): this {
    this.commands.set(command.name, command);
    return this;
  }

  get(name: string): Command | undefined {
    return this.commands.get(name);
  }

  all(): Command[] {
    return [...this.commands.values()];
  }
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
