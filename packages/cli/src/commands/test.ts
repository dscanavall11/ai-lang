/**
 * `ail test` — run the scenarios against the IR itself.
 *
 * No code is generated, no toolchain is needed and no tokens are spent: the
 * design is exercised before it is expanded.
 */
import { runScenarios } from '@ai-lang/analyzer';
import { flagBoolean, flagString } from '../args.js';
import { EXIT_FAILURE, EXIT_OK, type Command } from '../command.js';
import { loadProject, renderDiagnostics } from '../driver.js';
import { dim, error, heading, info, summarise, warn } from '../output.js';

export const testCommand: Command = {
  name: 'test',
  summary: 'Run the scenarios declared in the sources, without generating anything',
  usage: 'ail test [paths...] [--only <name>]',
  flags: [
    { name: '--only <text>', description: 'Run only scenarios whose name contains this text' },
    { name: '--quiet', description: 'Print only the summary line' },
  ],

  run({ args, cwd }) {
    const loaded = loadProject(args.positional, cwd, { projectName: flagString(args, 'project', 'ai-lang-project') });

    if (!loaded.ok) {
      info(renderDiagnostics(loaded));
      info('');
      error(`cannot run scenarios: ${summarise(loaded.diagnostics)}`);
      return EXIT_FAILURE;
    }

    const only = flagString(args, 'only', '');
    const modules = loaded.project.modules;
    const report = runScenarios(modules);
    const shown = only ? report.results.filter((r) => r.title.toLowerCase().includes(only.toLowerCase())) : report.results;

    if (shown.length === 0) {
      warn(only ? `no scenario matches "${only}"` : 'no scenarios found');
      info(dim('  declare one with "## scenario <name>" followed by given / when / then'));
      return EXIT_OK;
    }

    const quiet = flagBoolean(args, 'quiet');
    let module = '';
    for (const result of shown) {
      if (!quiet && result.module !== module) {
        module = result.module;
        heading(module);
      }
      if (quiet) continue;

      const mark = result.outcome === 'passed' ? '✓' : result.outcome === 'failed' ? '✗' : '?';
      info(`  ${mark} ${result.title}`);
      for (const problem of result.problems) info(`      ${dim(problem)}`);
      if (result.outcome !== 'passed' && result.span) {
        info(`      ${dim(`${result.span.file}:${result.span.start.line}`)}`);
      }
    }

    info('');
    const counted = only ? countOf(shown) : report;
    const parts = [`${counted.passed} passed`];
    if (counted.failed > 0) parts.push(`${counted.failed} failed`);
    // An unrunnable scenario is reported, never quietly counted as a pass.
    if (counted.inconclusive > 0) parts.push(`${counted.inconclusive} could not run`);
    info(parts.join(', '));

    return counted.failed === 0 && counted.inconclusive === 0 ? EXIT_OK : EXIT_FAILURE;
  },
};

function countOf(results: ReturnType<typeof runScenarios>['results']) {
  return {
    passed: results.filter((r) => r.outcome === 'passed').length,
    failed: results.filter((r) => r.outcome === 'failed').length,
    inconclusive: results.filter((r) => r.outcome === 'inconclusive').length,
  };
}
