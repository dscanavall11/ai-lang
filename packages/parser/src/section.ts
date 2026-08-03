/**
 * Section splitting.
 *
 * A module is a Markdown document. Every `##` heading opens a declaration; the
 * words before the name are the declaration keyword, the parenthesised tail
 * holds modifiers:
 *
 *   ## error OrderNotFound (checked, status 404)
 *      ^^^^^ keyword       ^^^^^^^^^^^^^^^^^^^^ modifiers
 */
import type { SourceSpan } from '@haic/core';
import type { ParseReporter } from './reporter.js';
import { isBullet } from './field-parser.js';
import type { Line, SourceFile } from './source.js';
import { LineCursor } from './source.js';

export interface Section {
  /** Heading level: 1 for `#`, 2 for `##`, ... */
  level: number;
  /** Lower-cased keyword such as `aggregate` or `value object`. */
  keyword: string;
  /** Declared name; empty for keyword-only sections such as `## infrastructure`. */
  name: string;
  /** Raw text inside the parentheses on the heading line. */
  modifiers: string;
  heading: Line;
  span: SourceSpan;
  /** Lines belonging to this section, headings of deeper levels included. */
  body: Line[];
  file: SourceFile;
}

export interface SectionBody {
  /** Prose paragraphs before the first attribute or bullet, joined with blank lines. */
  description: string;
  /** Non-bullet lines that configure the declaration, e.g. `identified by id`. */
  attributes: Line[];
  /** `- ...` lines at the top level of the section. */
  bullets: Line[];
  /** Lines that open an indented block, paired with a cursor over that block. */
  blocks: Array<{ header: Line; body: LineCursor }>;
}

const HEADING = /^(#{1,6})\s+(.*)$/;

/** Splits a document into `##`-level sections. Deeper headings stay in the body. */
export function splitSections(file: SourceFile, lines: Line[], reporter: ParseReporter): { intro: Line[]; sections: Section[] } {
  const sections: Section[] = [];
  const intro: Line[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    // An indented `##` is a fenced example inside prose, not a declaration.
    const match = line.indent === 0 ? HEADING.exec(line.text) : null;
    if (match && match[1]!.length <= 2) {
      const level = match[1]!.length;
      if (level === 1) {
        // `#` is the document title; it never opens a declaration.
        current = null;
        intro.push(line);
        continue;
      }
      current = headingToSection(file, line, match[2]!.trim(), level, reporter);
      sections.push(current);
      continue;
    }
    if (current) current.body.push(line);
    else intro.push(line);
  }
  return { intro, sections };
}

/** Declarations whose heading is a sentence rather than an identifier. */
const FREE_TEXT_NAMES = new Set(['scenario', 'example']);

/** Known multi-word keywords, longest first so `value object` wins over `value`. */
const MULTI_WORD_KEYWORDS = ['value object', 'domain event', 'read model', 'anti corruption layer'];

function headingToSection(file: SourceFile, heading: Line, text: string, level: number, reporter: ParseReporter): Section {
  let rest = text;
  let modifiers = '';
  const open = rest.indexOf('(');
  if (open >= 0 && rest.endsWith(')')) {
    modifiers = rest.slice(open + 1, -1).trim();
    rest = rest.slice(0, open).trim();
  }

  const lower = rest.toLowerCase();
  let keyword = '';
  for (const candidate of MULTI_WORD_KEYWORDS) {
    if (lower === candidate || lower.startsWith(`${candidate} `)) {
      keyword = candidate;
      rest = rest.slice(candidate.length).trim();
      break;
    }
  }
  if (keyword === '') {
    const space = rest.indexOf(' ');
    if (space < 0) {
      keyword = lower;
      rest = '';
    } else {
      keyword = lower.slice(0, space);
      rest = rest.slice(space + 1).trim();
    }
  }

  // Everything after the name that is not parenthesised is a trailing modifier
  // clause, e.g. `## aggregate Order emits OrderPlaced`.
  let name = rest;
  if (!FREE_TEXT_NAMES.has(keyword)) {
    const nameSpace = rest.indexOf(' ');
    if (nameSpace >= 0) {
      name = rest.slice(0, nameSpace);
      const trailing = rest.slice(nameSpace + 1).trim();
      modifiers = modifiers.length > 0 ? `${modifiers}, ${trailing}` : trailing;
    }
    if (name.length > 0 && !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
      reporter.error('HADL1001', `"${name}" is not a valid declaration name`, file.spanOf(heading));
    }
  }

  return {
    level,
    keyword,
    name,
    modifiers,
    heading,
    span: file.spanOf(heading),
    body: [],
    file,
  };
}

/** Classifies the lines of a section into prose, attributes, bullets and blocks. */
export function readBody(section: Section): SectionBody {
  const cursor = new LineCursor(section.file, section.body);
  const paragraphs: string[] = [];
  const attributes: Line[] = [];
  const bullets: Line[] = [];
  const blocks: Array<{ header: Line; body: LineCursor }> = [];

  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) {
      paragraphs.push(paragraph.join(' '));
      paragraph = [];
    }
  };

  const baseIndent = section.body.find((l) => l.text !== '')?.indent ?? 0;

  for (;;) {
    cursor.skipTrivia();
    const line = cursor.peek();
    if (!line) break;

    if (line.indent > baseIndent) {
      // Orphan indentation: attach to the previous block header if there is one.
      cursor.next();
      continue;
    }

    if (isBullet(line)) {
      flush();
      cursor.next();
      bullets.push(line);
      continue;
    }

    if (line.text.endsWith(':')) {
      flush();
      cursor.next();
      blocks.push({ header: line, body: cursor.takeIndentedBlock(line.indent) });
      continue;
    }

    if (isAttributeLine(line.text)) {
      flush();
      cursor.next();
      attributes.push(line);
      continue;
    }

    cursor.next();
    paragraph.push(line.text);
  }
  flush();

  return { description: paragraphs.join('\n\n'), attributes, bullets, blocks };
}

