/**
 * Expression parser.
 *
 * The grammar is written so that ordinary English reads as valid code:
 *
 *   order.status is not Draft
 *   quantity times unitPrice.amount
 *   sum of items by quantity times unitPrice.amount
 *   find order by id with id = command.orderId
 *   a new Order with id = new id, placedAt = now
 *
 * Disambiguation rule (the one rule the whole surface syntax rests on):
 *   - a word starting with a capital letter is a **type or enum name**;
 *   - a word starting with a lower-case letter is a **value**;
 *   - two or more lower-case words in a row form an **operation phrase**.
 */
import type { BinaryOperator, IRArgument, IRExpression, IRType, SourceSpan } from '@ai-lang/core';
import type { ParseReporter } from './reporter.js';
import { isTypeName, type Token, type TokenCursor } from './tokens.js';

const TEXT: IRType = { kind: 'primitive', name: 'text' };
const INTEGER: IRType = { kind: 'primitive', name: 'integer' };
const DECIMAL: IRType = { kind: 'primitive', name: 'decimal' };
const BOOLEAN: IRType = { kind: 'primitive', name: 'boolean' };

export function parseExpression(cursor: TokenCursor, reporter: ParseReporter): IRExpression {
  return parseOr(cursor, reporter);
}

function parseOr(cursor: TokenCursor, reporter: ParseReporter): IRExpression {
  const anchor = cursor.currentSpan();
  let left = parseAnd(cursor, reporter);
  while (cursor.atWord('or')) {
    cursor.eatWord('or');
    const right = parseAnd(cursor, reporter);
    left = { kind: 'binary', operator: 'or', left, right, span: anchor };
  }
  return left;
}

function parseAnd(cursor: TokenCursor, reporter: ParseReporter): IRExpression {
  const anchor = cursor.currentSpan();
  let left = parseComparison(cursor, reporter);
  while (cursor.atWord('and')) {
    cursor.eatWord('and');
    const right = parseComparison(cursor, reporter);
    left = { kind: 'binary', operator: 'and', left, right, span: anchor };
  }
  return left;
}

function parseComparison(cursor: TokenCursor, reporter: ParseReporter): IRExpression {
  const anchor = cursor.currentSpan();
  const left = parseAdditive(cursor, reporter);

  // `is`-family comparisons, including the unary predicates.
  if (cursor.atWord('is', 'are', 'was')) {
    cursor.next();
    const negated = cursor.eatWord('not') !== null;

    if (cursor.eatWord('empty')) return unary(negated ? 'is-not-empty' : 'is-empty', left, anchor);
    if (cursor.eatWord('present') || cursor.eatPhrase('set')) return unary(negated ? 'is-absent' : 'is-present', left, anchor);
    if (cursor.eatWord('absent', 'missing', 'nothing')) return unary(negated ? 'is-present' : 'is-absent', left, anchor);
    if (cursor.eatPhrase('greater', 'than')) return compare(negated, 'greater-than', left, parseAdditive(cursor, reporter), anchor);
    if (cursor.eatPhrase('less', 'than')) return compare(negated, 'less-than', left, parseAdditive(cursor, reporter), anchor);
    if (cursor.eatPhrase('at', 'least')) return compare(negated, 'greater-or-equal', left, parseAdditive(cursor, reporter), anchor);
    if (cursor.eatPhrase('at', 'most')) return compare(negated, 'less-or-equal', left, parseAdditive(cursor, reporter), anchor);
    if (cursor.eatPhrase('one', 'of')) return { kind: 'binary', operator: negated ? 'not-equals' : 'contains', left: parseAdditive(cursor, reporter), right: left, span: anchor };

    return compare(negated, 'equals', left, parseAdditive(cursor, reporter), anchor);
  }

  if (cursor.eatWord('equals')) return { kind: 'binary', operator: 'equals', left, right: parseAdditive(cursor, reporter), span: anchor };
  if (cursor.eatWord('contains')) return { kind: 'binary', operator: 'contains', left, right: parseAdditive(cursor, reporter), span: anchor };
  if (cursor.eatPhrase('starts', 'with')) return { kind: 'binary', operator: 'starts-with', left, right: parseAdditive(cursor, reporter), span: anchor };
  if (cursor.eatPhrase('ends', 'with')) return { kind: 'binary', operator: 'ends-with', left, right: parseAdditive(cursor, reporter), span: anchor };
  if (cursor.eatWord('matches')) return { kind: 'binary', operator: 'matches', left, right: parseAdditive(cursor, reporter), span: anchor };

  return left;
}

