/** `haic ir` — dump the typed IR. The artifact other tools (and reviewers) read. */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { flagBoolean, flagString } from '../args.js';
import { EXIT_FAILURE, EXIT_OK, type Command } from '../command.js';
import { loadProject, renderDiagnostics } from '../driver.js';
import { error, info, success, summarise } from '../output.js';

export const irCommand: Command = {
  name: 'ir',
  summary: 'Print the typed intermediate representation as JSON',
  usage: 'haic ir [paths...] [--out <file>] [--pretty]',
  flags: [
    { name: '--out <file>', description: 'Write to a file instead of stdout' },
    { name: '--pretty', description: 'Indent the JSON (default when writing to a terminal)' },
  ],

  run({ args, cwd }) {
    const loaded = loadProject(args.positional, cwd, { projectName: flagString(args, 'project', 'hadl-project') });
    if (!loaded.ok) {
      info(renderDiagnostics(loaded));
      error(`cannot emit IR: ${summarise(loaded.diagnostics)}`);
      return EXIT_FAILURE;
    }

    const pretty = flagBoolean(args, 'pretty') || process.stdout.isTTY === true;
    const json = JSON.stringify(loaded.project, null, pretty ? 2 : 0);

    const out = args.flags.get('out');
    if (typeof out === 'string') {
      const target = resolve(cwd, out);
      writeFileSync(target, `${json}\n`, 'utf8');
      success(`IR written to ${target}`);
      return EXIT_OK;
    }

    process.stdout.write(`${json}\n`);
    return EXIT_OK;
  },
};
