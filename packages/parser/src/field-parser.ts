/**
 * Field and operation-signature parsing.
 *
 *   - amount: decimal, required, min 0
 *   - currency: text, required, length 3        // ISO 4217 code
 *   - status: OrderStatus, default Draft
 *   - find order by id (id: uuid) -> Order or OrderNotFound
 */
import type { IRConstraint, IRField, IROperationSignature, IRParameter, IRType } from '@haic/core';
import type { ParseReporter } from './reporter.js';
import type { Line, LineCursor, SourceFile } from './source.js';
import { tokenize, TokenCursor } from './tokens.js';
import { parseType } from './type-parser.js';

export function isBullet(line: Line): boolean {
  return /^[-*]\s+/.test(line.text);
}

export function bulletBody(line: Line): string {
  return line.text.replace(/^[-*]\s+/, '');
}

/** Splits a trailing `// ...` comment off a bullet, returning it as documentation. */
function splitComment(text: string): { code: string; description?: string } {
  const index = findCommentStart(text);
  if (index < 0) return { code: text.trim() };
  return { code: text.slice(0, index).trim(), description: text.slice(index + 2).trim() };
}

function findCommentStart(text: string): number {
  let inString: string | null = null;
  for (let i = 0; i < text.length - 1; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") inString = ch;
    else if (ch === '/' && text[i + 1] === '/') return i;
  }
  return -1;
}

export function parseFieldLine(file: SourceFile, line: Line, reporter: ParseReporter): IRField | null {
  const { code, description } = splitComment(bulletBody(line));
  const colon = code.indexOf(':');
  if (colon < 0) {
    reporter.error(
      'HADL1101',
      `expected "<name>: <type>" in field declaration, found "${code}"`,
      file.spanOf(line),
      'fields are written as "- amount: decimal, required, min 0"',
    );
    return null;
  }
  const name = code.slice(0, colon).trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    reporter.error('HADL1102', `"${name}" is not a valid field name`, file.spanOf(line));
    return null;
  }

  const bulletOffset = line.text.length - bulletBody(line).length;
  const cursor = subCursor(file, line, code.slice(colon + 1), bulletOffset + colon + 1);
  const type = parseType(cursor, reporter);

  const field: IRField = {
    name,
    type,
    required: type.kind !== 'optional',
    identity: false,
    derived: false,
    constraints: [],
    span: file.spanOf(line),
  };
  if (description) field.description = description;

  while (cursor.eatPunct(',')) {
    applyModifier(cursor, field, reporter);
  }
  if (!cursor.atEnd) {
    reporter.error('HADL1103', `unexpected "${cursor.peek()!.raw}" after the field type`, cursor.currentSpan(), 'separate modifiers with commas');
  }
  return field;
}

