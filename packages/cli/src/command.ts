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
  /** Flag documentation shown by `haic help <command>`. */
  readonly flags?: ReadonlyArray<{ name: string; description: string }>;
  /** Returns the process exit code. */
  run(context: CommandContext): number | Promise<number>;
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
