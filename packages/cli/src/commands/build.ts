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
import { flagBoolean, flagList, flagString, type ParsedArgs } from '../args.js';
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
    { name: '--<language>', description: 'The same thing, shorter: --java, --js, --py, --go, --rust' },
    { name: '--out <dir>', description: 'Output directory (default: ./out)' },
    { name: '--strict', description: 'Treat warnings as errors' },
    { name: '--dry-run', description: 'Report what would be written without writing it' },
  ],
  // `--java` reads better than `--language java` and is what people reach for.
  // It used to be accepted, ignored, and answered with a TypeScript project.
  extraFlags: languageNames(),

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
      targets = resolveTargets(args, loaded.project.contexts, loaded.project.defaultTarget);
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
      // "Build succeeded" and "project complete" are different statements, and
      // the gap between them is exactly the methods listed above.
      const placeholders = result.diagnostics.filter((d: Diagnostic) => d.code === 'HADL3061').length;
      if (placeholders > 0) {
        info(dim(`  ${placeholders} ${placeholders === 1 ? 'method needs' : 'methods need'} a hand-written body — see the warnings above`));
      }
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
 * A language named on the command line wins over `--target`, and both win over
 * the source.
 *
 * Three spellings, one meaning: `--java` is the short one, `--language java` is
 * the explicit one, `--target java` is the backend id. Each replaces the
 * `target:` in the frontmatter for this build, which is the point of having
 * them. Without any of them, each bounded context compiles to what it declared.
 */
function resolveTargets(
  args: ParsedArgs,
  contexts: ReadonlyArray<{ target?: CodegenTarget }>,
  fallback: CodegenTarget,
): string[] {
  const language = args.flags.get('language');
  const target = args.flags.get('target');
  if (language === 'all' || target === 'all') return codeGenerators.ids();

  // `--java --go` is two targets, the same as `--language java,go`.
  const shorthand = [...args.flags.keys()].map(resolveLanguage).filter((id): id is CodegenTarget => id !== null);
  const named = typeof language === 'string' ? language.split(',').map(namedLanguage).filter(Boolean) : [];
  if (language === true && named.length === 0 && shorthand.length === 0) {
    throw new Error(`--language needs a name. One of: ${languageNames().join(', ')}`);
  }
  const chosen = [...new Set([...named, ...shorthand])];
  if (chosen.length > 0) return chosen;

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
