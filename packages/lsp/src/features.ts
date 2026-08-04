/**
 * What the editor asks for, answered from the IR.
 *
 * None of this re-implements the language. Diagnostics are the compiler's own,
 * with their codes and hints intact; go-to-definition is a lookup in the module
 * index; completion offers what the parser would accept in that position. When
 * the editor and the compiler disagree about HADL, the compiler is right, and
 * the way to keep that true is to never write a second opinion here.
 */
import {
  PRIMITIVE_TYPES,
  indexModule,
  typeToString,
  type Diagnostic,
  type IRDeclaration,
  type IRModule,
} from '@haic/core';
import type { Snapshot } from './workspace.js';

// ---------------------------------------------------------------------------
// LSP shapes, declared here rather than depended on
// ---------------------------------------------------------------------------

export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}
export interface Location {
  uri: string;
  range: Range;
}

export const DiagnosticSeverity = { error: 1, warning: 2, information: 3, hint: 4 } as const;

/** LSP `SymbolKind`, narrowed to the ones a HADL declaration maps onto. */
const SYMBOL_KIND: Record<string, number> = {
  enum: 10,
  'value-object': 23,
  entity: 23,
  aggregate: 5,
  dto: 23,
  command: 23,
  event: 24,
  error: 23,
  query: 12,
  port: 11,
  adapter: 5,
  service: 5,
  endpoint: 12,
  handler: 12,
  scenario: 8,
};

export const CompletionItemKind = { keyword: 14, class: 7, enumMember: 20, field: 5, method: 2, value: 12 } as const;

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** A compiler diagnostic, in the shape the editor draws. */
export function toLspDiagnostic(diagnostic: Diagnostic): Record<string, unknown> {
  return {
    range: spanToRange(diagnostic.span),
    severity:
      diagnostic.severity === 'error'
        ? DiagnosticSeverity.error
        : diagnostic.severity === 'warning'
          ? DiagnosticSeverity.warning
          : DiagnosticSeverity.information,
    code: diagnostic.code,
    source: 'haic',
    // The hint is the actionable half of a HADL diagnostic, and an editor that
    // shows only the message throws it away. It belongs in the hover text.
    message: diagnostic.hint ? `${diagnostic.message}\n\nhelp: ${diagnostic.hint}` : diagnostic.message,
    relatedInformation: diagnostic.related?.map((related) => ({
      location: { uri: pathToUri(related.span.file), range: spanToRange(related.span) },
      message: related.message,
    })),
  };
}

