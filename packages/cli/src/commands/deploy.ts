/** `haic deploy` — lower the same IR into infrastructure. */
import type { GenerationContext } from '@haic/core';
import { generateInfrastructure, infrastructureGenerators } from '@haic/iac';
import { flagBoolean, flagString } from '../args.js';
import { EXIT_FAILURE, EXIT_OK, type Command } from '../command.js';
import { loadProject, renderDiagnostics } from '../driver.js';
import { dim, error, heading, info, listFiles, success, summarise, warn, writeFiles } from '../output.js';

export const deployCommand: Command = {
  name: 'deploy',
  summary: 'Generate infrastructure as code from the same sources',
  usage: 'haic deploy [paths...] [--target <platform>] [--out <dir>]',
  flags: [
    { name: '--target <ids>', description: 'Comma-separated platforms, or "all". Defaults to what the sources declare' },
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
      error(`deployment stopped: ${summarise(loaded.diagnostics)}`);
      return EXIT_FAILURE;
    }

    const targets = resolveTargets(args.flags.get('target'), loaded);
    if (targets.length === 0) {
      warn('no deployment target selected and none declared in the sources');
      info(dim(`  add "deploy to docker, kubernetes" to an infrastructure block, or pass --target`));
      info(dim(`  available: ${infrastructureGenerators.ids().join(', ')}`));
      return EXIT_OK;
    }

    const outputRoot = flagString(args, 'out', 'out');
    const dryRun = flagBoolean(args, 'dry-run');

    for (const target of targets) {
      const generator = infrastructureGenerators.get(target);
      if (!generator) {
        error(`unknown platform "${target}". Available: ${infrastructureGenerators.ids().join(', ')}`);
        return EXIT_FAILURE;
      }

      const context: GenerationContext = {
        project: loaded.project,
        outputDir: `${outputRoot}/${target}`,
        options: {},
      };
      const result = generateInfrastructure(generator, context);

      heading(generator.displayName);
      for (const diagnostic of result.diagnostics) {
        if (diagnostic.severity === 'error') error(diagnostic.message);
        else warn(diagnostic.message);
      }
      info(listFiles(result.files));

      if (dryRun) {
        info(dim(`  ${result.files.length} files would be written to ${context.outputDir}`));
        continue;
      }
      const report = writeFiles(result.files, context.outputDir, cwd);
      success(`${report.written} files → ${dim(report.root)}`);
      if (generator.verifyCommand) {
        info(`  ${dim(`verify with: cd ${context.outputDir} && ${generator.verifyCommand.join(' ')}`)}`);
      }
    }

    return EXIT_OK;
  },
};

/** `--target` wins; otherwise the union of what every module's sources declared. */
function resolveTargets(flag: string | boolean | undefined, loaded: ReturnType<typeof loadProject>): string[] {
  if (flag === 'all') return infrastructureGenerators.ids();
  if (typeof flag === 'string') {
    return flag
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const declared = new Set<string>();
  for (const module of loaded.project.modules) {
    for (const target of module.infrastructure?.deploy ?? []) declared.add(target);
  }
  return [...declared];
}
