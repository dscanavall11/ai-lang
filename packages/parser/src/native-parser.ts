/**
 * Fenced native blocks.
 *
 * A module is a Markdown document, and Markdown already has a way to say "this
 * part is code in another language". HADL means it literally:
 *
 *   operation match order (book: OrderBook, incoming: Order) -> list of Trade:
 *     ```typescript
 *     const trades: Trade[] = [];
 *     ...
 *     return trades;
 *     ```
 *
 * The fence's info string names the language; everything between the fences is
 * carried into that backend untouched. Statements may sit beside a fence — they
 * are the reference implementation `haic test` runs, and the block is what
 * ships.
 */
import { resolveLanguage, type IRNativeBlock } from '@haic/core';
import type { ParseReporter } from './reporter.js';
import { LineCursor, type Line, type SourceFile } from './source.js';

const FENCE = /^(`{3,}|~{3,})\s*(.*)$/;

export function isFenceOpener(line: Line): boolean {
  return FENCE.test(line.text);
}

export interface SplitBody {
  /** Lines that are not part of any fence, in source order. */
  statements: LineCursor;
  natives: IRNativeBlock[];
}

/**
 * Separates fenced blocks from statements in an operation body.
 *
 * The cursor is consumed; callers parse statements from the returned one.
 */
export function splitNativeBlocks(file: SourceFile, body: LineCursor, owner: string, reporter: ParseReporter): SplitBody {
  const statements: Line[] = [];
  const natives: IRNativeBlock[] = [];

  for (;;) {
    const line = body.next();
    if (!line) break;

    const opener = FENCE.exec(line.text);
    if (!opener) {
      statements.push(line);
      continue;
    }
    const block = readFence(file, body, line, opener[1]!, opener[2]!.trim(), owner, reporter);
    if (!block) continue;

    const duplicate = natives.find((existing) => existing.target === block.target);
    if (duplicate) {
      reporter.error(
        'HADL1423',
        `${owner} declares two ${block.target} bodies`,
        block.span ?? file.spanOf(line),
        `"${duplicate.dialect}" and "${block.dialect}" both compile to ${block.target}; keep one`,
      );
      continue;
    }
    natives.push(block);
  }

  return { statements: new LineCursor(file, statements), natives };
}

function readFence(
  file: SourceFile,
  body: LineCursor,
  opener: Line,
  marker: string,
  info: string,
  owner: string,
  reporter: ParseReporter,
): IRNativeBlock | null {
  const language = info.split(/\s+/)[0] ?? '';
  const closing = new RegExp(`^${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);

  const code: string[] = [];
  let closed = false;
  for (;;) {
    const line = body.next();
    if (!line) break;
    if (closing.test(line.text)) {
      closed = true;
      break;
    }
    // `raw` keeps the indentation the author wrote; only the fence's own indent
    // is removed, so nesting inside the block survives verbatim.
    code.push(line.raw.slice(Math.min(opener.indent, leadingSpaces(line.raw))));
  }

  const span = file.spanOf(opener);
  if (!closed) {
    reporter.error('HADL1422', `unterminated code fence in ${owner}`, span, `close it with a line reading ${marker}`);
    return null;
  }
  if (language === '') {
    reporter.error(
      'HADL1420',
      `a code fence in ${owner} must name its language`,
      span,
      'write "```typescript" — the compiler needs to know which backend the block belongs to',
    );
    return null;
  }

  const target = resolveLanguage(language);
  if (!target) {
    reporter.error(
      'HADL1421',
      `"${language}" is not a language this compiler can emit`,
      span,
      'write typescript, java, python, go or rust — or one of their usual short names',
    );
    return null;
  }
  return { target, dialect: language, code: trimBlankEdges(code), span };
}

function leadingSpaces(raw: string): number {
  let count = 0;
  while (count < raw.length && (raw[count] === ' ' || raw[count] === '\t')) count += 1;
  return count;
}

function trimBlankEdges(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === '') start += 1;
  while (end > start && lines[end - 1]!.trim() === '') end -= 1;
  return lines.slice(start, end);
}
