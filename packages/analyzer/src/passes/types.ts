/**
 * Statement-level type checking.
 *
 * Walks every operation body, threading a lexical scope, and records which
 * checked errors each body propagates so the error-flow pass can verify the
 * declared contract.
 */
import {
  camelCase,
  elementType,
  isOrderable,
  typeToString,
  unwrap,
  type IRDeclaration,
  type IRExpression,
  type IROperation,
  type IRStatement,
  type IRType,
  type SourceSpan,
} from '@haic/core';
import type { AnalysisContext, SemanticPass } from '../context.js';
import { Scope, withSuggestion } from '../context.js';
import { BOOLEAN, TypeChecker, UNKNOWN } from '../type-checker.js';

export const typePass: SemanticPass = {
  id: 'types',
  stage: 'type',
  run(context) {
    const fallback = fallbackSpan(context);
    const checker = new TypeChecker(context, fallback);

    for (const declaration of context.module.declarations) {
      if (declaration.kind === 'service' || declaration.kind === 'adapter') {
        for (const operation of declaration.operations) {
          checkOperation(context, checker, declaration, operation, new Scope());
        }
      }
      if (declaration.kind === 'aggregate') {
        for (const operation of declaration.operations) {
          checkOperation(context, checker, declaration, operation, checker.scopeForAggregate(declaration));
        }
        checkInvariants(context, checker, declaration);
      }
      if (declaration.kind === 'entity' || declaration.kind === 'value-object') {
        checkInvariants(context, checker, declaration);
      }
      if (declaration.kind === 'query') {
        checkQuery(context, checker, declaration);
      }
      if (declaration.kind === 'handler') {
        checker.enterDeclaration(declaration);
        const scope = new Scope();
        const payload = checker.lookup(declaration.on);
        if (payload && 'fields' in payload) scope.define('event', { kind: 'named', name: payload.name });
        checkBlock(context, checker, declaration.body, scope, { kind: 'primitive', name: 'nothing' }, declaration.span ?? fallback);
        context.raisedErrors.set(declaration.name, new Set(checker.propagatedErrors));
      }
    }
  },
};

function checkOperation(
  context: AnalysisContext,
  checker: TypeChecker,
  owner: IRDeclaration,
  operation: IROperation,
  baseScope: Scope,
): void {
  checker.enterDeclaration(owner);
  const scope = baseScope.child();
  for (const parameter of operation.parameters) scope.define(parameter.name, parameter.type);

  const expected = operation.returns.kind === 'result' ? operation.returns.ok : operation.returns;
  const span = operation.span ?? fallbackSpan(context);
  checkBlock(context, checker, operation.body, scope, expected, span);

  const key = `${owner.name}.${operation.phrase}`;
  context.raisedErrors.set(key, new Set(checker.propagatedErrors));

  if (!isNothing(expected) && operation.body.length > 0 && !alwaysReturns(operation.body)) {
    context.diagnostics.error(
      'type',
      'HADL2120',
      `${key} must return ${typeToString(expected)} on every path`,
      span,
      { hint: 'add a "return" at the end, or make every branch return or fail' },
    );
  }
}

function checkInvariants(
  context: AnalysisContext,
  checker: TypeChecker,
  declaration: Extract<IRDeclaration, { invariants: unknown[] }>,
): void {
  checker.enterDeclaration(declaration);
  const scope = new Scope();
  for (const field of declaration.fields) scope.define(field.name, field.type);

  for (const invariant of declaration.invariants) {
    const type = checker.infer(invariant.condition, scope);
    if (type !== UNKNOWN && !checker.compatible(BOOLEAN, type)) {
      context.diagnostics.error(
        'type',
        'HADL2121',
        `invariant "${invariant.description}" must be a yes/no condition, but it is ${typeToString(type)}`,
        invariant.span ?? declaration.span ?? fallbackSpan(context),
      );
    }
    if (invariant.raises) {
      const error = checker.lookup(invariant.raises);
      if (error?.kind !== 'error') {
        context.diagnostics.error(
          'type',
          'HADL2122',
          `invariant "${invariant.description}" raises "${invariant.raises}", which is not a declared error`,
          invariant.span ?? declaration.span ?? fallbackSpan(context),
        );
      }
    }
  }
}

/**
 * A query's criteria are checked against two things at once: the aggregate it
 * selects from, bound to its own name, and the parameters the caller supplies.
 */
