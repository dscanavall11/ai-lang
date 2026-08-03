/** `haic check` — parse, analyse and report. The command every other one starts with. */
import { flagBoolean, flagString } from '../args.js';
import { EXIT_FAILURE, EXIT_OK, type Command } from '../command.js';
import { loadProject, renderDiagnostics } from '../driver.js';
import { heading, info, summarise } from '../output.js';

export const checkCommand: Command = {
  name: 'check',
  summary: 'Parse and analyse .hadl sources without generating anything',
  usage: 'haic check [paths...] [--strict] [--project <name>]',
  flags: [
    { name: '--strict', description: 'Treat warnings as errors' },
    { name: '--project <name>', description: 'Project name recorded in the IR' },
    { name: '--quiet', description: 'Only print the summary line' },
  ],

  run({ args, cwd }) {
    const loaded = loadProject(args.positional, cwd, {
      strict: flagBoolean(args, 'strict'),
      projectName: flagString(args, 'project', 'hadl-project'),
    });

    if (!flagBoolean(args, 'quiet') && loaded.diagnostics.length > 0) {
      info(renderDiagnostics(loaded));
      info('');
    }

    const modules = loaded.project.modules.length;
    const contexts = loaded.project.contexts.length;
    info(`${summarise(loaded.diagnostics)} in ${modules} module${modules === 1 ? '' : 's'}, ${contexts} bounded context${contexts === 1 ? '' : 's'}`);

    if (loaded.ok && contexts > 0 && !flagBoolean(args, 'quiet')) {
      heading('Bounded contexts');
      for (const context of loaded.project.contexts) {
        info(`  ${context.name} (${context.kind}) → ${context.target ?? loaded.project.defaultTarget}`);
      }
      if (loaded.project.contextMap.length > 0) {
        heading('Context map');
        for (const edge of loaded.project.contextMap) {
          info(`  ${edge.upstream} → ${edge.downstream} (${edge.relationship})`);
        }
      }
    }

    return loaded.ok ? EXIT_OK : EXIT_FAILURE;
  },
};
