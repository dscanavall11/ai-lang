/**
 * The canonical layout of a `.hadl` file.
 *
 * A formatter for this language has to be unusually careful, because position
 * decides meaning: the lines directly under a heading are clauses, prose starts
 * after the first blank line, indentation opens a body, and the contents of a
 * fenced block belong to another language entirely. So this rewrites *layout*
 * and nothing else. It never reflows prose, never reorders anything, never
 * touches an expression, and never edits inside a fence beyond shifting the
 * whole block sideways.
 *
 * The property that matters is in the tests: formatting a file never changes
 * the IR it parses to. Everything below is only allowed to be true because that
 * test says it is.
 */
import { splitTopLevel } from './field-parser.js';

export interface FormatOptions {
  /** Spaces per indentation level. Two, unless something insists otherwise. */
  indent?: number;
}

const FENCE = /^(`{3,}|~{3,})(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^[-*]\s*(.*)$/;
const DELIMITER = /^-{3,}$/;

export function formatSource(text: string, options: FormatOptions = {}): string {
  const unit = ' '.repeat(options.indent ?? 2);
  const lines = text.split(/\r?\n/);
  // A file's line endings are the project's business, not the formatter's.
  // Rewriting a Windows checkout to LF would show up as every line changed.
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const out: string[] = [];

  // Original indent of each open level, so a body indented by three spaces or
  // by a tab comes out at the same depth as one indented by two.
  const levels: number[] = [];
  let index = 0;

  index = formatFrontmatter(lines, out);

  while (index < lines.length) {
    const raw = lines[index]!;
    const indent = leadingWidth(raw);
    const content = raw.slice(countLeading(raw)).replace(/\s+$/, '');
    index += 1;

    if (content === '') {
      out.push('');
      continue;
    }

    // Depth first: everything below needs to know where this line sits.
    while (levels.length > 0 && indent <= levels[levels.length - 1]!) levels.pop();
    if (levels.length === 0 || indent > levels[levels.length - 1]!) {
      if (indent > 0) levels.push(indent);
    }
    const depth = levels.length;
    const prefix = unit.repeat(depth);

    const fence = FENCE.exec(content);
    if (fence) {
      index = copyFence(lines, index, out, content, prefix, indent, fence[1]!);
      continue;
    }

    const heading = HEADING.exec(content);
    if (heading && indent === 0) {
      // A heading always opens a section, so it closes every body above it.
      levels.length = 0;
      blankBefore(out);
      out.push(`${heading[1]} ${collapseSpaces(heading[2]!.trim())}`);
      continue;
    }

    const bullet = BULLET.exec(content);
    if (bullet) {
      out.push(`${prefix}- ${formatBullet(bullet[1]!)}`);
      continue;
    }

    out.push(`${prefix}${content}`);
  }

  return `${collapseBlanks(out).join(newline).replace(/\s+$/, '')}${newline}`;
}

/** True when `text` is already what the formatter would write. */
export function isFormatted(text: string, options: FormatOptions = {}): boolean {
  return formatSource(text, options) === text;
}

/**
 * The YAML header. Only the layout is touched: a key gets one space after its
 * colon, a list item two spaces of indent, and the value is left alone —
 * `target: typescript` is data, not something to tidy.
 */
function formatFrontmatter(lines: readonly string[], out: string[]): number {
  let index = 0;
  while (index < lines.length && lines[index]!.trim() === '') index += 1;
  if (index >= lines.length || !DELIMITER.test(lines[index]!.trim())) return 0;

  out.push('---');
  index += 1;
  while (index < lines.length && !DELIMITER.test(lines[index]!.trim())) {
    const text = lines[index]!.trim();
    index += 1;
    if (text === '') {
      out.push('');
      continue;
    }
    const item = BULLET.exec(text);
    if (item) {
      out.push(`  - ${item[1]!.trim()}`);
      continue;
    }
    const entry = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(text);
    out.push(entry ? `${entry[1]}: ${entry[2]!.trim()}`.replace(/:\s+$/, ':') : text);
  }
  if (index < lines.length) {
    out.push('---');
    index += 1;
  }
  return index;
}

/**
 * A fenced block, moved as one piece.
 *
 * The code inside belongs to another language and another formatter; the only
 * thing done to it here is the same shift applied to every line, so the block
 * keeps sitting under its operation. If any line has too little indentation to
 * absorb an outdent, the whole block stays exactly where it was — a formatter
 * that silently reflows a here-document is worse than one that gives up.
 */
function copyFence(
  lines: readonly string[],
  start: number,
  out: string[],
  opener: string,
  prefix: string,
  indent: number,
  marker: string,
): number {
  const closing = new RegExp(`^${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
  const body: string[] = [];
  let index = start;
  let closed = false;

  while (index < lines.length) {
    const raw = lines[index]!;
    index += 1;
    if (closing.test(raw.trim())) {
      closed = true;
      break;
    }
    body.push(raw.replace(/\s+$/, ''));
  }

  const shift = prefix.length - indent;
  const shiftable =
    shift >= 0 || body.every((line) => line === '' || countLeading(line) >= -shift || leadingWidth(line) >= -shift);

  out.push(`${prefix}${opener}`);
  for (const line of body) out.push(shiftable ? reindent(line, shift) : line);
  // An unterminated fence is HADL1422. The parser reports it; the formatter
  // does not close it, because guessing where it ended would move real code.
  if (closed) out.push(`${prefix}${marker}`);
  return index;
}

function reindent(line: string, shift: number): string {
  if (line === '' || shift === 0) return line;
  if (shift > 0) return `${' '.repeat(shift)}${line}`;
  return line.slice(Math.min(-shift, countLeading(line)));
}

/**
 * A field bullet: `- name: Type, constraints`.
 *
 * Only the punctuation is normalised — one space after the colon, one after
 * each top-level comma. Anything from `//` onwards is left byte for byte,
 * because inline comments are often aligned by hand and re-spacing them is
 * churn with no reader on its side.
 */
function formatBullet(text: string): string {
  const { body, comment } = splitComment(text.trim());
  const colon = topLevelColon(body);
  if (colon < 0) return `${collapseSpaces(body)}${comment}`;

  const name = body.slice(0, colon).trim();
  const rest = splitTopLevel(body.slice(colon + 1), ',')
    .map((part) => collapseSpaces(part.trim()))
    .filter((part) => part !== '')
    .join(', ');
  return rest === '' ? `${name}:${comment}` : `${name}: ${rest}${comment}`;
}

/** Index of the first `:` outside quotes and brackets, or -1. */
function topLevelColon(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ':' && depth === 0) return i;
  }
  return -1;
}