/**
 * Lines that look like clauses but name no verb the language knows.
 *
 * A clause sits directly under the heading; prose starts after a blank line. So
 * an unindented line in that opening run which is neither a bullet nor a block
 * header nor a known verb is a misspelled clause, and reading it as prose is
 * how `primaryKey id` silently became no identity at all — the aggregate then
 * fell back to the `id` convention and nothing was reported.
 */
export function unknownClauses(section: Section): Line[] {
  const found: Line[] = [];
  const baseIndent = section.body.find((l) => l.text !== '')?.indent ?? 0;
  for (const line of section.body) {
    if (line.text === '') break;
    if (line.indent !== baseIndent) continue;
    if (isBullet(line) || line.text.endsWith(':') || isAttributeLine(line.text)) continue;
    found.push(line);
  }
  return found;
}

/**
 * Attribute lines start with a configuration verb. Anything else is prose, which
 * keeps documentation and configuration visually distinct without extra syntax.
 */
const ATTRIBUTE_VERBS = new Set([
  'identified',
  'belongs',
  'part',
  'contains',
  'emits',
  'uses',
  'implements',
  'using',
  'projects',
  'targets',
  'from',
  'handled',
  'request',
  'responds',
  'on',
  'retries',
  'delivery',
  'schedule',
  'auth',
  'idempotent',
  'message',
  'status',
  'port',
  'database',
  'broker',
  'cache',
  'storage',
  'secrets',
  'environment',
  'scaling',
  'deploy',
  'observability',
  'topic',
  'config',
  'invariant',
  'given',
  'when',
  'then',
  'and',
  'match',
  'sort',
  'limit',
  'operation',
  'extends',
]);

export function isAttributeLine(text: string): boolean {
  // `message: "..."` and `message "..."` are the same attribute.
  const first = text.split(/\s+/)[0]?.toLowerCase().replace(/[:=,]$/, '') ?? '';
  return ATTRIBUTE_VERBS.has(first);
}
