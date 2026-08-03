/**
 * Type expressions.
 *
 *   text                       primitive
 *   list of OrderItem          collection
 *   map from text to Money     dictionary
 *   Money or nothing           optional
 *   Order or OrderNotFound     result carrying checked errors
 */
import { PRIMITIVE_TYPES, type IRType, type PrimitiveType } from '@haic/core';
import type { ParseReporter } from './reporter.js';
import { isTypeName, type TokenCursor } from './tokens.js';

const PRIMITIVES = new Set<string>(PRIMITIVE_TYPES);

/** Words accepted as friendlier spellings of a primitive. */
const PRIMITIVE_ALIASES: Record<string, PrimitiveType> = {
  string: 'text',
  str: 'text',
  int: 'integer',
  number: 'decimal',
  float: 'decimal',
  double: 'decimal',
  bool: 'boolean',
  flag: 'boolean',
  id: 'uuid',
  datetime: 'timestamp',
  instant: 'timestamp',
  void: 'nothing',
  none: 'nothing',
  binary: 'bytes',
  object: 'json',
};

export function parseType(cursor: TokenCursor, reporter: ParseReporter): IRType {
  return parseUnion(cursor, reporter);
}

function parseUnion(cursor: TokenCursor, reporter: ParseReporter): IRType {
  const base = parseCore(cursor, reporter);
  if (!cursor.atWord('or')) return base;
  cursor.eatWord('or');

  if (cursor.eatWord('nothing', 'none', 'nil')) {
    const optional: IRType = { kind: 'optional', of: base };
    return cursor.atWord('or') ? parseErrorTail(cursor, reporter, optional) : optional;
  }
  return parseErrorTail(cursor, reporter, base, true);
}

/** `Order or NotFound, Conflict` — the tail after `or` is a checked-error list. */
function parseErrorTail(cursor: TokenCursor, reporter: ParseReporter, ok: IRType, alreadyConsumedOr = false): IRType {
  if (!alreadyConsumedOr && !cursor.eatWord('or')) return ok;
  const errors: string[] = [];
  for (;;) {
    const token = cursor.peek();
    if (!isTypeName(token)) {
      reporter.error(
        'HADL1210',
        `expected the name of a checked error after "or", found ${describe(token?.raw)}`,
        cursor.currentSpan(),
        'checked errors are declared with "## error <Name> (checked)" and their names start with a capital letter',
      );
      break;
    }
    cursor.next();
    errors.push(token!.raw);
    if (!cursor.eatPunct(',')) break;
  }
  return errors.length > 0 ? { kind: 'result', ok, errors } : ok;
}

function parseCore(cursor: TokenCursor, reporter: ParseReporter): IRType {
  if (cursor.eatWord('optional')) {
    return { kind: 'optional', of: parseCore(cursor, reporter) };
  }
  if (cursor.eatPhrase('list', 'of') || cursor.eatPhrase('many')) {
    return { kind: 'list', of: parseCore(cursor, reporter) };
  }
  if (cursor.eatPhrase('set', 'of')) {
    return { kind: 'set', of: parseCore(cursor, reporter) };
  }
  if (cursor.eatPhrase('map', 'from')) {
    const key = parseCore(cursor, reporter);
    if (!cursor.eatWord('to')) {
      reporter.error('HADL1211', 'expected "to" in "map from <key> to <value>"', cursor.currentSpan());
    }
    return { kind: 'map', key, value: parseCore(cursor, reporter) };
  }

  const token = cursor.peek();
  if (token?.kind !== 'word') {
    reporter.error('HADL1212', `expected a type name, found ${describe(token?.raw)}`, cursor.currentSpan());
    cursor.next();
    return { kind: 'primitive', name: 'json' };
  }
  cursor.next();

  // Built-in types are always written in lower case, so `Money` never collides
  // with a primitive of the same name.
  if (!isTypeName(token)) {
    const alias = PRIMITIVE_ALIASES[token.value];
    if (alias) return { kind: 'primitive', name: alias };
    if (PRIMITIVES.has(token.value)) return { kind: 'primitive', name: token.value as PrimitiveType };
  }

  if (!isTypeName(token)) {
    reporter.error(
      'HADL1213',
      `unknown type "${token.raw}"`,
      cursor.spanOf(token),
      `declared types start with a capital letter; built-in types are ${PRIMITIVE_TYPES.join(', ')}`,
    );
  }
  // Collection shorthand: `OrderItems` is never inferred — plurals stay explicit.
  return { kind: 'named', name: token.raw };
}

function describe(raw: string | undefined): string {
  return raw === undefined ? 'end of line' : `"${raw}"`;
}