function compare(negated: boolean, operator: BinaryOperator, left: IRExpression, right: IRExpression, span?: SourceSpan): IRExpression {
  const expression: IRExpression = { kind: 'binary', operator, left, right, span };
  if (!negated) return expression;
  if (operator === 'equals') return { kind: 'binary', operator: 'not-equals', left, right, span };
  return { kind: 'unary', operator: 'not', operand: expression, span };
}

function unary(
  operator: 'is-empty' | 'is-not-empty' | 'is-present' | 'is-absent',
  operand: IRExpression,
  span?: SourceSpan,
): IRExpression {
  return { kind: 'unary', operator, operand, span };
}

function parseAdditive(cursor: TokenCursor, reporter: ParseReporter): IRExpression {
  const span = cursor.currentSpan();
  let left = parseMultiplicative(cursor, reporter);
  for (;;) {
    if (cursor.eatWord('plus')) left = { kind: 'binary', operator: 'add', left, right: parseMultiplicative(cursor, reporter), span };
    else if (cursor.eatWord('minus')) left = { kind: 'binary', operator: 'subtract', left, right: parseMultiplicative(cursor, reporter), span };
    else return left;
  }
}

function parseMultiplicative(cursor: TokenCursor, reporter: ParseReporter): IRExpression {
  const span = cursor.currentSpan();
  let left = parseUnary(cursor, reporter);
  for (;;) {
    if (cursor.eatWord('times')) left = { kind: 'binary', operator: 'multiply', left, right: parseUnary(cursor, reporter), span };
    else if (cursor.eatPhrase('divided', 'by')) left = { kind: 'binary', operator: 'divide', left, right: parseUnary(cursor, reporter), span };
    else return left;
  }
}

function parseUnary(cursor: TokenCursor, reporter: ParseReporter): IRExpression {
  const span = cursor.currentSpan();
  if (cursor.eatWord('not')) return { kind: 'unary', operator: 'not', operand: parseUnary(cursor, reporter), span };
  if (cursor.atPunct('-')) {
    cursor.next();
    return { kind: 'unary', operator: 'negate', operand: parseUnary(cursor, reporter), span };
  }
  return parsePrimary(cursor, reporter);
}

const AGGREGATE_WORDS: Record<string, 'sum' | 'count' | 'min' | 'max' | 'average'> = {
  sum: 'sum',
  total: 'sum',
  count: 'count',
  number: 'count',
  minimum: 'min',
  smallest: 'min',
  maximum: 'max',
  largest: 'max',
  average: 'average',
};