export function spanToRange(span: Diagnostic['span']): Range {
  return {
    start: { line: Math.max(0, span.start.line - 1), character: Math.max(0, span.start.column - 1) },
    end: { line: Math.max(0, span.end.line - 1), character: Math.max(0, span.end.column - 1) },
  };
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

export function documentSymbols(module: IRModule, text: string): Array<Record<string, unknown>> {
  const lines = text.split(/\r?\n/);
  return module.declarations.map((declaration) => {
    const line = Math.max(0, (declaration.span?.start.line ?? 1) - 1);
    const range: Range = { start: { line, character: 0 }, end: { line, character: lines[line]?.length ?? 0 } };
    return {
      name: declaration.name || declaration.kind,
      detail: detailOf(declaration),
      kind: SYMBOL_KIND[declaration.kind] ?? 23,
      range,
      selectionRange: range,
    };
  });
}

function detailOf(declaration: IRDeclaration): string {
  switch (declaration.kind) {
    case 'endpoint':
      return `${declaration.method} ${declaration.path}`;
    case 'port':
      return `${declaration.direction} port`;
    case 'adapter':
      return `implements ${declaration.implements} using ${declaration.technology}`;
    case 'error':
      return declaration.checked ? `checked${declaration.status ? `, status ${declaration.status}` : ''}` : 'unchecked';
    case 'handler':
      return declaration.schedule ? `schedule ${declaration.schedule}` : `on ${declaration.on}`;
    default:
      return declaration.kind.replace('-', ' ');
  }
}

// ---------------------------------------------------------------------------
// Go to definition and hover
// ---------------------------------------------------------------------------

/** Where the name under the cursor was declared, in whichever module holds it. */
export function definitionOf(snapshot: Snapshot, text: string, position: Position): Location | null {
  const word = wordAt(text, position);
  if (!word) return null;

  for (const [path, module] of snapshot.modules) {
    const declaration = module.declarations.find((d) => d.name === word);
    if (declaration?.span) return { uri: pathToUri(path), range: spanToRange(declaration.span) };
  }
  return null;
}

/** The declaration under the cursor, rendered as Markdown. */
export function hoverOf(snapshot: Snapshot, text: string, position: Position): string | null {
  const word = wordAt(text, position);
  if (!word) return null;

  for (const module of snapshot.modules.values()) {
    const declaration = module.declarations.find((d) => d.name === word);
    if (declaration) return describe(declaration, module);
  }
  return null;
}

function describe(declaration: IRDeclaration, module: IRModule): string {
  const lines = [`\`\`\`hadl\n## ${declaration.kind.replace('-', ' ')} ${declaration.name}\n\`\`\``];
  if (declaration.description) lines.push(declaration.description);

  if ('fields' in declaration && declaration.fields.length > 0) {
    lines.push(
      declaration.fields
        .map((field) => `- \`${field.name}: ${typeToString(field.type)}${field.required ? '' : ', optional'}\``)
        .join('\n'),
    );
  }
  if ('operations' in declaration && declaration.operations.length > 0) {
    lines.push(
      declaration.operations
        .map((operation) => {
          // A block is the part a reader most needs to be told about: it is the
          // one place the design stops describing what the code does.
          const native = 'native' in operation && operation.native.length > 0
            ? ` — written in ${operation.native.map((block) => block.dialect).join(', ')}`
            : '';
          return `- \`${operation.phrase} -> ${typeToString(operation.returns)}\`${native}`;
        })
        .join('\n'),
    );
  }
  if ('invariants' in declaration && declaration.invariants.length > 0) {
    lines.push(declaration.invariants.map((invariant) => `*invariant* "${invariant.description}"`).join('\n'));
  }
  lines.push(`*module* \`${module.name}\` · *context* \`${module.context}\``);
  return lines.join('\n\n');
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

const DECLARATION_KEYWORDS = [
  'enum',
  'value object',
  'entity',
  'aggregate',
  'dto',
  'command',
  'event',
  'error',
  'query',
  'port',
  'adapter',
  'service',
  'handler',
  'endpoint',
  'infrastructure',
  'glossary',
  'scenario',
];

const CLAUSE_KEYWORDS = [
  'identified by ',
  'belongs to ',
  'contains ',
  'emits ',
  'uses ',
  'implements ',
  'using ',
  'projects ',
  'targets ',
  'from ',
  'topic ',
  'handled by ',
  'request ',
  'responds ',
  'on ',
  'schedule ',
  'auth ',
  'invariant "',
  'operation ',
];

const STATEMENT_KEYWORDS = ['let ', 'set ', 'when ', 'otherwise:', 'for each ', 'add ', 'remove ', 'publish ', 'fail with ', 'perform ', 'return '];

/**
 * What the parser would accept where the cursor is.
 *
 * The rule that decides everything here is the same one that decides the
 * language: position carries meaning. A heading takes a declaration keyword, an
 * unindented line under one takes a clause, an indented line takes a statement,
 * and after a colon or an arrow the answer is a type.
 */
export function completionsAt(snapshot: Snapshot, text: string, position: Position): Array<Record<string, unknown>> {
  const lines = text.split(/\r?\n/);
  const line = lines[position.line] ?? '';
  const prefix = line.slice(0, position.character);
  const items: Array<Record<string, unknown>> = [];

  const push = (label: string, kind: number, detail: string): void => {
    items.push({ label, kind, detail });
  };

  if (/^#{1,2}\s*[\w ]*$/.test(prefix) && !/^#\s/.test(prefix)) {
    for (const keyword of DECLARATION_KEYWORDS) push(keyword, CompletionItemKind.keyword, 'declaration');
    return items;
  }

  // `- field: <type>` and `-> <type>` both want a type name.
  if (/(:|->)\s*[A-Za-z]*$/.test(prefix)) {
    for (const primitive of PRIMITIVE_TYPES) push(primitive, CompletionItemKind.value, 'primitive type');
    push('list of ', CompletionItemKind.keyword, 'collection');
    for (const declaration of namedShapes(snapshot)) push(declaration.name, CompletionItemKind.class, declaration.kind);
    return items;
  }

  const indented = /^\s+/.test(line);
  if (indented) {
    for (const keyword of STATEMENT_KEYWORDS) push(keyword, CompletionItemKind.keyword, 'statement');
    for (const phrase of operationPhrases(snapshot)) push(phrase.label, CompletionItemKind.method, phrase.detail);
    for (const declaration of namedShapes(snapshot)) push(declaration.name, CompletionItemKind.class, declaration.kind);
    for (const value of enumValues(snapshot)) push(value.label, CompletionItemKind.enumMember, value.detail);
    return items;
  }

  for (const keyword of CLAUSE_KEYWORDS) push(keyword, CompletionItemKind.keyword, 'clause');
  for (const declaration of namedShapes(snapshot)) push(declaration.name, CompletionItemKind.class, declaration.kind);
  return items;
}

function namedShapes(snapshot: Snapshot): IRDeclaration[] {
  return [...snapshot.modules.values()].flatMap((module) => module.declarations.filter((d) => d.name !== ''));
}

function operationPhrases(snapshot: Snapshot): Array<{ label: string; detail: string }> {
  const found: Array<{ label: string; detail: string }> = [];
  for (const module of snapshot.modules.values()) {
    const index = indexModule(module);
    for (const port of index.ports) {
      for (const operation of port.operations) found.push({ label: operation.phrase, detail: `${port.name} operation` });
    }
    for (const aggregate of index.aggregates) {
      for (const operation of aggregate.operations) found.push({ label: operation.phrase, detail: `${aggregate.name} operation` });
    }
  }
  return found;
}

function enumValues(snapshot: Snapshot): Array<{ label: string; detail: string }> {
  const found: Array<{ label: string; detail: string }> = [];
  for (const module of snapshot.modules.values()) {
    for (const declaration of module.declarations) {
      if (declaration.kind !== 'enum') continue;
      for (const value of declaration.values) found.push({ label: value.name, detail: `${declaration.name} value` });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** The identifier the cursor sits in or beside, or null between two of them. */
export function wordAt(text: string, position: Position): string | null {
  const line = text.split(/\r?\n/)[position.line];
  if (line === undefined) return null;

  let start = Math.min(position.character, line.length);
  let end = start;
  const isWord = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

  while (start > 0 && isWord(line[start - 1])) start -= 1;
  while (end < line.length && isWord(line[end])) end += 1;
  return end > start ? line.slice(start, end) : null;
}

export function pathToUri(path: string): string {
  if (path.startsWith('file://')) return path;
  const normalised = path.replace(/\\/g, '/');
  const absolute = normalised.startsWith('/') ? normalised : `/${normalised}`;
  return `file://${absolute.split('/').map(encodeURIComponent).join('/').replace(/%3A/gi, ':')}`;
}

export function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  const withoutScheme = decodeURIComponent(uri.slice('file://'.length));
  // `file:///c:/x` is a Windows path; `file:///home/x` is a POSIX one.
  return /^\/[A-Za-z]:/.test(withoutScheme) ? withoutScheme.slice(1).replace(/\//g, '\\') : withoutScheme;
}
