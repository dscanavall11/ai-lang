/** `ail build` — lower validated IR into a target language project. */
import { codeGenerators, generateProject } from '@ai-lang/codegen';
import type { CodegenTarget, GenerationContext } from '@ai-lang/core';
import { flagBoolean, flagList, flagString } from '../args.js';
import { EXIT_FAILURE, EXIT_OK, type Command } from '../command.js';
import { loadProject, renderDiagnostics } from '../driver.js';
import { dim, error, heading, info, listFiles, success, summarise, writeFiles } from '../output.js';

export const buildCommand: Command = {
  name: 'build',
  summary: 'Compile .ail sources into a target language project',
  usage: 'ail build [paths...] --target <language> [--out <dir>]',
  flags: [
    { name: '--target <ids>', description: 'Comma-separated targets, or "all". Defaults to each context\'s declared target' },
    { name: '--out <dir>', description: 'Output directory (default: ./out)' },
    { name: '--strict', description: 'Treat warnings as errors' },
    { name: '--dry-run', description: 'Report what would be written without writing it' },
  ],

  run({ args, cwd }) {
    const loaded = loadProject(args.positional, cwd, {
      strict: flagBoolean(args, 'strict'),
      projectName: flagString(args, 'project', 'ai-lang-project'),
    });

    if (loaded.diagnostics.length > 0) info(renderDiagnostics(loaded));
    if (!loaded.ok) {
      info('');
      error(`compilation stopped: ${summarise(loaded.diagnostics)}`);
      return EXIT_FAILURE;
    }

    const targets = resolveTargets(args.flags.get('target'), loaded.project.contexts, loaded.project.defaultTarget);
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

/** `--target` wins; otherwise each bounded context compiles to what it declared. */
function resolveTargets(
  flag: string | boolean | undefined,
  contexts: ReadonlyArray<{ target?: CodegenTarget }>,
  fallback: CodegenTarget,
): string[] {
  if (flag === 'all') return codeGenerators.ids();
  if (typeof flag === 'string') {
    return flag
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const declared = new Set(contexts.map((c) => c.target ?? fallback));
  return [...declared];
}

export { flagList };
