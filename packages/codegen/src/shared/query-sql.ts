/**
 * Query criteria into SQL fragments.
 *
 * SQL is the same language in all five backends, so the WHERE clause is built
 * once here. A backend only decides how to bind a parameter and how to append a
 * guarded fragment — a dozen lines each, instead of a query compiler each.
 */
import { snakeCase, type BinaryOperator, type IRExpression, type IRQueryDecl } from '@haic/core';

export interface SqlFragment {
  /** `customer_id = ?` with one placeholder per bound parameter. */
  sql: string;
  /** Query parameters bound by this fragment, in placeholder order. */
  bindings: string[];
  /**
   * Optional parameters this fragment reads. When any is absent the fragment is
   * left out, which is what makes one query cover several filters.
   */
  guards: string[];
}

export interface CompiledQuery {
  fragments: SqlFragment[];
  /** `placed_at DESC, id ASC`, or null when the query states no order. */
  orderBy: string | null;
  limit: number | null;
  /** Criteria the compiler could not express, reported rather than guessed. */
  unsupported: string[];
}

export function compileQuery(query: IRQueryDecl, subject: string): CompiledQuery {
  const fragments: SqlFragment[] = [];
  const unsupported: string[] = [];
  const optional = new Set(query.fields.filter((f) => !f.required).map((f) => f.name));

  for (const criterion of query.criteria) {
    const bindings: string[] = [];
    const sql = renderCondition(criterion.condition, subject, bindings);
    if (sql === null) {
      unsupported.push(describe(criterion.condition));
      continue;
    }
    fragments.push({ sql, bindings, guards: criterion.guards.filter((g) => optional.has(g)) });
  }

  const orderBy =
    query.sort.length > 0
      ? query.sort.map((entry) => `${column(entry.path, subject)} ${entry.direction === 'descending' ? 'DESC' : 'ASC'}`).join(', ')
      : null;

  return { fragments, orderBy, limit: query.limit ?? null, unsupported };
}

const COMPARISONS: Partial<Record<BinaryOperator, string>> = {
  equals: '=',
  'not-equals': '<>',
  'greater-than': '>',
  'greater-or-equal': '>=',
  'less-than': '<',
  'less-or-equal': '<=',
};

/** Returns null when the condition has no faithful SQL form. */
function renderCondition(expression: IRExpression, subject: string, bindings: string[]): string | null {
  switch (expression.kind) {
    case 'binary': {
      if (expression.operator === 'and' || expression.operator === 'or') {
        const left = renderCondition(expression.left, subject, bindings);
        const right = renderCondition(expression.right, subject, bindings);
        if (left === null || right === null) return null;
        return `(${left} ${expression.operator.toUpperCase()} ${right})`;
      }
      const comparison = COMPARISONS[expression.operator];
      if (comparison) {
        const left = renderOperand(expression.left, subject, bindings);
        const right = renderOperand(expression.right, subject, bindings);
        return left === null || right === null ? null : `${left} ${comparison} ${right}`;
      }
      if (expression.operator === 'contains' || expression.operator === 'starts-with' || expression.operator === 'ends-with') {
        const left = renderOperand(expression.left, subject, bindings);
        const right = renderOperand(expression.right, subject, bindings);
        if (left === null || right === null) return null;
        const pattern =
          expression.operator === 'contains' ? `'%' || ${right} || '%'` : expression.operator === 'starts-with' ? `${right} || '%'` : `'%' || ${right}`;
        return `${left} LIKE ${pattern}`;
      }
      return null;
    }

    case 'unary': {
      const operand = renderOperand(expression.operand, subject, bindings);
      if (operand === null) return null;
      switch (expression.operator) {
        case 'is-present':
          return `${operand} IS NOT NULL`;
        case 'is-absent':
          return `${operand} IS NULL`;
        case 'not': {
          const inner = renderCondition(expression.operand, subject, bindings);
          return inner === null ? null : `NOT (${inner})`;
        }
        default:
          return null;
      }
    }

    default:
      return null;
  }
}

function renderOperand(expression: IRExpression, subject: string, bindings: string[]): string | null {
  switch (expression.kind) {
    case 'reference': {
      // A path rooted at the aggregate is a column; anything else is a parameter.
      if (expression.path[0] === subject) return column(expression.path.slice(1), subject);
      if (expression.path.length === 1) {
        bindings.push(expression.path[0]!);
        return '?';
      }
      return null;
    }
    case 'literal':
      if (expression.value === null) return 'NULL';
      if (typeof expression.value === 'string') return `'${expression.value.replace(/'/g, "''")}'`;
      if (typeof expression.value === 'boolean') return expression.value ? 'TRUE' : 'FALSE';
      return String(expression.value);
    default:
      return null;
  }
}

/** `order.placedAt` becomes `placed_at`; a nested path becomes a JSON access. */
function column(path: readonly string[], subject: string): string {
  const parts = path[0] === subject ? path.slice(1) : path;
  if (parts.length === 1) return snakeCase(parts[0]!);
  return `data->>'${parts.join("'->>'")}'`;
}

function describe(expression: IRExpression): string {
  return expression.kind === 'binary' ? `a "${expression.operator}" comparison` : `a ${expression.kind} expression`;
}
