/**
 * The server is driven here the way an editor drives it: real messages, in
 * order, through the same dispatch. Nothing reaches inside it.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { LanguageServer, MessageReader, encode, pathToUri, type Message } from '../src/index.js';

const root = mkdtempSync(join(tmpdir(), 'haic-lsp-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SOURCE = `---
module: probe
context: Probe
target: typescript
---

# Probe

## value object Money

An amount in one currency.

- amount: decimal, required, min 0
- currency: text, required, length 3

## aggregate Basket
identified by id

- id: uuid, required
- total: Money, required

invariant "a basket is never negative":
  total.amount is at least 0

operation clear () -> nothing:
  set total to Money with amount = 0, currency = "EUR"
`;

const path = join(root, 'probe.hadl');
const uri = pathToUri(path);
writeFileSync(path, SOURCE, 'utf8');

/** A server plus the messages it has sent, with helpers to ask it things. */
function connect() {
  const sent: Message[] = [];
  const server = new LanguageServer({ send: (message) => void sent.push(message) });
  let nextId = 1;

  const request = (method: string, params: unknown): unknown => {
    const id = nextId++;
    server.receive({ jsonrpc: '2.0', id, method, params });
    return sent.find((message) => message.id === id)?.result;
  };
  const notify = (method: string, params: unknown): void => {
    server.receive({ jsonrpc: '2.0', method, params });
  };

  request('initialize', { workspaceFolders: [{ uri: pathToUri(root) }] });
  notify('textDocument/didOpen', { textDocument: { uri, languageId: 'hadl', version: 1, text: SOURCE } });

  return {
    sent,
    request,
    notify,
    edit: (text: string) => notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text }] }),
    diagnostics: (): Array<{ code: string; message: string; range: { start: { line: number } } }> => {
      const published = [...sent].reverse().find((m) => m.method === 'textDocument/publishDiagnostics');
      return ((published?.params as { diagnostics: never[] } | undefined)?.diagnostics ?? []) as never[];
    },
  };
}

describe('initialize', () => {
  it('announces only what it actually implements', () => {
    const { request } = connect();
    const result = request('initialize', { workspaceFolders: [{ uri: pathToUri(root) }] }) as {
      capabilities: Record<string, unknown>;
    };
    expect(result.capabilities).toMatchObject({
      documentFormattingProvider: true,
      documentSymbolProvider: true,
      definitionProvider: true,
      hoverProvider: true,
    });
    expect(result.capabilities['textDocumentSync']).toMatchObject({ openClose: true, change: 1 });
  });
});

describe('diagnostics', () => {
  it('publishes nothing for a clean file', () => {
    expect(connect().diagnostics()).toEqual([]);
  });

  it('reports the compiler\'s own diagnostic, code and hint included', () => {
    const client = connect();
    client.edit(SOURCE.replace('- total: Money, required', '- total: Cash, required'));

    const reported = client.diagnostics();
    const unknownType = reported.find((diagnostic) => diagnostic.code === 'HADL2002');
    expect(unknownType?.message).toContain('Cash');
    // The hint is half of what a HADL diagnostic says; it must survive.
    expect(unknownType?.message).toContain('help:');
    // Every consequence the compiler reports is published, not just the first.
    expect(reported.map((diagnostic) => diagnostic.code)).toContain('HADL2124');
  });

  it('points at the line the compiler pointed at, zero-based', () => {
    const client = connect();
    client.edit(SOURCE.replace('- total: Money, required', '- total: Cash, required'));
    const line = client.diagnostics()[0]!.range.start.line;
    expect(SOURCE.split('\n')[line]).toBe('- total: Money, required');
  });

  it('clears them once the file is fixed', () => {
    const client = connect();
    client.edit(SOURCE.replace('Money, required', 'Cash, required'));
    expect(client.diagnostics().length).toBeGreaterThan(0);
    client.edit(SOURCE);
    expect(client.diagnostics()).toEqual([]);
  });

  it('survives a file that cannot be parsed at all', () => {
    const client = connect();
    client.edit('## aggregate\n((((\n');
    expect(client.diagnostics().length).toBeGreaterThan(0);
    // Still answering afterwards is the point: an editor keeps typing.
    expect(client.request('textDocument/documentSymbol', { textDocument: { uri } })).toBeDefined();
  });
});

describe('the outline', () => {
  it('lists every declaration with its kind', () => {
    const symbols = connect().request('textDocument/documentSymbol', { textDocument: { uri } }) as Array<{
      name: string;
      detail: string;
    }>;
    expect(symbols.map((s) => s.name)).toEqual(['Money', 'Basket']);
    expect(symbols[0]!.detail).toBe('value object');
  });
});

describe('go to definition', () => {
  it('jumps from a use of a type to where it was declared', () => {
    const line = SOURCE.split('\n').findIndex((l) => l.startsWith('- total: Money'));
    const location = connect().request('textDocument/definition', {
      textDocument: { uri },
      position: { line, character: 11 },
    }) as { uri: string; range: { start: { line: number } } } | null;

    expect(location?.uri).toBe(uri);
    expect(SOURCE.split('\n')[location!.range.start.line]).toBe('## value object Money');
  });

  it('answers null rather than guessing when the cursor is on nothing', () => {
    expect(connect().request('textDocument/definition', { textDocument: { uri }, position: { line: 5, character: 0 } })).toBeNull();
  });
});