function checkQuery(context: AnalysisContext, checker: TypeChecker, query: Extract<IRDeclaration, { kind: 'query' }>): void {
  const span = query.span ?? fallbackSpan(context);
  const subject = checker.lookup(query.over);

  if (subject?.kind !== 'aggregate') {
    context.diagnostics.error(
      'type',
      'HADL2150',
      `query ${query.name} selects from "${query.over}", which is not an aggregate`,
      span,
      { hint: withSuggestion('', query.over, context.index.aggregates.map((a) => a.name)) ?? 'a query filters one aggregate' },
    );
    return;
  }

  checker.enterDeclaration(query);
  const scope = new Scope();
  scope.define(camelCase(subject.name), { kind: 'named', name: subject.name });
  // A criterion runs only when its parameters are present, so inside one an
  // optional parameter is never absent and compares against a plain field.
  for (const parameter of query.fields) {
    scope.define(parameter.name, parameter.type.kind === 'optional' ? parameter.type.of : parameter.type);
  }

  for (const criterion of query.criteria) {
    const type = checker.infer(criterion.condition, scope);
    if (type !== UNKNOWN && !checker.compatible(BOOLEAN, type)) {
      context.diagnostics.error(
        'type',
        'HADL2151',
        `a criterion must be a yes/no condition, but this is ${typeToString(type)}`,
        criterion.span ?? span,
      );
    }
  }

  for (const entry of query.sort) {
    const type = checker.infer({ kind: 'reference', path: entry.path, span: query.span }, scope);
    if (type === UNKNOWN) continue;
    if (!isOrderable(type)) {
      context.diagnostics.error(
        'type',
        'HADL2152',
        `cannot sort by ${entry.path.join('.')}: ${typeToString(type)} has no order`,
        span,
        { hint: 'sort by a number, a timestamp or a date' },
      );
    }
  }

  // A parameter nothing filters on is a knob with nothing behind it.
  for (const parameter of query.fields) {
    if (query.criteria.some((c) => c.guards.includes(parameter.name))) continue;
    context.diagnostics.warn(
      'type',
      'HADL2153',
      `query ${query.name} takes "${parameter.name}" but no criterion reads it`,
      parameter.span ?? span,
      { hint: `add "match ${camelCase(subject.name)}.<field> is ${parameter.name}", or drop the parameter` },
    );
  }
}

function checkBlock(
  context: AnalysisContext,
  checker: TypeChecker,
  statements: readonly IRStatement[],
  scope: Scope,
  expectedReturn: IRType,
  span: SourceSpan,
): void {
  for (const statement of statements) {
    checkStatement(context, checker, statement, scope, expectedReturn, span);
  }
}

