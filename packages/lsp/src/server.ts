/**
 * The language server.
 *
 * `haic check` already answers every question an editor asks; this only carries
 * the answers across the wire. Nothing here decides what HADL means — when a
 * request needs a judgement, it parses and analyses exactly as the CLI does, so
 * the squiggle under a line and the error in the terminal can never disagree.
 *
 * Requests are handled synchronously, because analysing a whole HADL project
 * takes a few milliseconds. When that stops being true the fix is an
 * incremental analyzer, not a queue that hides the delay.
 */
import { formatSource } from '@haic/parser';
import { ErrorCodes, type Message } from './protocol.js';
import {
  completionsAt,
  definitionOf,
  documentSymbols,
  hoverOf,
  pathToUri,
  toLspDiagnostic,
  uriToPath,
  type Position,
} from './features.js';
import { Workspace } from './workspace.js';

export interface ServerOptions {
  /** Sends one message to the client. */
  send(message: Message): void;
  /** Called on `exit`, so a host can stop its own loop. */
  onExit?(code: number): void;
}

export class LanguageServer {
  private readonly workspace = new Workspace();
  private readonly send: ServerOptions['send'];
  private readonly onExit: ServerOptions['onExit'];
  private shuttingDown = false;
  /** Files this server has published diagnostics for, so it can clear them. */
  private readonly published = new Set<string>();

  constructor(options: ServerOptions) {
    this.send = options.send;
    this.onExit = options.onExit;
  }

  receive(message: Message): void {
    const { id, method } = message;
    if (method === undefined) return; // A response to something we sent; nothing does that yet.

    try {
      const result = this.dispatch(method, message.params);
      if (id !== undefined && id !== null) this.send({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (thrown) {
      const text = thrown instanceof Error ? thrown.message : String(thrown);
      if (id !== undefined && id !== null) {
        this.send({ jsonrpc: '2.0', id, error: { code: ErrorCodes.internalError, message: text } });
      } else {
        // A notification cannot carry a failure back, and a server that dies on
        // one keystroke is worse than one that says so and keeps going.
        this.log(`error handling ${method}: ${text}`);
      }
    }
  }

  private dispatch(method: string, params: unknown): unknown {
    switch (method) {
      case 'initialize':
        return this.initialize(params as InitializeParams);
      case 'initialized':
      case '$/setTrace':
      case 'workspace/didChangeConfiguration':
        return null;
      case 'shutdown':
        this.shuttingDown = true;
        return null;
      case 'exit':
        this.onExit?.(this.shuttingDown ? 0 : 1);
        return null;

      case 'textDocument/didOpen': {
        const { textDocument } = params as { textDocument: { uri: string; text: string } };
        this.workspace.openDocument(uriToPath(textDocument.uri), textDocument.text);
        this.validate();
        return null;
      }
      case 'textDocument/didChange': {
        const { textDocument, contentChanges } = params as {
          textDocument: { uri: string };
          contentChanges: Array<{ text: string }>;
        };
        // Full sync: the last change carries the whole document.
        const latest = contentChanges[contentChanges.length - 1];
        if (latest) this.workspace.updateDocument(uriToPath(textDocument.uri), latest.text);
        this.validate();
        return null;
      }
      case 'textDocument/didSave':
        this.validate();
        return null;
      case 'textDocument/didClose': {
        const { textDocument } = params as { textDocument: { uri: string } };
        this.workspace.closeDocument(uriToPath(textDocument.uri));
        this.validate();
        return null;
      }

      case 'textDocument/formatting':
        return this.formatting(params as { textDocument: { uri: string } });
      case 'textDocument/documentSymbol':
        return this.symbols(params as { textDocument: { uri: string } });
      case 'textDocument/definition':
        return this.definition(params as PositionParams);
      case 'textDocument/hover':
        return this.hover(params as PositionParams);
      case 'textDocument/completion':
        return this.completion(params as PositionParams);

      default:
        // Unknown notifications are ignored; unknown requests answer null,
        // which every client treats as "this server does not do that".
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private initialize(params: InitializeParams | undefined): unknown {
    for (const root of rootsOf(params)) this.workspace.addRoot(root);

    return {
      capabilities: {
        // Full sync: a HADL file is a page long, and sending the whole buffer
        // removes every way for the server's copy to drift from the editor's.
        textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
        documentFormattingProvider: true,
        documentSymbolProvider: true,
        definitionProvider: true,
        hoverProvider: true,
        completionProvider: { triggerCharacters: [' ', ':', '#', '>'] },
      },
      serverInfo: { name: 'haic', version: '0.2.1' },
    };
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  private formatting(params: { textDocument: { uri: string } }): unknown {
    const path = uriToPath(params.textDocument.uri);
    const text = this.workspace.textOf(path);
    if (text === undefined) return null;

    const formatted = formatSource(text);
    if (formatted === text) return [];

    // One edit over the whole document: the formatter's unit of work is the
    // file, and a diff-shaped edit would only pretend otherwise.
    const lines = text.split(/\r?\n/);
    return [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 },
        },
        newText: formatted,
      },
    ];
  }

  private symbols(params: { textDocument: { uri: string } }): unknown {
    const path = uriToPath(params.textDocument.uri);
    const text = this.workspace.textOf(path);
    const module = this.workspace.analyse().modules.get(path);
    if (!module || text === undefined) return [];
    return documentSymbols(module, text);
  }

  private definition(params: PositionParams): unknown {
    const text = this.workspace.textOf(uriToPath(params.textDocument.uri));
    if (text === undefined) return null;
    return definitionOf(this.workspace.analyse(), text, params.position);
  }

  private hover(params: PositionParams): unknown {
    const text = this.workspace.textOf(uriToPath(params.textDocument.uri));
    if (text === undefined) return null;
    const markdown = hoverOf(this.workspace.analyse(), text, params.position);
    return markdown === null ? null : { contents: { kind: 'markdown', value: markdown } };
  }

  private completion(params: PositionParams): unknown {
    const text = this.workspace.textOf(uriToPath(params.textDocument.uri));
    if (text === undefined) return { isIncomplete: false, items: [] };
    return { isIncomplete: false, items: completionsAt(this.workspace.analyse(), text, params.position) };
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  /** Publishes for every known file, and clears the ones that are clean now. */
  private validate(): void {
    const snapshot = this.workspace.analyse();
    for (const [path, diagnostics] of snapshot.diagnostics) {
      if (diagnostics.length === 0 && !this.published.has(path)) continue;
      if (diagnostics.length === 0) this.published.delete(path);
      else this.published.add(path);

      this.send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: { uri: pathToUri(path), diagnostics: diagnostics.map(toLspDiagnostic) },
      });
    }
  }

  private log(message: string): void {
    this.send({ jsonrpc: '2.0', method: 'window/logMessage', params: { type: 3, message } });
  }
}

interface InitializeParams {
  rootUri?: string | null;
  rootPath?: string | null;
  workspaceFolders?: Array<{ uri: string }> | null;
}

interface PositionParams {
  textDocument: { uri: string };
  position: Position;
}

function rootsOf(params: InitializeParams | undefined): string[] {
  if (!params) return [];
  const roots = (params.workspaceFolders ?? []).map((folder) => uriToPath(folder.uri));
  if (roots.length === 0 && params.rootUri) roots.push(uriToPath(params.rootUri));
  if (roots.length === 0 && params.rootPath) roots.push(params.rootPath);
  return roots;
}