describe('hover', () => {
  it('describes the declaration under the cursor', () => {
    const line = SOURCE.split('\n').findIndex((l) => l.startsWith('- total: Money'));
    const hover = connect().request('textDocument/hover', {
      textDocument: { uri },
      position: { line, character: 11 },
    }) as { contents: { value: string } };

    expect(hover.contents.value).toContain('## value object Money');
    expect(hover.contents.value).toContain('An amount in one currency.');
    expect(hover.contents.value).toContain('`amount: decimal`');
  });

  it('names the language an operation is written in', () => {
    const client = connect();
    client.edit(
      SOURCE.replace(
        'operation clear () -> nothing:\n  set total to Money with amount = 0, currency = "EUR"',
        'operation clear () -> nothing:\n  ```typescript\n  this.total = new Money({ amount: 0, currency: "EUR" });\n  ```',
      ),
    );
    const line = SOURCE.split('\n').findIndex((l) => l.startsWith('## aggregate Basket'));
    const hover = client.request('textDocument/hover', { textDocument: { uri }, position: { line, character: 14 } }) as {
      contents: { value: string };
    };
    expect(hover.contents.value).toContain('written in typescript');
  });
});

describe('completion', () => {
  const labels = (result: unknown): string[] => (result as { items: Array<{ label: string }> }).items.map((i) => i.label);

  it('offers declaration keywords after a heading marker', () => {
    const client = connect();
    const edited = `${SOURCE}\n## `;
    client.edit(edited);
    const line = edited.split('\n').findIndex((text) => text === '## ');
    const items = labels(
      client.request('textDocument/completion', { textDocument: { uri }, position: { line, character: 3 } }),
    );
    expect(items).toContain('aggregate');
    expect(items).toContain('value object');
  });

  it('offers types after a colon, declared ones included', () => {
    const line = SOURCE.split('\n').findIndex((l) => l.startsWith('- total: Money'));
    const items = labels(
      connect().request('textDocument/completion', { textDocument: { uri }, position: { line, character: 9 } }),
    );
    expect(items).toContain('decimal');
    expect(items).toContain('Money');
    expect(items).toContain('list of ');
  });

  it('offers statements inside a body', () => {
    const line = SOURCE.split('\n').findIndex((l) => l.startsWith('  set total'));
    const items = labels(
      connect().request('textDocument/completion', { textDocument: { uri }, position: { line, character: 2 } }),
    );
    expect(items).toContain('return ');
    expect(items).toContain('fail with ');
  });
});

describe('formatting', () => {
  it('answers with one edit that replaces the document', () => {
    const client = connect();
    client.edit(SOURCE.replace('- amount: decimal, required, min 0', '- amount:decimal,required , min 0'));
    const edits = client.request('textDocument/formatting', { textDocument: { uri }, options: {} }) as Array<{
      newText: string;
    }>;
    expect(edits).toHaveLength(1);
    expect(edits[0]!.newText).toContain('- amount: decimal, required, min 0');
  });

  it('answers with no edits when the file is already formatted', () => {
    expect(connect().request('textDocument/formatting', { textDocument: { uri }, options: {} })).toEqual([]);
  });
});

describe('the wire protocol', () => {
  let reader: MessageReader;
  beforeEach(() => {
    reader = new MessageReader();
  });

  it('reads a framed message', () => {
    expect(reader.push(encode({ jsonrpc: '2.0', id: 1, method: 'initialize' }))).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
    ]);
  });

  it('waits for a body that arrives in pieces', () => {
    const framed = encode({ jsonrpc: '2.0', id: 7, method: 'shutdown' });
    expect(reader.push(framed.slice(0, 20))).toEqual([]);
    expect(reader.push(framed.slice(20))).toEqual([{ jsonrpc: '2.0', id: 7, method: 'shutdown' }]);
  });

  it('reads two messages glued into one chunk', () => {
    const both = encode({ jsonrpc: '2.0', id: 1, method: 'a' }) + encode({ jsonrpc: '2.0', id: 2, method: 'b' });
    expect(reader.push(both).map((m) => m.method)).toEqual(['a', 'b']);
  });

  it('counts bytes, not characters', () => {
    // A single accented character is two bytes; a reader that counts string
    // length truncates the body and desynchronises every message after it.
    const framed = encode({ jsonrpc: '2.0', id: 1, method: 'x', params: { text: 'café ✓' } });
    expect(reader.push(framed)[0]).toMatchObject({ params: { text: 'café ✓' } });
  });
});

describe('lifecycle', () => {
  it('exits zero only after a shutdown', () => {
    const codes: number[] = [];
    const server = new LanguageServer({ send: () => {}, onExit: (code) => void codes.push(code) });
    server.receive({ jsonrpc: '2.0', id: 1, method: 'shutdown' });
    server.receive({ jsonrpc: '2.0', method: 'exit' });
    expect(codes).toEqual([0]);
  });

  it('exits non-zero when the client never asked to shut down', () => {
    const codes: number[] = [];
    const server = new LanguageServer({ send: () => {}, onExit: (code) => void codes.push(code) });
    server.receive({ jsonrpc: '2.0', method: 'exit' });
    expect(codes).toEqual([1]);
  });

  it('answers an unknown request instead of hanging', () => {
    const sent: Message[] = [];
    const server = new LanguageServer({ send: (message) => void sent.push(message) });
    server.receive({ jsonrpc: '2.0', id: 99, method: 'textDocument/rename', params: {} });
    expect(sent.find((m) => m.id === 99)).toEqual({ jsonrpc: '2.0', id: 99, result: null });
  });
});
