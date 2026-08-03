/**
 * Diagnostics: every stage of the compiler reports through this module.
 * A diagnostic always carries a source span so tooling can jump to it.
 */

export interface SourcePosition {
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
  /** 0-based absolute character offset. */
  offset: number;
}

export interface SourceSpan {
  file: string;
  start: SourcePosition;
  end: SourcePosition;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/** Stable machine-readable codes, grouped by compiler stage. */
export type DiagnosticStage = 'lex' | 'parse' | 'resolve' | 'type' | 'ddd' | 'error-flow' | 'ir' | 'codegen' | 'iac' | 'architect';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  stage: DiagnosticStage;
  /** e.g. `HADL2101`. Stable across versions; documented in the reference manual. */
  code: string;
  message: string;
  span: SourceSpan;
  /** Actionable follow-up shown under the message. */
  hint?: string;
  /** Secondary spans that explain the primary one ("first declared here"). */
  related?: Array<{ message: string; span: SourceSpan }>;
}

export const UNKNOWN_POSITION: SourcePosition = { line: 1, column: 1, offset: 0 };

export function span(file: string, start: SourcePosition, end: SourcePosition = start): SourceSpan {
  return { file, start, end };
}

export function unknownSpan(file = '<unknown>'): SourceSpan {
  return { file, start: UNKNOWN_POSITION, end: UNKNOWN_POSITION };
}

/** Accumulates diagnostics so a single pass can report many problems at once. */
export class DiagnosticBag {
  readonly items: Diagnostic[] = [];

  add(diagnostic: Diagnostic): void {
    this.items.push(diagnostic);
  }

  error(stage: DiagnosticStage, code: string, message: string, span: SourceSpan, extra: Partial<Diagnostic> = {}): void {
    this.add({ severity: 'error', stage, code, message, span, ...extra });
  }

  warn(stage: DiagnosticStage, code: string, message: string, span: SourceSpan, extra: Partial<Diagnostic> = {}): void {
    this.add({ severity: 'warning', stage, code, message, span, ...extra });
  }

  info(stage: DiagnosticStage, code: string, message: string, span: SourceSpan, extra: Partial<Diagnostic> = {}): void {
    this.add({ severity: 'info', stage, code, message, span, ...extra });
  }

  get errors(): Diagnostic[] {
    return this.items.filter((d) => d.severity === 'error');
  }

  get warnings(): Diagnostic[] {
    return this.items.filter((d) => d.severity === 'warning');
  }

  get hasErrors(): boolean {
    return this.items.some((d) => d.severity === 'error');
  }

  merge(other: DiagnosticBag | Diagnostic[]): void {
    const list = Array.isArray(other) ? other : other.items;
    for (const d of list) this.items.push(d);
  }
}

const SEVERITY_LABEL: Record<DiagnosticSeverity, string> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
};

/** Renders one diagnostic with a source excerpt and a caret underline. */
export function formatDiagnostic(diagnostic: Diagnostic, sourceText?: string): string {
  const { severity, code, message, span: s, hint, related } = diagnostic;
  const head = `${SEVERITY_LABEL[severity]}[${code}]: ${message}`;
  const location = `  --> ${s.file}:${s.start.line}:${s.start.column}`;
  const parts = [head, location];

  const excerpt = renderExcerpt(s, sourceText);
  if (excerpt) parts.push(excerpt);
  if (hint) parts.push(`  help: ${hint}`);
  for (const rel of related ?? []) {
    parts.push(`  note: ${rel.message} (${rel.span.file}:${rel.span.start.line}:${rel.span.start.column})`);
  }
  return parts.join('\n');
}

function renderExcerpt(s: SourceSpan, sourceText: string | undefined): string | null {
  if (!sourceText) return null;
  const lines = sourceText.split(/\r?\n/);
  const lineText = lines[s.start.line - 1];
  if (lineText === undefined) return null;
  const gutter = String(s.start.line);
  const pad = ' '.repeat(gutter.length);
  const width = s.end.line === s.start.line ? Math.max(1, s.end.column - s.start.column) : Math.max(1, lineText.length - s.start.column + 1);
  const caret = `${' '.repeat(Math.max(0, s.start.column - 1))}${'^'.repeat(width)}`;
  return [`${pad} |`, `${gutter} | ${lineText}`, `${pad} | ${caret}`].join('\n');
}

export function formatDiagnostics(diagnostics: Diagnostic[], sources: Map<string, string> = new Map()): string {
  return diagnostics.map((d) => formatDiagnostic(d, sources.get(d.span.file))).join('\n\n');
}

/** Thrown only when the compiler cannot continue; recoverable problems go in the bag. */
export class CompilerError extends Error {
  constructor(
    message: string,
    readonly diagnostics: Diagnostic[] = [],
  ) {
    super(message);
    this.name = 'CompilerError';
  }
}
