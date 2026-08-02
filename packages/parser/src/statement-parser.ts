/**
 * Statement parser.
 *
 * One statement per line. A trailing `:` opens an indented block:
 *
 *   let order be find order by id with id = command.orderId
 *   when order.status is not Draft:
 *     fail with OrderAlreadyPlaced using orderId = command.orderId
 *   otherwise:
 *     set order.status to Placed
 *   for each item in order.items:
 *     add item to reservedItems
 *   publish OrderPlaced with orderId = order.id, placedAt = now
 *   return OrderPlaced with orderId = order.id
 */
import type { IRArgument, IRStatement, SourceSpan } from '@ai-lang/core';
import { parseArguments, parseExpression } from './expression-parser.js';
import type { ParseReporter } from './reporter.js';
import type { Line, LineCursor } from './source.js';
import { isTypeName, TokenCursor } from './tokens.js';

export function parseStatements(lines: LineCursor, reporter: ParseReporter): IRStatement[] {
  const statements: IRStatement[] = [];
  for (;;) {
    lines.skipTrivia();
    const line = lines.peek();
    if (!line) break;

    // `otherwise:` belongs to the preceding `when`, handled there.
    if (/^otherwise\s*:?$/i.test(line.text) || /^else\s*:?$/i.test(line.text)) break;

    const statement = parseStatement(lines, reporter);
    if (statement) statements.push(statement);
  }
  return statements;
}

function parseStatement(lines: LineCursor, reporter: ParseReporter): IRStatement | null {
  const line = lines.next();
  if (!line) return null;
  const cursor = TokenCursor.forLine(lines.file, line);
  const span = lines.file.spanOf(line);

  if (cursor.eatWord('let') || cursor.eatWord('define')) return parseLet(cursor, reporter, span);
  if (cursor.eatWord('set') || cursor.eatWord('change')) return parseSet(cursor, reporter, span);
  if (cursor.eatWord('when') || cursor.eatWord('if')) return parseWhen(cursor, lines, reporter, line, span);
  if (cursor.eatPhrase('for', 'each') || cursor.eatPhrase('for', 'every')) return parseForEach(cursor, lines, reporter, line, span);
  if (cursor.eatWord('fail') || cursor.eatWord('reject') || cursor.eatWord('raise')) return parseFail(cursor, reporter, span);
  if (cursor.eatWord('publish') || cursor.eatWord('emit') || cursor.eatWord('announce')) return parsePublish(cursor, reporter, span);
  if (cursor.eatWord('add') || cursor.eatWord('append')) return parseAppend(cursor, reporter, span);
  if (cursor.eatWord('remove') || cursor.eatWord('drop')) return parseRemove(cursor, reporter, span);
  if (cursor.eatWord('return') || cursor.eatWord('answer') || cursor.eatPhrase('give', 'back')) return parseReturn(cursor, reporter, span);
  if (cursor.eatWord('perform') || cursor.eatWord('do') || cursor.eatWord('call')) {
    return { kind: 'perform', value: parseExpression(cursor, reporter), span };
  }

  // Bare expression statement: an operation call written without a keyword.
  const value = parseExpression(cursor, reporter);
  if (value.kind === 'call') return { kind: 'perform', value, span };

  reporter.error(
    'AIL1401',
    `"${line.text}" is not a statement`,
    span,
    'statements start with let, set, when, for each, add, remove, publish, fail, perform or return',
  );
  return null;
}

function parseLet(cursor: TokenCursor, reporter: ParseReporter, span: SourceSpan): IRStatement | null {
  const nameToken = cursor.peek();
  if (nameToken?.kind !== 'word' || isTypeName(nameToken)) {
    reporter.error('AIL1402', 'expected a lower-case variable name after "let"', cursor.currentSpan());
    return null;
  }
  cursor.next();
  if (!cursor.eatWord('be') && !cursor.eatPunct('=')) {
    reporter.error('AIL1403', `expected "be" after "let ${nameToken.raw}"`, cursor.currentSpan(), 'write "let total be sum of items by amount"');
    return null;
  }
  return { kind: 'let', name: nameToken.raw, value: parseExpression(cursor, reporter), span };
}

function parseSet(cursor: TokenCursor, reporter: ParseReporter, span: SourceSpan): IRStatement | null {
  const target = parsePath(cursor, reporter);
  if (target.length === 0) return null;
  if (!cursor.eatWord('to') && !cursor.eatPunct('=')) {
    reporter.error('AIL1404', `expected "to" after "set ${target.join('.')}"`, cursor.currentSpan());
    return null;
  }
  return { kind: 'set', target, value: parseExpression(cursor, reporter), span };
}

function parseWhen(
  cursor: TokenCursor,
  lines: LineCursor,
  reporter: ParseReporter,
  line: Line,
  span: SourceSpan,
): IRStatement {
  const condition = cursor.withStops(['then'], () => parseExpression(cursor, reporter));

  // Single-line form: `when x is empty then fail with Empty`.
  if (cursor.eatWord('then') && !cursor.atEnd) {
    const inline = parseInlineStatement(cursor, lines, reporter, span);
    return { kind: 'when', condition, then: inline ? [inline] : [], otherwise: [], span };
  }

  cursor.eatPunct(':');
  const thenBlock = parseStatements(lines.takeIndentedBlock(line.indent), reporter);

  let otherwise: IRStatement[] = [];
  lines.skipTrivia();
  const next = lines.peek();
  if (next && next.indent === line.indent && /^(otherwise|else)\s*:?$/i.test(next.text)) {
    lines.next();
    otherwise = parseStatements(lines.takeIndentedBlock(line.indent), reporter);
  }
  return { kind: 'when', condition, then: thenBlock, otherwise, span };
}