function applyModifier(cursor: TokenCursor, field: IRField, reporter: ParseReporter): void {
  if (cursor.eatWord('required') || cursor.eatWord('mandatory')) {
    field.required = true;
    return;
  }
  if (cursor.eatWord('optional') || cursor.eatWord('nullable')) {
    field.required = false;
    if (field.type.kind !== 'optional') field.type = { kind: 'optional', of: field.type };
    return;
  }
  if (cursor.eatWord('identity') || cursor.eatPhrase('primary', 'key')) {
    field.identity = true;
    return;
  }
  if (cursor.eatWord('derived') || cursor.eatWord('computed')) {
    field.derived = true;
    return;
  }
  if (cursor.eatWord('unique')) {
    field.constraints.push({ kind: 'unique' });
    return;
  }
  if (cursor.eatWord('immutable') || cursor.eatPhrase('read', 'only')) {
    field.constraints.push({ kind: 'immutable' });
    return;
  }
  if (cursor.eatPhrase('min', 'length') || cursor.eatPhrase('minimum', 'length')) {
    pushNumeric(cursor, field, 'min-length', reporter);
    return;
  }
  if (cursor.eatPhrase('max', 'length') || cursor.eatPhrase('maximum', 'length')) {
    pushNumeric(cursor, field, 'max-length', reporter);
    return;
  }
  if (cursor.eatWord('length')) {
    pushNumeric(cursor, field, 'length', reporter);
    return;
  }
  if (cursor.eatWord('min', 'minimum')) {
    pushNumeric(cursor, field, 'min', reporter);
    return;
  }
  if (cursor.eatWord('max', 'maximum')) {
    pushNumeric(cursor, field, 'max', reporter);
    return;
  }
  if (cursor.eatWord('pattern', 'matching')) {
    const token = cursor.peek();
    if (token?.kind !== 'string') {
      reporter.error('HADL1104', 'expected a quoted regular expression after "pattern"', cursor.currentSpan());
      return;
    }
    cursor.next();
    field.constraints.push({ kind: 'pattern', value: token.value });
    return;
  }
  if (cursor.eatPhrase('one', 'of')) {
    const values: Array<string | number> = [];
    for (;;) {
      const token = cursor.peek();
      if (!token || (token.kind !== 'string' && token.kind !== 'number' && token.kind !== 'word')) break;
      cursor.next();
      values.push(token.kind === 'number' ? Number(token.value) : token.raw.replace(/^["']|["']$/g, ''));
      if (!cursor.eatPunct('|')) break;
    }
    if (values.length > 0) field.constraints.push({ kind: 'one-of', values });
    return;
  }
  if (cursor.eatWord('default', 'defaults')) {
    cursor.eatWord('to');
    const token = cursor.peek();
    if (!token) {
      reporter.error('HADL1105', 'expected a value after "default"', cursor.currentSpan());
      return;
    }
    cursor.next();
    const value =
      token.kind === 'number'
        ? Number(token.value)
        : token.kind === 'string'
          ? token.value
          : token.value === 'true'
            ? true
            : token.value === 'false'
              ? false
              : token.value === 'nothing' || token.value === 'null'
                ? null
                : token.raw;
    field.constraints.push({ kind: 'default', value });
    return;
  }

  const unexpected = cursor.peek();
  reporter.error(
    'HADL1106',
    `unknown field modifier "${unexpected?.raw ?? 'end of line'}"`,
    cursor.currentSpan(),
    'valid modifiers: required, optional, identity, derived, unique, immutable, min, max, min length, max length, length, pattern, one of, default',
  );
  cursor.next();
}

function pushNumeric(cursor: TokenCursor, field: IRField, kind: IRConstraint['kind'], reporter: ParseReporter): void {
  const token = cursor.peek();
  if (token?.kind !== 'number') {
    reporter.error('HADL1107', `expected a number after "${kind.replace('-', ' ')}"`, cursor.currentSpan());
    return;
  }
  cursor.next();
  field.constraints.push({ kind, value: Number(token.value) } as IRConstraint);
}

/**
 * `find order by id (id: uuid, limit: integer) -> Order or OrderNotFound`
 * The phrase is everything before the parameter list.
 */
export function parseOperationSignature(file: SourceFile, line: Line, text: string, reporter: ParseReporter): IROperationSignature | null {
  const { code, description } = splitComment(text);
  const open = code.indexOf('(');
  const close = findMatching(code, open);
  if (open < 0 || close < 0) {
    reporter.error(
      'HADL1108',
      `expected a parameter list in operation "${code}"`,
      file.spanOf(line),
      'operations are written as "find order by id (id: uuid) -> Order or OrderNotFound"',
    );
    return null;
  }

  const phrase = code.slice(0, open).trim();
  if (phrase.length === 0) {
    reporter.error('HADL1109', 'an operation needs a name before its parameter list', file.spanOf(line));
    return null;
  }

  const parameters = parseParameters(file, line, code.slice(open + 1, close), reporter);

  let returns: IRType = { kind: 'primitive', name: 'nothing' };
  const tail = code.slice(close + 1).trim();
  if (tail.length > 0) {
    const arrow = tail.startsWith('->') ? 2 : tail.toLowerCase().startsWith('returns') ? 7 : -1;
    if (arrow < 0) {
      reporter.error('HADL1110', `expected "->" before the return type in "${code}"`, file.spanOf(line));
    } else {
      const cursor = subCursor(file, line, tail.slice(arrow), close + 1 + arrow);
      returns = parseType(cursor, reporter);
    }
  }

  const throws = returns.kind === 'result' ? [...returns.errors] : [];
  const signature: IROperationSignature = {
    name: toIdentifier(phrase),
    phrase,
    parameters,
    returns,
    throws,
    effectful: false,
    span: file.spanOf(line),
  };
  if (description) signature.description = description;
  return signature;
}

function parseParameters(file: SourceFile, line: Line, text: string, reporter: ParseReporter): IRParameter[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const parameters: IRParameter[] = [];
  for (const part of splitTopLevel(trimmed, ',')) {
    const colon = part.indexOf(':');
    if (colon < 0) {
      reporter.error('HADL1111', `expected "<name>: <type>" in parameter "${part.trim()}"`, file.spanOf(line));
      continue;
    }
    const name = part.slice(0, colon).trim();
    const cursor = subCursor(file, line, part.slice(colon + 1), 0);
    const type = parseType(cursor, reporter);
    parameters.push({ name, type, required: type.kind !== 'optional' });
  }
  return parameters;
}

/** Splits on `separator` while ignoring separators nested in brackets or strings. */
export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      current += ch;
      if (ch === '\\') {
        current += text[i + 1] ?? '';
        i += 1;
      } else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

function findMatching(text: string, open: number): number {
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `find order by id` -> `findOrderById`. */
export function toIdentifier(phrase: string): string {
  const parts = phrase
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (parts.length === 0) return 'operation';
  const head = parts[0]!;
  return (
    head.charAt(0).toLowerCase() +
    head.slice(1) +
    parts
      .slice(1)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('')
  );
}

/**
 * Tokenizes a slice of a line while keeping columns aligned with the original,
 * so diagnostics still point at the right character.
 */
export function subCursor(file: SourceFile, line: Line, text: string, columnOffset: number): TokenCursor {
  const tokens = tokenize(text).map((token) => ({
    ...token,
    start: token.start + columnOffset,
    end: token.end + columnOffset,
  }));
  return new TokenCursor(tokens, line, file);
}