function checkStatement(
  context: AnalysisContext,
  checker: TypeChecker,
  statement: IRStatement,
  scope: Scope,
  expectedReturn: IRType,
  span: SourceSpan,
): void {
  switch (statement.kind) {
    case 'let': {
      if (scope.has(statement.name)) {
        context.diagnostics.error('type', 'HADL2123', `"${statement.name}" is already defined`, statement.span ?? span, {
          hint: 'pick another name; HADL does not allow shadowing inside an operation',
        });
      }
      scope.define(statement.name, checker.infer(statement.value, scope));
      return;
    }

    case 'set': {
      const target = resolvePath(checker, statement.target, scope, statement.span ?? span, context);
      const value = checker.infer(statement.value, scope);
      if (target && !checker.compatible(target.type, value)) {
        context.diagnostics.error(
          'type',
          'HADL2124',
          `cannot assign ${typeToString(value)} to ${statement.target.join('.')} of type ${typeToString(target.type)}`,
          statement.span ?? span,
        );
      }
      if (target?.immutable) {
        context.diagnostics.error(
          'type',
          'HADL2125',
          `${statement.target.join('.')} is immutable`,
          statement.span ?? span,
          { hint: 'build a new value instead of changing this one' },
        );
      }
      return;
    }

    case 'perform': {
      const type = checker.infer(statement.value, scope);
      if (statement.value.kind !== 'call') {
        context.diagnostics.error('type', 'HADL2126', '"perform" needs an operation call', statement.span ?? span);
      } else if (!isNothing(type) && type !== UNKNOWN) {
        context.diagnostics.warn(
          'type',
          'HADL2127',
          `the result of "${statement.value.operation}" is discarded`,
          statement.span ?? span,
          { hint: `bind it with "let ... be ${statement.value.operation} ..." if you need it` },
        );
      }
      return;
    }

    case 'when': {
      const condition = checker.infer(statement.condition, scope);
      if (condition !== UNKNOWN && !checker.compatible(BOOLEAN, condition)) {
        context.diagnostics.error(
          'type',
          'HADL2128',
          `"when" needs a yes/no condition, but this is ${typeToString(condition)}`,
          statement.span ?? span,
        );
      }
      // `when x is present:` makes `x` non-optional for the length of the branch.
      const narrowed = narrowing(statement.condition, scope);
      const thenScope = scope.child();
      const otherwiseScope = scope.child();
      if (narrowed) {
        (narrowed.whenTrue ? thenScope : otherwiseScope).define(narrowed.name, narrowed.type);
      }
      checkBlock(context, checker, statement.then, thenScope, expectedReturn, span);
      checkBlock(context, checker, statement.otherwise, otherwiseScope, expectedReturn, span);
      return;
    }

    case 'for-each': {
      const collection = checker.infer(statement.collection, scope);
      const element = elementType(collection);
      if (!element) {
        context.diagnostics.error(
          'type',
          'HADL2129',
          `"for each" needs a list, but ${typeToString(collection)} is not one`,
          statement.span ?? span,
        );
        return;
      }
      const inner = scope.child();
      inner.define(statement.item, element);
      checkBlock(context, checker, statement.body, inner, expectedReturn, span);
      return;
    }

    case 'fail': {
      const error = checker.lookup(statement.error);
      if (error?.kind !== 'error') {
        context.diagnostics.error('type', 'HADL2130', `"${statement.error}" is not a declared error`, statement.span ?? span, {
          hint: withSuggestion('', statement.error, checker.index.errors.map((e) => e.name)) ?? 'declare it with "## error <Name> (checked, status 4xx)"',
        });
        return;
      }
      checker.propagatedErrors.add(error.name);
      const expected = error.fields.map((f) => ({ name: f.name, type: f.type, required: f.required }));
      for (const argument of statement.arguments) {
        const match = expected.find((e) => e.name === argument.name);
        const actual = checker.infer(argument.value, scope);
        if (!match) {
          context.diagnostics.error('type', 'HADL2131', `error ${error.name} has no field "${argument.name}"`, statement.span ?? span);
        } else if (!checker.compatible(match.type, actual)) {
          context.diagnostics.error(
            'type',
            'HADL2132',
            `"${argument.name}" expects ${typeToString(match.type)} but received ${typeToString(actual)}`,
            statement.span ?? span,
          );
        }
      }
      const missing = expected.filter((e) => e.required && !statement.arguments.some((a) => a.name === e.name));
      if (missing.length > 0) {
        context.diagnostics.error(
          'type',
          'HADL2133',
          `error ${error.name} needs ${missing.map((m) => `"${m.name}"`).join(', ')}`,
          statement.span ?? span,
          { hint: `write "fail with ${error.name} using ${missing.map((m) => `${m.name} = ...`).join(', ')}"` },
        );
      }
      return;
    }

    case 'publish': {
      const event = checker.lookup(statement.event);
      if (event?.kind !== 'event') {
        context.diagnostics.error('type', 'HADL2134', `"${statement.event}" is not a declared event`, statement.span ?? span, {
          hint: withSuggestion('', statement.event, checker.index.events.map((e) => e.name)),
        });
        return;
      }
      const expected = event.fields.map((f) => ({ name: f.name, type: f.type, required: f.required }));
      for (const argument of statement.arguments) {
        const match = expected.find((e) => e.name === argument.name);
        const actual = checker.infer(argument.value, scope);
        if (!match) {
          context.diagnostics.error('type', 'HADL2135', `event ${event.name} has no field "${argument.name}"`, statement.span ?? span);
        } else if (!checker.compatible(match.type, actual)) {
          context.diagnostics.error(
            'type',
            'HADL2136',
            `"${argument.name}" expects ${typeToString(match.type)} but received ${typeToString(actual)}`,
            statement.span ?? span,
          );
        }
      }
      const missing = expected.filter((e) => e.required && !statement.arguments.some((a) => a.name === e.name));
      if (missing.length > 0) {
        context.diagnostics.error(
          'type',
          'HADL2137',
          `event ${event.name} needs ${missing.map((m) => `"${m.name}"`).join(', ')}`,
          statement.span ?? span,
        );
      }
      return;
    }

    case 'append':
    case 'remove': {
      const target = resolvePath(checker, statement.collection, scope, statement.span ?? span, context);
      if (!target) return;
      const element = elementType(target.type);
      if (!element) {
        context.diagnostics.error(
          'type',
          'HADL2138',
          `${statement.collection.join('.')} is ${typeToString(target.type)}, not a list`,
          statement.span ?? span,
        );
        return;
      }
      const value = checker.infer(statement.value, scope);
      if (!checker.compatible(element, value)) {
        context.diagnostics.error(
          'type',
          'HADL2139',
          `${statement.collection.join('.')} holds ${typeToString(element)}, not ${typeToString(value)}`,
          statement.span ?? span,
        );
      }
      return;
    }

    case 'return': {
      if (!statement.value) {
        if (!isNothing(expectedReturn)) {
          context.diagnostics.error(
            'type',
            'HADL2140',
            `this operation must return ${typeToString(expectedReturn)}`,
            statement.span ?? span,
          );
        }
        return;
      }
      const actual = checker.infer(statement.value, scope);
      if (!checker.compatible(expectedReturn, actual)) {
        context.diagnostics.error(
          'type',
          'HADL2141',
          `this operation returns ${typeToString(expectedReturn)} but the value is ${typeToString(actual)}`,
          statement.span ?? span,
        );
      }
      return;
    }
  }
}

