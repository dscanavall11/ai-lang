/** CLI entry point: registry, dispatch, and help. */
import { parseArgs } from './args.js';
import { CommandRegistry, EXIT_OK, EXIT_USAGE, type Command } from './command.js';
import { architectCommand } from './commands/architect.js';
import { buildCommand } from './commands/build.js';
import { checkCommand } from './commands/check.js';
import { deployCommand } from './commands/deploy.js';
import { explainCommand } from './commands/explain.js';
import { irCommand } from './commands/ir.js';
import { newCommand } from './commands/new.js';
import { targetsCommand } from './commands/targets.js';
import { testCommand } from './commands/test.js';
import { dim, error, heading, info } from './output.js';

export const VERSION = '0.1.0';

export const registry = new CommandRegistry()
  .register(newCommand)
  .register(architectCommand)
  .register(checkCommand)
  .register(testCommand)
  .register(buildCommand)
  .register(deployCommand)
  .register(irCommand)
  .register(targetsCommand)
  .register(explainCommand);

export async function main(argv: readonly string[], cwd: string = process.cwd()): Promise<number> {
  const args = parseArgs(argv);

  if (args.flags.has('version') || args.flags.has('v') || args.command === 'version') {
    info(`ail ${VERSION}`);
    return EXIT_OK;
  }
  if (args.command === undefined || args.command === 'help' || args.flags.has('help') || args.flags.has('h')) {
    printHelp(args.positional[0]);
    return args.command === undefined && !args.flags.has('help') ? EXIT_USAGE : EXIT_OK;
  }

  const command = registry.get(args.command);
  if (!command) {
    error(`unknown command "${args.command}"`);
    info(dim(`Run "ail help" to see the available commands.`));
    return EXIT_USAGE;
  }

  try {
    return await command.run({ args, cwd });
  } catch (thrown) {
    error(thrown instanceof Error ? thrown.message : String(thrown));
    return EXIT_USAGE;
  }
}

function printHelp(topic: string | undefined): void {
  const command = topic ? registry.get(topic) : undefined;
  if (command) {
    printCommandHelp(command);
    return;
  }

  info(`ail ${VERSION} — the AI-Lang compiler`);
  info('');
  info(`${dim('Usage:')} ail <command> [paths...] [options]`);
  heading('Commands');
  const width = Math.max(...registry.all().map((c) => c.name.length));
  for (const entry of registry.all()) {
    info(`  ${entry.name.padEnd(width)}  ${entry.summary}`);
  }
  info('');
  info(dim('Run "ail help <command>" for the options of one command.'));
}

function printCommandHelp(command: Command): void {
  info(`${dim('Usage:')} ${command.usage}`);
  info('');
  info(command.summary);
  if (command.flags && command.flags.length > 0) {
    heading('Options');
    const width = Math.max(...command.flags.map((f) => f.name.length));
    for (const flag of command.flags) info(`  ${flag.name.padEnd(width)}  ${flag.description}`);
  }
}

export { parseArgs } from './args.js';
export { loadProject, discoverSources, renderDiagnostics, type LoadedProject } from './driver.js';
export { CommandRegistry, type Command, type CommandContext } from './command.js';
