/**
 * `ail architect` — turn a requirements document into a reviewable spec and a
 * first draft of the sources. Deterministic: no LLM, no network, no randomness.
 */
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { runArchitect } from '@ai-lang/architect';
import { flagBoolean, flagString } from '../args.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type Command } from '../command.js';
import { dim, error, heading, info, listFiles, success, writeFiles } from '../output.js';

export const architectCommand: Command = {
  name: 'architect',
  summary: 'Turn a requirements document into a reviewable spec and draft sources',
  usage: 'ail architect <requirements.md> [--out <dir>] [--project <name>]',
  flags: [
    { name: '--out <dir>', description: 'Output directory (default: the current directory)' },
    { name: '--project <name>', description: 'Project name (default: the requirements file name)' },
    { name: '--dry-run', description: 'Report what would be written without writing it' },
  ],

  run({ args, cwd }) {
    const input = args.positional[0];
    if (!input) {
      error('a requirements document is required: ail architect requirements.md');
      return EXIT_USAGE;
    }

    const absolute = resolve(cwd, input);
    let requirements: string;
    try {
      requirements = readFileSync(absolute, 'utf8');
    } catch {
      error(`cannot read ${input}`);
      return EXIT_FAILURE;
    }

    const display = relative(cwd, absolute).split(sep).join('/');
    const projectName = flagString(args, 'project', defaultProjectName(display));
    const result = runArchitect({ requirements, path: display, projectName });

    const failures = result.diagnostics.filter((d) => d.severity === 'error');
    if (failures.length > 0) {
      for (const diagnostic of failures) {
        error(`${diagnostic.message} (${diagnostic.span.file}:${diagnostic.span.start.line})`);
      }
      return EXIT_FAILURE;
    }

    heading('Bounded contexts');
    for (const context of result.state.architecture.contexts) {
      const stack = result.state.design.stacks.find((s) => s.context === context.name);
      info(`  ${context.name} (${context.kind}) → ${stack?.target ?? 'typescript'}`);
      info(`    ${dim(stack?.reason ?? '')}`);
    }

    heading('Generated');
    info(listFiles(result.files));

    if (result.openQuestions.length > 0) {
      heading(`Open questions (${result.openQuestions.length})`);
      for (const question of result.openQuestions) {
        info(`  ${question.question}`);
        info(`    ${dim(`assumed: ${question.assumption}`)}`);
      }
      info('');
      info(dim('Answer these in the requirements and re-run, or edit the drafted sources.'));
    }

    if (flagBoolean(args, 'dry-run')) {
      info(dim(`\n${result.files.length} files would be written`));
      return EXIT_OK;
    }

    const report = writeFiles(result.files, flagString(args, 'out', '.'), cwd);
    info('');
    success(`${report.written} files → ${dim(report.root)}`);
    info('');
    info('Next steps:');
    info('  review .ai-spec/ and answer the open questions');
    info('  ail check src');
    info('  ail build src');
    return EXIT_OK;
  },
};

function defaultProjectName(path: string): string {
  const base = path.split('/').pop() ?? 'project';
  return base.replace(/\.[^.]+$/, '');
}
