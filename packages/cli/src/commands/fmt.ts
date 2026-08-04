/**
 * `haic fmt` — the canonical layout, applied.
 *
 * The formatter rewrites layout and nothing else, so this command is allowed to
 * write over sources in place. `--check` is the same work without the writing,
 * for CI and for anyone who would rather see the list first.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { formatSource } from '@haic/parser';
import { flagBoolean } from '../args.js';
import { EXIT_FAILURE, EXIT_OK, type Command } from '../command.js';
import { discoverSources } from '../driver.js';
import { dim, error, info, success } from '../output.js';

export const fmtCommand: Command = {
  name: 'fmt',
  summary: 'Rewrite .hadl sources in the canonical layout',
  usage: 'haic fmt [paths...] [--check]',
  flags: [
    { name: '--check', description: 'Report what would change and exit non-zero, writing nothing' },
    { name: '--stdin', description: 'Format standard input and write the result to standard output' },
  ],

  async run({ args, cwd }) {
    if (flagBoolean(args, 'stdin')) {
      process.stdout.write(formatSource(await readStdin()));
      return EXIT_OK;
    }

    const check = flagBoolean(args, 'check');
    const files = discoverSources(args.positional, cwd);
    const changed: string[] = [];

    for (const absolute of files) {
      const text = readFileSync(absolute, 'utf8');
      const formatted = formatSource(text);
      if (formatted === text) continue;

      changed.push(relative(cwd, absolute).split(sep).join('/'));
      if (!check) writeFileSync(absolute, formatted, 'utf8');
    }

    if (changed.length === 0) {
      info(`${files.length} file${files.length === 1 ? '' : 's'} already formatted`);
      return EXIT_OK;
    }

    for (const path of changed) info(`  ${path}`);
    if (check) {
      info('');
      error(`${changed.length} file${changed.length === 1 ? '' : 's'} would be reformatted. Run "haic fmt" to fix.`);
      return EXIT_FAILURE;
    }
    success(`${changed.length} file${changed.length === 1 ? '' : 's'} reformatted ${dim(`of ${files.length}`)}`);
    return EXIT_OK;
  },
};

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (text += chunk));
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', reject);
  });
}
