/** CLI entry point: registry, dispatch, and help. */
import { createRequire } from 'node:module';
import { parseArgs } from './args.js';
import { CommandRegistry, EXIT_OK, EXIT_USAGE, knownFlagsOf, valueFlagsOf, type Command } from './command.js';
import { architectCommand } from './commands/architect.js';
import { buildCommand } from './commands/build.js';
import { checkCommand } from './commands/check.js';
import { deployCommand } from './commands/deploy.js';
import { explainCommand } from './commands/explain.js';
import { fmtCommand } from './commands/fmt.js';
import { irCommand } from './commands/ir.js';
import { lspCommand } from './commands/lsp.js';
import { newCommand } from './commands/new.js';
import { targetsCommand } from './commands/targets.js';
import { testCommand } from './commands/test.js';
import { dim, error, heading, info } from './output.js';

/**
 * Read from the manifest rather than written here, because a constant repeated
 * beside the thing it names drifts from it — this one reported 0.1.0 for two
 * releases. `dist/index.js` sits one level under the package root, and npm
 * always ships package.json.
 */
export const VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

export const registry = new CommandRegistry()
  .register(newCommand)
  .register(architectCommand)
  .register(checkCommand)
  .register(fmtCommand)
  .register(testCommand)
  .register(buildCommand)
  .register(deployCommand)
  .register(irCommand)
  .register(lspCommand)
  .register(targetsCommand)
  .register(explainCommand);

export async function main(argv: readonly string[], cwd: string = process.cwd()): Promise<number> {
  // Parsed twice on purpose. Which flags take a value is a property of the
  // command, and the command name is the first positional — so the first pass
  // finds the command with nothing consuming an argument, and the second pass
  // parses for real. Guessing instead is how `--check src` lost its path.
  const command = registry.get(parseArgs(argv).command ?? '');
  const args = parseArgs(argv, valueFlagsOf(command));

  if (args.flags.has('version') || args.flags.has('v') || args.command === 'version') {
    info(`haic ${VERSION}`);
    return EXIT_OK;
  }
  if (args.command === undefined || args.command === 'help' || args.flags.has('help') || args.flags.has('h')) {
    printHelp(args.positional[0]);
    return args.command === undefined && !args.flags.has('help') ? EXIT_USAGE : EXIT_OK;
  }

  if (!command) {
    error(`unknown command "${args.command}"`);
    info(dim(`Run "haic help" to see the available commands.`));
    return EXIT_USAGE;
  }

  // An ignored flag is a command doing something other than what was asked, in
  // silence. `haic build --java` built TypeScript for exactly that reason.
  const known = knownFlagsOf(command);
  const unknown = [...args.flags.keys()].filter((flag) => !known.has(flag));
  if (unknown.length > 0) {
    error(`unknown option${unknown.length === 1 ? '' : 's'} ${unknown.map((flag) => `"--${flag}"`).join(', ')} for "${command.name}"`);
    info(dim(`Run "haic help ${command.name}" to see the options it takes.`));
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

  info(`haic ${VERSION} — the HADL compiler`);
  info('');
  info(`${dim('Usage:')} haic <command> [paths...] [options]`);
  heading('Commands');
  const width = Math.max(...registry.all().map((c) => c.name.length));
  for (const entry of registry.all()) {
    info(`  ${entry.name.padEnd(width)}  ${entry.summary}`);
  }
  info('');
  info(dim('Run "haic help <command>" for the options of one command.'));
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
