/** `haic build` — lower validated IR into a target language project. */
import { codeGenerators, generateProject } from '@haic/codegen';
import {
  formatDiagnostics,
  languageNames,
  resolveLanguage,
  type CodegenTarget,
  type Diagnostic,
  type GenerationContext,
} from '@haic/core';
import { flagBoolean, flagList, flagString } from '../args.js';
import { EXIT_FAILURE, EXIT_OK, type Command } from '../command.js';
import { loadProject, renderDiagnostics } from '../driver.js';
import { dim, error, heading, info, listFiles, success, summarise, writeFiles } from '../output.js';

export const buildCommand: Command = {
  name: 'build',
  summary: 'Compile .hadl sources into a target language project',
  usage: 'haic build [paths...] --language <language> [--out <dir>]',
  flags: [
    {
      name: '--language <names>',
      description: 'Compile as this language, whatever the source declares. Accepts js, ts, py, golang, rs and the full names',
    },
    { name: '--target <ids>', description: 'The same thing by backend id, or "all". Defaults to each context\'s declared target' },
    { name: '--out <dir>', description: 'Output directory (default: ./out)' },
    { name: '--strict', description: 'Treat warnings as errors' },
    { name: '--dry-run', description: 'Report what would be written without writing it' },
  ],

  run({ args, cwd }) {
    const loaded = loadProject(args.positional, cwd, {
      strict: flagBoolean(args, 'strict'),
      projectName: flagString(args, 'project', 'hadl-project'),
    });

    if (loaded.diagnostics.length > 0) info(renderDiagnostics(loaded));
    if (!loaded.ok) {
      info('');
      error(`compilation stopped: ${summarise(loaded.diagnostics)}`);
      return EXIT_FAILURE;
    }

    let targets: string[];
    try {
      targets = resolveTargets(args.flags.get('language'), args.flags.get('target'), loaded.project.contexts, loaded.project.defaultTarget);
    } catch (thrown) {
      error(thrown instanceof Error ? thrown.message : String(thrown));
      return EXIT_FAILURE;
    }
    if (targets.length === 0) {
      error(`no target selected. Available: ${codeGenerators.ids().join(', ')}`);
      return EXIT_FAILURE;
    }

    const outputRoot = flagString(args, 'out', 'out');
    const dryRun = flagBoolean(args, 'dry-run');

    for (const target of targets) {
      const generator = codeGenerators.get(target);
      if (!generator) {
        error(`unknown target "${target}". Available: ${codeGenerators.ids().join(', ')}`);
        return EXIT_FAILURE;
      }

      const context: GenerationContext = {
        project: loaded.project,
        outputDir: `${outputRoot}/${target}`,
        options: {},
      };
      const result = generateProject(generator, context);

      heading(`${generator.displayName} (${generator.framework})`);
      // A backend reports what it could not lower — an operation written only in
      // another language, most often. Nothing is written when it does.
      if (result.diagnostics.length > 0) {
        info(formatDiagnostics(result.diagnostics, loaded.sources));
        if (result.diagnostics.some((d: Diagnostic) => d.severity === 'error')) {
          info('');
          error(`cannot compile to ${target}: ${summarise(result.diagnostics)}`);
          return EXIT_FAILURE;
        }
      }
      info(listFiles(result.files));
      if (!dryRun) {
        const report = writeFiles(result.files, context.outputDir, cwd);
        success(`${report.written} files → ${dim(report.root)}`);
        if (generator.verifyCommand) {
          info(`  ${dim(`verify with: cd ${context.outputDir} && ${generator.verifyCommand.join(' ')}`)}`);
        }
      } else {
        info(dim(`  ${result.files.length} files would be written to ${context.outputDir}`));
      }
    }

    return EXIT_OK;
  },
};

/**
 * `--language` wins over `--target`, and both win over the source.
 *
 * The two flags differ only in what they accept: `--language js` is the word a
 * reader would use, `--target typescript` is the backend id. They resolve to the
 * same five backends, and either one replaces the `target:` in the frontmatter
 * for this build — which is the point of having them. Without either, each
 * bounded context compiles to what it declared.
 */
function resolveTargets(
  language: string | boolean | undefined,
  target: string | boolean | undefined,
  contexts: ReadonlyArray<{ target?: CodegenTarget }>,
  fallback: CodegenTarget,
): string[] {
  if (language === 'all' || target === 'all') return codeGenerators.ids();
  if (typeof language === 'string') return language.split(',').map(namedLanguage).filter(Boolean);
  if (language === true) throw new Error(`--language needs a name. One of: ${languageNames().join(', ')}`);

  if (typeof target === 'string') {
    return target
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const declared = new Set(contexts.map((c) => c.target ?? fallback));
  return [...declared];
}

function namedLanguage(word: string): string {
  const trimmed = word.trim();
  if (trimmed === '') return '';
  const resolved = resolveLanguage(trimmed);
  if (!resolved) {
    throw new Error(`"${trimmed}" is not a language this compiler can emit. One of: ${languageNames().join(', ')}`);
  }
  return resolved;
}

export { flagList };
