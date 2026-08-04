/**
 * `haic lsp` — the compiler, speaking the protocol editors already know.
 *
 * There is no separate binary to install and no second copy of the language to
 * keep in step: the server an editor launches is this compiler, so a squiggle
 * in the editor and a failure in CI are the same diagnostic from the same pass.
 */
import { startLanguageServer } from '@haic/lsp';
import { EXIT_OK, type Command } from '../command.js';

export const lspCommand: Command = {
  name: 'lsp',
  summary: 'Run the language server on stdin/stdout, for editors that speak LSP',
  usage: 'haic lsp [--stdio]',
  flags: [{ name: '--stdio', description: 'Communicate over stdin and stdout. The default, and the only transport' }],

  run() {
    return new Promise<number>((resolve) => {
      startLanguageServer({ onExit: (code) => resolve(code === 0 ? EXIT_OK : code) });
      // The promise settles when the client sends `exit`; until then the
      // process stays alive on the open stdin handle.
    });
  },
};
