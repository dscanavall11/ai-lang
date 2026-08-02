/**
 * Line scanning.
 *
 * AI-Lang is line-oriented: Markdown headings open declarations, indentation
 * opens bodies. The cursor below is the only thing that reads raw text; every
 * other parser works on `Line` values.
 */
import type { SourcePosition, SourceSpan } from '@ai-lang/core';

export interface Line {
  /** 1-based line number in the original file. */
  number: number;
  /** Text with the leading indentation removed and trailing spaces trimmed. */
  text: string;
  /** Number of leading spaces (tabs count as two). */
  indent: number;
  /** Absolute offset of the first non-space character. */
  offset: number;
  /** The original line, indentation included. */
  raw: string;
}

export class SourceFile {
  readonly lines: Line[];

  constructor(
    readonly path: string,
    readonly text: string,
  ) {
    this.lines = scanLines(text);
  }

  /** Span covering `line`, optionally narrowed to `[from, to)` columns within its text. */
  span(line: Line, from = 0, to = line.text.length): SourceSpan {
    const start: SourcePosition = { line: line.number, column: line.indent + from + 1, offset: line.offset + from };
    const end: SourcePosition = { line: line.number, column: line.indent + to + 1, offset: line.offset + to };
    return { file: this.path, start, end };
  }

  spanOf(startLine: Line, endLine: Line = startLine): SourceSpan {
    return {
      file: this.path,
      start: { line: startLine.number, column: startLine.indent + 1, offset: startLine.offset },
      end: { line: endLine.number, column: endLine.indent + endLine.text.length + 1, offset: endLine.offset + endLine.text.length },
    };
  }
}

function scanLines(text: string): Line[] {
  const out: Line[] = [];
  let offset = 0;
  let number = 0;
  for (const raw of text.split('\n')) {
    number += 1;
    const withoutCr = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    let indent = 0;
    let i = 0;
    while (i < withoutCr.length) {
      const ch = withoutCr[i];
      if (ch === ' ') indent += 1;
      else if (ch === '\t') indent += 2;
      else break;
      i += 1;
    }
    out.push({
      number,
      text: withoutCr.slice(i).replace(/\s+$/, ''),
      indent,
      offset: offset + i,
      raw: withoutCr,
    });
    offset += raw.length + 1;
  }
  return out;
}

/** Forward-only cursor with indentation-aware block extraction. */
export class LineCursor {
  private position = 0;

  constructor(
    readonly file: SourceFile,
    private readonly lines: Line[] = file.lines,
  ) {}

  get atEnd(): boolean {
    return this.position >= this.lines.length;
  }

  peek(lookahead = 0): Line | undefined {
    return this.lines[this.position + lookahead];
  }

  next(): Line | undefined {
    return this.lines[this.position++];
  }

  /** Advances past blank lines and `//`-style comment lines. */
  skipTrivia(): void {
    while (this.position < this.lines.length) {
      const line = this.lines[this.position]!;
      if (line.text === '' || line.text.startsWith('//')) this.position += 1;
      else break;
    }
  }

  /** The next meaningful line, or `undefined` at end of file. */
  peekMeaningful(): Line | undefined {
    let i = this.position;
    while (i < this.lines.length) {
      const line = this.lines[i]!;
      if (line.text !== '' && !line.text.startsWith('//')) return line;
      i += 1;
    }
    return undefined;
  }

  /**
   * Consumes every following line indented deeper than `baseIndent` and returns
   * a cursor over them. Blank lines inside the block are preserved.
   */
  takeIndentedBlock(baseIndent: number): LineCursor {
    const collected: Line[] = [];
    while (this.position < this.lines.length) {
      const line = this.lines[this.position]!;
      if (line.text === '' || line.text.startsWith('//')) {
        // A blank line only ends the block if the next meaningful line dedents.
        const following = this.nextMeaningfulFrom(this.position + 1);
        if (!following || following.indent <= baseIndent) break;
        collected.push(line);
        this.position += 1;
        continue;
      }
      if (line.indent <= baseIndent) break;
      collected.push(line);
      this.position += 1;
    }
    return new LineCursor(this.file, collected);
  }

  /** Consumes lines until `predicate` matches the upcoming line (exclusive). */
  takeUntil(predicate: (line: Line) => boolean): LineCursor {
    const collected: Line[] = [];
    while (this.position < this.lines.length) {
      const line = this.lines[this.position]!;
      if (predicate(line)) break;
      collected.push(line);
      this.position += 1;
    }
    return new LineCursor(this.file, collected);
  }

  private nextMeaningfulFrom(start: number): Line | undefined {
    for (let i = start; i < this.lines.length; i += 1) {
      const line = this.lines[i]!;
      if (line.text !== '' && !line.text.startsWith('//')) return line;
    }
    return undefined;
  }

  /** All remaining lines, without consuming them. */
  rest(): Line[] {
    return this.lines.slice(this.position);
  }
}
