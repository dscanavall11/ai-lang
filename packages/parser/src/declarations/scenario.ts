/**
 * The `## scenario` declaration — an executable example.
 *
 *   ## scenario placing a draft order
 *
 *   given order be Order with id = "o-1", status = Draft, items = [ ... ]
 *   when place order with command = PlaceOrder with orderId = "o-1"
 *   then order.status is Placed
 *   and it publishes OrderPlaced
 *
 * `given` and `when` reuse the `let` form exactly, so a scenario reads like the
 * body it exercises rather than like a testing framework.
 */
import { pascalCase, type IRDeclaration, type IRExpression } from '@haic/core';
import { parseExpression } from '../expression-parser.js';
import type { ParseReporter } from '../reporter.js';
import type { Line } from '../source.js';
import { isTypeName, TokenCursor } from '../tokens.js';
import type { DeclarationParser } from './registry.js';
import { read, type ParsedSection } from './shared.js';

type Scenario = Extract<IRDeclaration, { kind: 'scenario' }>;

export const scenarioParser: DeclarationParser = {
  keywords: ['scenario', 'example'],

  parse(section, reporter) {
    const parsed = read(section);
    const given: Scenario['given'] = [];
    const expectations: Scenario['expectations'] = [];
    let when: Scenario['when'] | null = null;

    for (const line of parsed.attributes) {
      const cursor = TokenCursor.forLine(section.file, line);
      const span = section.file.spanOf(line);

      if (cursor.eatWord('given')) {
        const bound = binding(cursor, reporter, line, section.name);
        if (bound) given.push({ binding: bound.name, value: bound.value, span });
        continue;
      }
      if (cursor.eatWord('when')) {
        if (when) {
          reporter.error(
            'HADL1050',
            `scenario ${section.name} has more than one "when"`,
            span,
            'a scenario exercises exactly one operation; split it into two scenarios',
          );
          continue;
        }
        const bound = binding(cursor, reporter, line, section.name);
        if (bound) when = { binding: bound.name, call: bound.value, span };
        continue;
      }
      // `and` continues whichever section it follows: another thing to seed
      // before the operation, another thing to assert after it.
      if (cursor.eatWord('and') && when === null && looksLikeBinding(cursor)) {
        const bound = binding(cursor, reporter, line, section.name);
        if (bound) given.push({ binding: bound.name, value: bound.value, span });
        continue;
      }
      cursor.reset(0);

      if (cursor.eatWord('then') || cursor.eatWord('and')) {
        const expectation = parseExpectation(cursor, reporter, span);
        if (expectation) expectations.push(expectation);
        continue;
      }
    }

    if (!when) {
      reporter.error(
        'HADL1051',
        `scenario ${section.name} never says what it exercises`,
        section.span,
        'add a line "when <operation> with <arguments>"',
      );
      return null;
    }
    if (expectations.length === 0) {
      reporter.error(
        'HADL1052',
        `scenario ${section.name} asserts nothing`,
        section.span,
        'add "then <condition>", "then it fails with <Error>" or "then it publishes <Event>"',
      );
      return null;
    }

    const declaration: Scenario = {
      kind: 'scenario',
      name: pascalCase(section.name) || 'Scenario',
      given,
      when,
      expectations,
      span: section.span,
    };
    // The heading reads as prose, so it is kept verbatim for the runner to print.
    declaration.description = [section.name, parsed.description.trim()].filter(Boolean).join('\n\n');
    return declaration;
  },
};

/** `<name> be ...` — the shape that says this step introduces a value. */
function looksLikeBinding(cursor: TokenCursor): boolean {
  const first = cursor.peek();
  return first?.kind === 'word' && !isTypeName(first) && cursor.peek(1)?.value === 'be';
}

/** `<name> be <expression>`, or a bare expression bound to `result`. */
function binding(
  cursor: TokenCursor,
  reporter: ParseReporter,
  line: Line,
  scenario: string,
): { name: string; value: IRExpression } | null {
  const start = cursor.index;
  const first = cursor.peek();

  if (first?.kind === 'word' && !isTypeName(first) && cursor.peek(1)?.value === 'be') {
    cursor.next();
    cursor.next();
    return { name: first.raw, value: parseExpression(cursor, reporter) };
  }

  cursor.reset(start);
  const value = parseExpression(cursor, reporter);
  if (value.kind === 'literal' && value.value === null) {
    reporter.error('HADL1053', `scenario ${scenario} has an empty step`, cursor.spanOf(cursor.peek()), 'write "given <name> be <value>"');
    return null;
  }
  void line;
  return { name: 'result', value };
}

function parseExpectation(cursor: TokenCursor, reporter: ParseReporter, span: Scenario['span']): Scenario['expectations'][number] | null {
  // `it fails with X` and `it publishes X` are the two outcomes a condition
  // cannot express, because both stop the operation before it returns.
  if (cursor.eatPhrase('it', 'fails', 'with') || cursor.eatPhrase('it', 'fails')) {
    const token = cursor.peek();
    if (!isTypeName(token)) {
      reporter.error('HADL1054', 'expected the name of a declared error after "fails with"', cursor.currentSpan());
      return null;
    }
    cursor.next();
    return { kind: 'fails', error: token!.raw, span };
  }
  if (cursor.eatPhrase('it', 'publishes') || cursor.eatPhrase('it', 'emits')) {
    const token = cursor.peek();
    if (!isTypeName(token)) {
      reporter.error('HADL1055', 'expected the name of a declared event after "publishes"', cursor.currentSpan());
      return null;
    }
    cursor.next();
    return { kind: 'publishes', event: token!.raw, span };
  }
  return { kind: 'holds', condition: parseExpression(cursor, reporter), span };
}

/** Kept for symmetry with the other declaration parsers. */
export type { ParsedSection };
