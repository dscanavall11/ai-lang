/**
 * The `## query` declaration — a named filter over one aggregate.
 *
 *   ## query OrdersForCustomer over Order
 *
 *   - customerId: uuid, required
 *   - placedAfter: timestamp, optional
 *
 *   match order.customerId is customerId
 *   match order.placedAt is at least placedAfter
 *
 *   sort by order.placedAt descending
 *   limit 50
 *
 * The aggregate is bound to its own name in lower camel case, so the two sides
 * of a criterion never look alike even when they share a field name.
 */
import { camelCase, type IRDeclaration, type IRExpression } from '@ai-lang/core';
import { parseExpression } from '../expression-parser.js';
import type { ParseReporter } from '../reporter.js';
import type { Line } from '../source.js';
import { TokenCursor } from '../tokens.js';
import type { DeclarationParser } from './registry.js';
import { fieldsOf, read, type ParsedSection } from './shared.js';

export const queryParser: DeclarationParser = {
  keywords: ['query', 'specification'],

  parse(section, reporter) {
    const parsed = read(section);
    const over = /\bover\s+([A-Z][A-Za-z0-9_]*)/.exec(section.modifiers)?.[1];
    if (!over) {
      reporter.error(
        'AIL1040',
        `query ${section.name} does not say what it selects from`,
        section.span,
        'write "## query OrdersForCustomer over Order"',
      );
      return null;
    }

    const fields = fieldsOf(parsed, reporter);
    const criteria = criteriaOf(parsed, fields.map((f) => f.name), camelCase(over), reporter);
    if (criteria.length === 0) {
      reporter.error(
        'AIL1041',
        `query ${section.name} has no criteria`,
        section.span,
        `write "match ${camelCase(over)}.<field> is <parameter>" for each condition`,
      );
      return null;
    }

    const declaration: IRDeclaration = {
      kind: 'query',
      name: section.name,
      over,
      fields,
      criteria,
      sort: sortOf(parsed, reporter),
    };
    const limit = limitOf(parsed, reporter);
    if (limit !== null) declaration.limit = limit;
    if (parsed.description.trim().length > 0) declaration.description = parsed.description.trim();
    return declaration;
  },
};

type Criterion = Extract<IRDeclaration, { kind: 'query' }>['criteria'][number];

function criteriaOf(parsed: ParsedSection, parameters: readonly string[], subject: string, reporter: ParseReporter): Criterion[] {
  const criteria: Criterion[] = [];

  for (const line of matching(parsed, /^match\s+/i)) {
    const offset = /^match\s+/i.exec(line.text)![0].length;
    const cursor = new TokenCursor(
      TokenCursor.forLine(parsed.section.file, { ...line, text: line.text.slice(offset) }).tokens,
      line,
      parsed.section.file,
    );
    const condition = parseExpression(cursor, reporter);

    // A criterion that reads no optional parameter always applies; one that does
    // is skipped when the caller leaves that parameter out.
    const guards = parameters.filter((name) => mentions(condition, name));
    if (!mentions(condition, subject)) {
      reporter.error(
        'AIL1042',
        `this criterion never mentions "${subject}"`,
        parsed.section.file.spanOf(line),
        `compare a field of the aggregate against a parameter: "match ${subject}.<field> is <parameter>"`,
      );
      continue;
    }
    criteria.push({ condition, guards, span: parsed.section.file.spanOf(line) });
  }
  return criteria;
}

function sortOf(parsed: ParsedSection, reporter: ParseReporter): Extract<IRDeclaration, { kind: 'query' }>['sort'] {
  const sort: Extract<IRDeclaration, { kind: 'query' }>['sort'] = [];

  for (const line of matching(parsed, /^sort\s+by\s+/i)) {
    const tail = line.text.replace(/^sort\s+by\s+/i, '');
    for (const part of tail.split(',')) {
      const match = /^([A-Za-z_][\w.]*)\s*(ascending|descending|asc|desc)?$/.exec(part.trim());
      if (!match) {
        reporter.error(
          'AIL1043',
          `expected "<path> ascending" or "<path> descending", found "${part.trim()}"`,
          parsed.section.file.spanOf(line),
        );
        continue;
      }
      const direction = /^desc/i.test(match[2] ?? 'ascending') ? 'descending' : 'ascending';
      sort.push({ path: match[1]!.split('.'), direction });
    }
  }
  return sort;
}

function limitOf(parsed: ParsedSection, reporter: ParseReporter): number | null {
  const line = matching(parsed, /^limit\s+/i)[0];
  if (!line) return null;
  const value = Number(line.text.replace(/^limit\s+/i, '').trim());
  if (!Number.isInteger(value) || value < 1) {
    reporter.error('AIL1044', 'limit must be a positive whole number', parsed.section.file.spanOf(line));
    return null;
  }
  return value;
}

function matching(parsed: ParsedSection, pattern: RegExp): Line[] {
  return parsed.attributes.filter((line) => pattern.test(line.text));
}

/** `true` when `name` appears as the head of any reference in the expression. */
function mentions(expression: IRExpression, name: string): boolean {
  switch (expression.kind) {
    case 'reference':
      return expression.path[0] === name;
    case 'binary':
      return mentions(expression.left, name) || mentions(expression.right, name);
    case 'unary':
      return mentions(expression.operand, name);
    case 'call':
    case 'construct':
      return expression.arguments.some((a) => mentions(a.value, name));
    case 'aggregate':
      return mentions(expression.collection, name) || (expression.of !== null && mentions(expression.of, name));
    default:
      return false;
  }
}