/** Splits a trailing `// ...` comment off, whitespace before it included. */
function splitComment(text: string): { body: string; comment: string } {
  let quote: string | null = null;
  for (let i = 0; i < text.length - 1; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '/' && text[i + 1] === '/') {
      const start = text.slice(0, i).search(/\s+$/);
      return { body: text.slice(0, start < 0 ? i : start), comment: text.slice(start < 0 ? i : start) };
    }
  }
  return { body: text, comment: '' };
}

/** Collapses runs of whitespace outside quotes; leaves quoted text alone. */
function collapseSpaces(text: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (!out.endsWith(' ')) out += ' ';
      continue;
    }
    out += ch;
  }
  return out.trim();
}

/** One blank line before a heading, unless it opens the file. */
function blankBefore(out: string[]): void {
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  if (out.length > 0) out.push('');
}

/** Two blank lines say nothing one does not. */
function collapseBlanks(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line === '' && out[out.length - 1] === '') continue;
    out.push(line);
  }
  while (out.length > 0 && out[0] === '') out.shift();
  return out;
}

/** Visual width of the indentation: a tab counts as two, as it does in the lexer. */
function leadingWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 2;
    else break;
  }
  return width;
}

function countLeading(line: string): number {
  let count = 0;
  while (count < line.length && (line[count] === ' ' || line[count] === '\t')) count += 1;
  return count;
}