interface Narrowing {
  name: string;
  type: IRType;
  /** Which branch the narrowing applies to. */
  whenTrue: boolean;
}

/**
 * Recognises the presence tests that make an optional safe to use.
 * Only a bare local is narrowed: narrowing `a.b.c` would need alias analysis to
 * stay sound, and the honest workaround — bind it with `let` — is one line.
 */
function narrowing(condition: IRExpression, scope: Scope): Narrowing | null {
  if (condition.kind !== 'unary') return null;
  if (condition.operator !== 'is-present' && condition.operator !== 'is-absent') return null;
  if (condition.operand.kind !== 'reference' || condition.operand.path.length !== 1) return null;

  const name = condition.operand.path[0]!;
  const current = scope.lookup(name);
  if (current?.kind !== 'optional') return null;
  return { name, type: current.of, whenTrue: condition.operator === 'is-present' };
}

interface ResolvedPath {
  type: IRType;
  immutable: boolean;
}

function resolvePath(
  checker: TypeChecker,
  path: readonly string[],
  scope: Scope,
  span: SourceSpan,
  context: AnalysisContext,
): ResolvedPath | null {
  const [head, ...rest] = path;
  if (head === undefined) return null;
  let current = scope.lookup(head);
  if (current === undefined) {
    context.diagnostics.error('type', 'HADL2142', `"${head}" is not defined here`, span, {
      hint: withSuggestion('', head, scope.names()),
    });
    return null;
  }
  let immutable = false;
  for (const part of rest) {
    const inner = unwrap(current);
    if (inner.kind !== 'named') {
      context.diagnostics.error('type', 'HADL2143', `${typeToString(inner)} has no field "${part}"`, span);
      return null;
    }
    const declaration = checker.lookup(inner.name);
    const fields = declaration && 'fields' in declaration ? declaration.fields : null;
    const field = fields?.find((f) => f.name === part);
    if (!field) {
      context.diagnostics.error('type', 'HADL2144', `${inner.name} has no field "${part}"`, span, {
        hint: withSuggestion('', part, fields?.map((f) => f.name) ?? []),
      });
      return null;
    }
    immutable =
      declaration?.kind === 'value-object' ||
      field.constraints.some((c) => c.kind === 'immutable') ||
      field.identity;
    current = field.type;
  }
  return { type: current, immutable };
}

/** `true` when every path through the block ends in a return or a fail. */
function alwaysReturns(statements: readonly IRStatement[]): boolean {
  for (const statement of statements) {
    if (statement.kind === 'return' || statement.kind === 'fail') return true;
    if (statement.kind === 'when' && statement.otherwise.length > 0) {
      if (alwaysReturns(statement.then) && alwaysReturns(statement.otherwise)) return true;
    }
  }
  return false;
}

function isNothing(type: IRType): boolean {
  const inner = unwrap(type);
  return inner.kind === 'primitive' && inner.name === 'nothing';
}

function fallbackSpan(context: AnalysisContext): SourceSpan {
  const file = context.module.source?.file ?? '<unknown>';
  return { file, start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } };
}