function parsePrimary(cursor: TokenCursor, reporter: ParseReporter): IRExpression {
  const token = cursor.peek();
  if (!token) {
    reporter.error('AIL1301', 'expected an expression, found end of line', cursor.currentSpan());
    return { kind: 'literal', value: null, type: { kind: 'primitive', name: 'nothing' } };
  }

  if (cursor.atPunct('(')) {
    cursor.next();
    const inner = parseExpression(cursor, reporter);
    if (!cursor.eatPunct(')')) reporter.error('AIL1302', 'unclosed "(" in expression', cursor.currentSpan());
    return inner;
  }

  // `[]`, or `[a, b, c]`. The element type comes from where the list is used.
  if (cursor.atPunct('[')) {
    cursor.next();
    const items: IRExpression[] = [];
    if (!cursor.atPunct(']')) {
      for (;;) {
        items.push(parseOr(cursor, reporter));
        if (!cursor.eatPunct(',')) break;
      }
    }
    if (!cursor.eatPunct(']')) reporter.error('AIL1311', 'unclosed "[" in list', cursor.currentSpan());
    return { kind: 'list', items, span: cursor.spanOf(token) };
  }

  if (token.kind === 'string') {
    cursor.next();
    return { kind: 'literal', value: token.value, type: TEXT, span: cursor.spanOf(token) };
  }

  if (token.kind === 'number') {
    cursor.next();
    const isDecimal = token.value.includes('.');
    return {
      kind: 'literal',
      value: Number(token.value),
      type: isDecimal ? DECIMAL : INTEGER,
      span: cursor.spanOf(token),
    };
  }

  if (token.kind !== 'word') {
    reporter.error('AIL1303', `unexpected "${token.raw}" in expression`, cursor.spanOf(token));
    cursor.next();
    return { kind: 'literal', value: null, type: { kind: 'primitive', name: 'nothing' } };
  }

  // Literals and intrinsics.
  if (cursor.eatWord('true', 'yes')) return { kind: 'literal', value: true, type: BOOLEAN, span: cursor.spanOf(token) };
  if (cursor.eatWord('false', 'no')) return { kind: 'literal', value: false, type: BOOLEAN, span: cursor.spanOf(token) };
  if (cursor.eatWord('nothing', 'null', 'none')) {
    return { kind: 'literal', value: null, type: { kind: 'primitive', name: 'nothing' }, span: cursor.spanOf(token) };
  }
  if (cursor.eatWord('now') || cursor.eatPhrase('current', 'time')) return { kind: 'now', span: cursor.spanOf(token) };
  if (cursor.eatPhrase('new', 'id') || cursor.eatPhrase('a', 'new', 'id')) return { kind: 'new-id', span: cursor.spanOf(token) };

  // Aggregate functions: `sum of items by quantity times unitPrice.amount`.
  const aggregate = AGGREGATE_WORDS[token.value];
  if (aggregate && cursor.peek(1)?.value === 'of') {
    cursor.next();
    cursor.next();
    // `by` belongs to this construct, so it must not extend the collection phrase.
    const collection = cursor.withStops(['by'], () => parseUnary(cursor, reporter));
    const of = cursor.eatWord('by') ? parseMultiplicative(cursor, reporter) : null;
    return { kind: 'aggregate', fn: aggregate, collection, of, span: cursor.spanOf(token) };
  }

  // `each of items by productId` maps the list; the shape mirrors an aggregate,
  // but `by` is required because a projection with nothing to project is just
  // the collection itself.
  if (token.value === 'each' && cursor.peek(1)?.value === 'of') {
    cursor.next();
    cursor.next();
    const collection = cursor.withStops(['by'], () => parseUnary(cursor, reporter));
    if (!cursor.eatWord('by')) {
      reporter.error('AIL1112', '"each of" needs "by"', cursor.currentSpan(), 'write "each of items by productId"');
      return collection;
    }
    return { kind: 'project', fn: 'each', collection, of: parseMultiplicative(cursor, reporter), span: cursor.spanOf(token) };
  }

  // `only items where quantity is at least 2` filters it.
  if (token.value === 'only') {
    cursor.next();
    const collection = cursor.withStops(['where'], () => parseUnary(cursor, reporter));
    if (!cursor.eatWord('where')) {
      reporter.error('AIL1113', '"only" needs "where"', cursor.currentSpan(), 'write "only items where quantity is at least 2"');
      return collection;
    }
    return { kind: 'project', fn: 'only', collection, of: parseExpression(cursor, reporter), span: cursor.spanOf(token) };
  }

  // `the result of <phrase> with ...` — explicit call marker.
  if (cursor.eatPhrase('the', 'result', 'of') || cursor.eatPhrase('result', 'of')) {
    return parseCall(cursor, reporter, token);
  }

  // `a new Order with ...` / `an Order with ...`
  const article = cursor.eatWord('a', 'an', 'the');
  if (article && cursor.eatWord('new') && isTypeName(cursor.peek())) {
    return parseConstruct(cursor, reporter);
  }
  if (article && isTypeName(cursor.peek())) {
    return parseConstruct(cursor, reporter);
  }
  if (cursor.eatWord('new') && isTypeName(cursor.peek())) {
    return parseConstruct(cursor, reporter);
  }

  // `Money with amount = 10`, `OrderSummary from order`, or an enum member `Draft`.
  if (isTypeName(token)) {
    cursor.next();
    if (cursor.atWord('with', 'from')) {
      cursor.reset(cursor.index - 1);
      return parseConstruct(cursor, reporter);
    }
    return { kind: 'reference', path: [token.raw], span: cursor.spanOf(token) };
  }

  // A lower-case word: either a value reference or an operation phrase.
  return parseReferenceOrCall(cursor, reporter);
}

/**
 * `Money with amount = 10` — every field spelled out.
 * `OrderSummary from order` — every field taken from a source of the same name.
 * `OrderSummary from order with itemCount = count of order.items` — both.
 */