function parseForEach(
  cursor: TokenCursor,
  lines: LineCursor,
  reporter: ParseReporter,
  line: Line,
  span: SourceSpan,
): IRStatement | null {
  const itemToken = cursor.peek();
  if (itemToken?.kind !== 'word') {
    reporter.error('AIL1405', 'expected a loop variable after "for each"', cursor.currentSpan());
    return null;
  }
  cursor.next();
  if (!cursor.eatWord('in', 'of')) {
    reporter.error('AIL1406', `expected "in" after "for each ${itemToken.raw}"`, cursor.currentSpan());
    return null;
  }
  const collection = parseExpression(cursor, reporter);
  cursor.eatPunct(':');
  const body = parseStatements(lines.takeIndentedBlock(line.indent), reporter);
  return { kind: 'for-each', item: itemToken.raw, collection, body, span };
}

function parseFail(cursor: TokenCursor, reporter: ParseReporter, span: SourceSpan): IRStatement | null {
  cursor.eatWord('with');
  const errorToken = cursor.peek();
  if (!isTypeName(errorToken)) {
    reporter.error(
      'AIL1407',
      'expected the name of a declared error after "fail with"',
      cursor.currentSpan(),
      'errors are declared with "## error OrderNotFound (checked, status 404)"',
    );
    return null;
  }
  cursor.next();
  const args = cursor.eatWord('using', 'with') ? parseArguments(cursor, reporter) : [];
  return { kind: 'fail', error: errorToken!.raw, arguments: args, span };
}

function parsePublish(cursor: TokenCursor, reporter: ParseReporter, span: SourceSpan): IRStatement | null {
  const eventToken = cursor.peek();
  if (!isTypeName(eventToken)) {
    reporter.error('AIL1408', 'expected the name of a declared event after "publish"', cursor.currentSpan());
    return null;
  }
  cursor.next();
  const args: IRArgument[] = cursor.eatWord('with', 'carrying') ? parseArguments(cursor, reporter) : [];
  return { kind: 'publish', event: eventToken!.raw, arguments: args, span };
}

function parseAppend(cursor: TokenCursor, reporter: ParseReporter, span: SourceSpan): IRStatement | null {
  const value = cursor.withStops(['to'], () => parseExpression(cursor, reporter));
  if (!cursor.eatWord('to')) {
    reporter.error('AIL1409', 'expected "to <collection>" after "add"', cursor.currentSpan());
    return null;
  }
  const collection = parsePath(cursor, reporter);
  if (collection.length === 0) return null;
  return { kind: 'append', collection, value, span };
}

function parseRemove(cursor: TokenCursor, reporter: ParseReporter, span: SourceSpan): IRStatement | null {
  const value = cursor.withStops(['from'], () => parseExpression(cursor, reporter));
  if (!cursor.eatWord('from')) {
    reporter.error('AIL1410', 'expected "from <collection>" after "remove"', cursor.currentSpan());
    return null;
  }
  const collection = parsePath(cursor, reporter);
  if (collection.length === 0) return null;
  return { kind: 'remove', collection, value, span };
}

function parseReturn(cursor: TokenCursor, reporter: ParseReporter, span: SourceSpan): IRStatement {
  if (cursor.atEnd || cursor.atWord('nothing')) {
    cursor.eatWord('nothing');
    return { kind: 'return', value: null, span };
  }
  return { kind: 'return', value: parseExpression(cursor, reporter), span };
}

/** Statement forms allowed after `then` on the same line. */
function parseInlineStatement(
  cursor: TokenCursor,
  lines: LineCursor,
  reporter: ParseReporter,
  span: SourceSpan,
): IRStatement | null {
  if (cursor.eatWord('fail', 'reject', 'raise')) return parseFail(cursor, reporter, span);
  if (cursor.eatWord('publish', 'emit')) return parsePublish(cursor, reporter, span);
  if (cursor.eatWord('set')) return parseSet(cursor, reporter, span);
  if (cursor.eatWord('add')) return parseAppend(cursor, reporter, span);
  if (cursor.eatWord('remove')) return parseRemove(cursor, reporter, span);
  if (cursor.eatWord('return')) return parseReturn(cursor, reporter, span);
  if (cursor.eatWord('perform', 'do', 'call')) return { kind: 'perform', value: parseExpression(cursor, reporter), span };
  const value = parseExpression(cursor, reporter);
  if (value.kind === 'call') return { kind: 'perform', value, span };
  reporter.error('AIL1411', 'expected a statement after "then"', span);
  return null;
}

function parsePath(cursor: TokenCursor, reporter: ParseReporter): string[] {
  const first = cursor.peek();
  if (first?.kind !== 'word') {
    reporter.error('AIL1412', 'expected a field path', cursor.currentSpan());
    return [];
  }
  cursor.next();
  const path = [first.raw];
  while (cursor.atPunct('.')) {
    cursor.next();
    const part = cursor.peek();
    if (part?.kind !== 'word') {
      reporter.error('AIL1413', 'expected a field name after "."', cursor.currentSpan());
      break;
    }
    cursor.next();
    path.push(part.raw);
  }
  return path;
}
