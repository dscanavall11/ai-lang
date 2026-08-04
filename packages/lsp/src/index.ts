/**
 * The HADL language server.
 *
 * `startLanguageServer()` wires it to a pair of streams — stdin and stdout, in
 * every editor that speaks LSP. `LanguageServer` itself takes messages and a
 * `send` callback, which is what makes it testable without a subprocess.
 */
import { LanguageServer } from './server.js';
import { MessageReader, encode, type Message } from './protocol.js';

export { LanguageServer, type ServerOptions } from './server.js';
export { MessageReader, encode, ErrorCodes, type Message } from './protocol.js';
export { Workspace, type Snapshot } from './workspace.js';
export {
  completionsAt,
  definitionOf,
  documentSymbols,
  hoverOf,
  pathToUri,
  spanToRange,
  toLspDiagnostic,
  uriToPath,
  wordAt,
  type Location,
  type Position,
  type Range,
} from './features.js';

export interface StreamOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Called when the client sends `exit`. Defaults to ending the process. */
  onExit?(code: number): void;
}

export function startLanguageServer(options: StreamOptions = {}): LanguageServer {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const reader = new MessageReader();

  const read = (chunk: Buffer | string): void => {
    for (const message of reader.push(chunk)) server.receive(message);
  };

  const server = new LanguageServer({
    send: (message: Message) => void output.write(encode(message)),
    onExit: (code: number) => {
      // Let go of the stream first. A paused pipe still holds a referenced
      // handle, and a referenced handle keeps Node's loop open — so a server
      // that only set an exit code would sit there forever having agreed to
      // leave. `unref` is what actually releases it; not every stream has one.
      input.removeListener('data', read);
      input.pause();
      (input as Partial<{ unref(): void }>).unref?.();
      (options.onExit ?? ((status: number) => process.exit(status)))(code);
    },
  });

  input.on('data', read);
  // An editor that dies does not get to send `exit` first. Treat the closed
  // pipe as the same request, or every crash leaves a server behind.
  input.on('end', () => server.receive({ jsonrpc: '2.0', method: 'exit' }));
  return server;
}