function parseConstruct(cursor: TokenCursor, reporter: ParseReporter): IRExpression {
  const nameToken = cursor.next();
  if (!nameToken || !isTypeName(nameToken)) {
    reporter.error('AIL1304', 'expected a type name after "new"', cursor.currentSpan());
    return { kind: 'literal', value: null, type: { kind: 'primitive', name: 'nothing' } };
  }

  let source: string[] | null = null;
  if (cursor.eatWord('from')) {
    source = parseSourcePath(cursor, reporter);
    if (source === null) {
      return { kind: 'construct', type: nameToken.raw, source: null, arguments: [], span: cursor.spanOf(nameToken) };
    }
  }

  const args = cursor.eatWord('with') ? parseArguments(cursor, reporter) : [];
  return { kind: 'construct', type: nameToken.raw, source, arguments: args, span: cursor.spanOf(nameToken) };
}

/** The dotted path after `from`. Only a value path is allowed, never a call. */
function parseSourcePath(cursor: TokenCursor, reporter: ParseReporter): string[] | null {
  const head = cursor.peek();
  if (head?.kind !== 'word' || isTypeName(head)) {
    reporter.error(
      'AIL1309',
      'expected the name of a value after "from"',
      cursor.currentSpan(),
      'write "OrderSummary from order" where "order" is a local or a parameter',
    );
    return null;
  }
  cursor.next();
  const path = [head.raw];
  while (cursor.atPunct('.')) {
    cursor.next();
    const part = cursor.peek();
    if (part?.kind !== 'word') {
      reporter.error('AIL1310', 'expected a field name after "."', cursor.currentSpan());
      break;
    }
    cursor.next();
    path.push(part.raw);
  }
  return path;
}

function parseCall(cursor: TokenCursor, reporter: ParseReporter, anchor: Token): IRExpression {
  const words: string[] = [];
  let receiver: string | null = null;

  // `Catalog.find product` names an operation on an imported module.
  const first = cursor.peek();
  if (isTypeName(first) && cursor.peek(1)?.value === '.') {
    cursor.next();
    cursor.next();
    receiver = first!.raw;
  }

  while (!cursor.breaksPhrase(cursor.peek())) {
    words.push(cursor.next()!.raw);
  }
  if (words.length === 0) {
    reporter.error('AIL1305', 'expected the name of an operation to call', cursor.currentSpan());
  }
  const args = cursor.eatWord('with') ? parseArguments(cursor, reporter) : [];
  return { kind: 'call', receiver, operation: words.join(' '), arguments: args, span: cursor.spanOf(anchor) };
}

function parseReferenceOrCall(cursor: TokenCursor, reporter: ParseReporter): IRExpression {
  const start = cursor.index;
  const anchor = cursor.peek()!;

  // A dotted path is always a value reference: `order.status`, `command.orderId`.
  const path: string[] = [cursor.next()!.raw];
  while (cursor.atPunct('.')) {
    cursor.next();
    const part = cursor.peek();
    if (part?.kind !== 'word') {
      reporter.error('AIL1306', 'expected a field name after "."', cursor.currentSpan());
      break;
    }
    cursor.next();
    path.push(part.raw);
  }
  if (path.length > 1) return { kind: 'reference', path, span: cursor.spanOf(anchor) };

  // One lower-case word is a value. Two or more in a row name an operation.
  const continuesPhrase = !cursor.breaksPhrase(cursor.peek()) && !isTypeName(cursor.peek());
  if (continuesPhrase || cursor.atWord('with')) {
    cursor.reset(start);
    return parseCall(cursor, reporter, anchor);
  }

  return { kind: 'reference', path, span: cursor.spanOf(anchor) };
}

/** `name = expression, other = expression` — trailing commas are allowed. */
export function parseArguments(cursor: TokenCursor, reporter: ParseReporter): IRArgument[] {
  const args: IRArgument[] = [];
  for (;;) {
    const nameToken = cursor.peek();
    if (nameToken?.kind !== 'word') {
      if (args.length === 0) reporter.error('AIL1307', 'expected an argument name after "with"', cursor.currentSpan());
      break;
    }
    cursor.next();
    if (!cursor.eatPunct('=') && !cursor.eatWord('as', 'is')) {
      reporter.error(
        'AIL1308',
        `expected "=" after the argument name "${nameToken.raw}"`,
        cursor.spanOf(nameToken),
        'arguments are written as "with amount = 10, currency = \\"EUR\\""',
      );
      break;
    }
    args.push({ name: nameToken.raw, value: parseOr(cursor, reporter) });
    if (!cursor.eatPunct(',')) break;
  }
  return args;
}
