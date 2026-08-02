/**
 * Type inference and checking for operation bodies.
 *
 * The rules that make the language feel natural but stay sound:
 *   - a call to an operation returning `T or E1, E2` binds a value of type `T`
 *     and propagates `E1, E2` to the enclosing operation's contract;
 *   - a bare capitalised name resolves to an enum member;
 *   - member access walks the fields of the named declaration.
 */
import {
  elementType,
  isNumeric,
  isOrderable,
  normalisePhrase,
  typeEquals,
  typeToString,
  unwrap,
  type IRAggregateDecl,
  type IRArgument,
  type IRDeclaration,
  type IRExpression,
  type IRField,
  type IROperationSignature,
  type IRType,
  type ModuleIndex,
  type SourceSpan,
} from '@ai-lang/core';
import { camelCase } from '@ai-lang/core';
import type { AnalysisContext } from './context.js';
import { Scope, withSuggestion } from './context.js';

const TEXT: IRType = { kind: 'primitive', name: 'text' };
const BOOLEAN: IRType = { kind: 'primitive', name: 'boolean' };
const DECIMAL: IRType = { kind: 'primitive', name: 'decimal' };
const INTEGER: IRType = { kind: 'primitive', name: 'integer' };
const TIMESTAMP: IRType = { kind: 'primitive', name: 'timestamp' };
const UUID: IRType = { kind: 'primitive', name: 'uuid' };
const NOTHING: IRType = { kind: 'primitive', name: 'nothing' };
/** Assigned when inference already reported an error, to avoid cascades. */
export const UNKNOWN: IRType = { kind: 'primitive', name: 'json' };

export interface Callable {
  signature: IROperationSignature;
  owner: IRDeclaration;
  /** Argument that carries the receiver when the owner is an aggregate. */
  receiverParameter: string | null;
}

export class TypeChecker {
  /** Errors raised by calls in the body currently being checked. */
  readonly propagatedErrors = new Set<string>();

  private readonly callables = new Map<string, Callable[]>();

  constructor(
    private readonly context: AnalysisContext,
    private readonly fallbackSpan: SourceSpan,
  ) {}

  /** Rebuilds the call table for the declaration whose body is about to be checked. */
  enterDeclaration(owner: IRDeclaration): void {
    this.callables.clear();
    this.propagatedErrors.clear();

    const uses = 'uses' in owner ? owner.uses : [];
    for (const portName of uses) {
      const port = this.lookup(portName);
      if (port?.kind !== 'port') continue;
      for (const signature of port.operations) this.addCallable(signature, port, null);
    }
    if (owner.kind === 'service' || owner.kind === 'adapter' || owner.kind === 'aggregate') {
      for (const operation of owner.operations) this.addCallable(operation, owner, null);
    }
    // Aggregate behaviour is reachable by naming the aggregate instance as an argument.
    for (const aggregate of this.context.index.aggregates) {
      if (aggregate === owner) continue;
      for (const operation of aggregate.operations) this.addCallable(operation, aggregate, camelCase(aggregate.name));
    }
  }

  private addCallable(signature: IROperationSignature, owner: IRDeclaration, receiverParameter: string | null): void {
    const key = normalisePhrase(signature.phrase);
    const bucket = this.callables.get(key) ?? [];
    bucket.push({ signature, owner, receiverParameter });
    this.callables.set(key, bucket);
  }

  resolveCall(phrase: string): Callable[] {
    return this.callables.get(normalisePhrase(phrase)) ?? [];
  }

  knownPhrases(): string[] {
    return [...this.callables.values()].flat().map((c) => c.signature.phrase);
  }

  lookup(name: string): IRDeclaration | undefined {
    const local = this.context.index.get(name);
    if (local) return local;
    for (const entry of this.context.module.imports) {
      const sibling = this.context.siblings.get(entry.module);
      const found = sibling?.get(name);
      if (found && (entry.names.length === 0 || entry.names.includes(name))) return found;
    }
    return undefined;
  }

  fieldsOf(name: string): IRField[] | null {
    const declaration = this.lookup(name);
    if (!declaration) return null;
    return 'fields' in declaration ? declaration.fields : null;
  }

  // -------------------------------------------------------------------------
  // Inference
  // -------------------------------------------------------------------------

  infer(expression: IRExpression, scope: Scope): IRType {
    switch (expression.kind) {
      case 'literal':
        return expression.type;
      case 'now':
        return TIMESTAMP;
      case 'new-id':
        return UUID;
      case 'reference':
        return this.inferReference(expression, scope);
      case 'unary':
        return this.inferUnary(expression, scope);
      case 'binary':
        return this.inferBinary(expression, scope);
      case 'aggregate':
        return this.inferAggregate(expression, scope);
      case 'construct':
        return this.inferConstruct(expression, scope);
      case 'call':
        return this.inferCall(expression, scope);
    }
  }

  private inferReference(expression: Extract<IRExpression, { kind: 'reference' }>, scope: Scope): IRType {
    const [head, ...rest] = expression.path;
    if (head === undefined) return UNKNOWN;

    let current = scope.lookup(head);
    if (current === undefined) {
      // A capitalised bare name is an enum member, and nothing else. A type name
      // standing alone is a value that does not exist.
      if (/^[A-Z]/.test(head)) {
        const owner = this.context.index.enums.find((e) => e.values.some((v) => v.name === head));
        if (owner) return { kind: 'named', name: owner.name };

        const declaration = this.lookup(head);
        if (declaration) {
          this.error('AIL2149', `${declaration.kind} ${head} is a type, not a value`, expression.span, {
            hint:
              'fields' in declaration
                ? `build one with "${head} with <field> = ..." or "${head} from <source>"`
                : 'name a value here, not a declaration',
          });
          return UNKNOWN;
        }
      }
      this.error('AIL2101', `"${head}" is not defined here`, expression.span, {
        hint: withSuggestion('', head, scope.names()) ?? 'declare it with "let" or add it as a parameter',
      });
      return UNKNOWN;
    }

    for (const part of rest) {
      const inner = unwrap(current);
      if (inner.kind !== 'named') {
        this.error('AIL2102', `"${typeToString(inner)}" has no field "${part}"`, expression.span);
        return UNKNOWN;
      }
      const fields = this.fieldsOf(inner.name);
      if (!fields) {
        // Enum members are reachable as `OrderStatus.Draft`.
        const declaration = this.lookup(inner.name);
        if (declaration?.kind === 'enum' && declaration.values.some((v) => v.name === part)) {
          current = { kind: 'named', name: declaration.name };
          continue;
        }
        this.error('AIL2103', `${inner.name} has no fields`, expression.span);
        return UNKNOWN;
      }
      const field = fields.find((f) => f.name === part);
      if (!field) {
        this.error('AIL2104', `${inner.name} has no field "${part}"`, expression.span, {
          hint: withSuggestion('', part, fields.map((f) => f.name)),
        });
        return UNKNOWN;
      }
      current = field.type;
    }
    return current;
  }

  private inferUnary(expression: Extract<IRExpression, { kind: 'unary' }>, scope: Scope): IRType {
    const operand = this.infer(expression.operand, scope);
    switch (expression.operator) {
      case 'negate':
        this.expectNumeric(operand, expression.span, 'negation');
        return operand;
      case 'not':
        this.expect(operand, BOOLEAN, expression.span, '"not"');
        return BOOLEAN;
      default:
        return BOOLEAN;
    }
  }

  private inferBinary(expression: Extract<IRExpression, { kind: 'binary' }>, scope: Scope): IRType {
    const left = this.infer(expression.left, scope);
    const right = this.infer(expression.right, scope);

    switch (expression.operator) {
      case 'and':
      case 'or':
        this.expect(left, BOOLEAN, expression.span, `"${expression.operator}"`);
        this.expect(right, BOOLEAN, expression.span, `"${expression.operator}"`);
        return BOOLEAN;

      case 'add':
      case 'subtract':
      case 'multiply':
      case 'divide': {
        this.expectNumeric(left, expression.span, 'arithmetic');
        this.expectNumeric(right, expression.span, 'arithmetic');
        const leftInner = unwrap(left);
        const rightInner = unwrap(right);
        const isInteger =
          leftInner.kind === 'primitive' && leftInner.name === 'integer' && rightInner.kind === 'primitive' && rightInner.name === 'integer';
        return expression.operator === 'divide' ? DECIMAL : isInteger ? INTEGER : DECIMAL;
      }

      case 'greater-than':
      case 'greater-or-equal':
      case 'less-than':
      case 'less-or-equal':
        this.expectOrderable(left, expression.span);
        this.expectOrderable(right, expression.span);
        if (!this.compatible(left, right) && !this.compatible(right, left)) {
          this.error(
            'AIL2117',
            `cannot order ${typeToString(left)} against ${typeToString(right)}`,
            expression.span,
          );
        }
        return BOOLEAN;

      case 'equals':
      case 'not-equals':
        if (!this.compatible(left, right)) {
          this.error(
            'AIL2105',
            `cannot compare ${typeToString(left)} with ${typeToString(right)}`,
            expression.span,
            { hint: 'both sides of a comparison must have the same type' },
          );
        }
        return BOOLEAN;

      case 'contains': {
        const element = elementType(left);
        if (element && !this.compatible(element, right)) {
          this.error('AIL2106', `${typeToString(left)} does not hold ${typeToString(right)}`, expression.span);
        }
        return BOOLEAN;
      }

      case 'starts-with':
      case 'ends-with':
      case 'matches':
        this.expect(left, TEXT, expression.span, `"${expression.operator.replace('-', ' ')}"`);
        this.expect(right, TEXT, expression.span, `"${expression.operator.replace('-', ' ')}"`);
        return BOOLEAN;
    }
  }

  private inferAggregate(expression: Extract<IRExpression, { kind: 'aggregate' }>, scope: Scope): IRType {
    const collection = this.infer(expression.collection, scope);
    const element = elementType(collection);
    if (!element) {
      this.error(
        'AIL2107',
        `"${expression.fn}" needs a list, but ${typeToString(collection)} is not one`,
        expression.span,
      );
      return expression.fn === 'count' ? INTEGER : UNKNOWN;
    }
    if (expression.fn === 'count') return INTEGER;

    const inner = expression.of ? this.inferInElementScope(expression.of, scope, element) : element;
    this.expectNumeric(inner, expression.span, `"${expression.fn}"`);
    return expression.fn === 'average' ? DECIMAL : inner;
  }

  /** `sum of items by quantity times unitPrice.amount` — `of` is evaluated per element. */
  private inferInElementScope(expression: IRExpression, scope: Scope, element: IRType): IRType {
    const inner = scope.child();
    const named = unwrap(element);
    if (named.kind === 'named') {
      for (const field of this.fieldsOf(named.name) ?? []) inner.define(field.name, field.type);
    }
    return this.infer(expression, inner);
  }

  private inferConstruct(expression: Extract<IRExpression, { kind: 'construct' }>, scope: Scope): IRType {
    const declaration = this.lookup(expression.type);
    if (!declaration) {
      this.error('AIL2108', `unknown type "${expression.type}"`, expression.span);
      return UNKNOWN;
    }
    if (!('fields' in declaration)) {
      this.error('AIL2109', `${declaration.kind} ${declaration.name} cannot be constructed with "with"`, expression.span);
      return UNKNOWN;
    }
    // A derived field is computed and a defaulted one fills itself in, so
    // neither has to be supplied at the point of construction.
    const expected = declaration.fields.map((field) => ({
      name: field.name,
      type: field.type,
      required: field.required && !field.derived && !field.constraints.some((c) => c.kind === 'default'),
    }));

    if (expression.source) {
      // Rewriting into explicit arguments keeps `from` a front-end convenience:
      // no backend ever has to know the clause exists.
      this.expandSource(expression, declaration, expected, scope);
    }

    this.checkNamedArguments(expression.arguments, expected, scope, `${declaration.kind} ${declaration.name}`, expression.span);
    return { kind: 'named', name: declaration.name };
  }

  /**
   * Fills in every field of a construction that can be taken from `from <path>`
   * by name. What cannot be resolved is reported, never guessed: a mapper that
   * silently drops a field is the bug this construct exists to prevent.
   */
  private expandSource(
    expression: Extract<IRExpression, { kind: 'construct' }>,
    target: IRDeclaration & { fields: IRField[] },
    expected: Array<{ name: string; type: IRType; required: boolean }>,
    scope: Scope,
  ): void {
    const path = expression.source!;
    const sourceType = unwrap(this.infer({ kind: 'reference', path, span: expression.span }, scope));
    if (sourceType === UNKNOWN) return;

    if (sourceType.kind !== 'named') {
      this.error('AIL2145', `"${path.join('.')}" is ${typeToString(sourceType)}, which has no fields to map from`, expression.span);
      return;
    }
    const source = this.lookup(sourceType.name);
    const sourceFields = source && 'fields' in source ? source.fields : null;
    if (!source || !sourceFields) {
      this.error('AIL2146', `${sourceType.name} has no fields to map from`, expression.span);
      return;
    }

    // An aggregate's identity is reachable as `<thing>Id`, which is how a dto
    // almost always names it.
    const identity = 'identity' in source ? source.identity[0] : undefined;
    const identityAlias = identity ? `${camelCase(source.name)}Id` : null;

    const supplied = new Set(expression.arguments.map((a) => a.name));
    const resolved: IRArgument[] = [];
    const unresolved: string[] = [];

    for (const field of expected) {
      if (supplied.has(field.name)) continue;

      const match = sourceFields.find((f) => f.name === field.name);
      if (match && this.compatible(field.type, match.type)) {
        resolved.push({ name: field.name, value: { kind: 'reference', path: [...path, field.name], span: expression.span } });
        continue;
      }
      if (identityAlias && field.name === identityAlias) {
        resolved.push({ name: field.name, value: { kind: 'reference', path: [...path, identity!], span: expression.span } });
        continue;
      }
      if (field.required) unresolved.push(field.name);
    }

    if (unresolved.length > 0) {
      this.error(
        'AIL2147',
        `${target.name} needs ${unresolved.map((n) => `"${n}"`).join(', ')}, which ${sourceType.name} does not provide`,
        expression.span,
        { hint: `add them explicitly: "with ${unresolved.map((n) => `${n} = ...`).join(', ')}"` },
      );
      return;
    }
    if (resolved.length === 0) {
      this.warn(
        'AIL2148',
        `"from ${path.join('.')}" maps nothing; every field of ${target.name} is already given`,
        expression.span,
        'drop the "from" clause',
      );
    }

    expression.arguments = [...resolved, ...expression.arguments];
  }

  private inferCall(expression: Extract<IRExpression, { kind: 'call' }>, scope: Scope): IRType {
    const candidates = this.resolveCall(expression.operation);
    if (candidates.length === 0) {
      this.error('AIL2110', `no operation named "${expression.operation}" is available here`, expression.span, {
        hint:
          withSuggestion('', expression.operation, this.knownPhrases()) ??
          'declare it on a port and add that port to the "uses" line of this service',
      });
      return UNKNOWN;
    }
    if (candidates.length > 1) {
      this.error(
        'AIL2111',
        `"${expression.operation}" is ambiguous: ${candidates.map((c) => c.owner.name).join(', ')} all declare it`,
        expression.span,
        { hint: 'rename one of the operations so each phrase is unique in scope' },
      );
    }
    const callable = candidates[0]!;
    const expected = callable.signature.parameters.map((p) => ({ name: p.name, type: p.type, required: p.required }));
    if (callable.receiverParameter) {
      expected.unshift({ name: callable.receiverParameter, type: { kind: 'named', name: callable.owner.name }, required: true });
    }
    this.checkNamedArguments(expression.arguments, expected, scope, `operation "${callable.signature.phrase}"`, expression.span);

    const returns = callable.signature.returns;
    if (returns.kind === 'result') {
      for (const error of returns.errors) this.propagatedErrors.add(error);
      return returns.ok;
    }
    return returns;
  }

  private checkNamedArguments(
    args: readonly { name: string; value: IRExpression }[],
    expected: Array<{ name: string; type: IRType; required: boolean }>,
    scope: Scope,
    label: string,
    span: SourceSpan | undefined,
  ): void {
    const provided = new Set<string>();
    for (const argument of args) {
      const target = expected.find((e) => e.name === argument.name);
      const actual = this.infer(argument.value, scope);
      if (!target) {
        this.error('AIL2112', `${label} has no parameter "${argument.name}"`, argument.value.span ?? span, {
          hint: withSuggestion('', argument.name, expected.map((e) => e.name)),
        });
        continue;
      }
      provided.add(argument.name);
      if (!this.compatible(target.type, actual)) {
        this.error(
          'AIL2113',
          `"${argument.name}" expects ${typeToString(target.type)} but received ${typeToString(actual)}`,
          argument.value.span ?? span,
        );
      }
    }
    const missing = expected.filter((e) => e.required && !provided.has(e.name)).map((e) => e.name);
    if (missing.length > 0) {
      this.error('AIL2114', `${label} is missing ${missing.map((m) => `"${m}"`).join(', ')}`, span, {
        hint: `write "with ${missing.map((m) => `${m} = ...`).join(', ')}"`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Compatibility
  // -------------------------------------------------------------------------

  /** Assignability: identical, widened numerics, or a value accepted by an optional. */
  compatible(target: IRType, actual: IRType): boolean {
    if (actual === UNKNOWN || target === UNKNOWN) return true;
    if (typeEquals(target, actual)) return true;

    if (target.kind === 'optional') {
      if (actual.kind === 'primitive' && actual.name === 'nothing') return true;
      return this.compatible(target.of, actual);
    }
    if (actual.kind === 'optional') return false;
    if (target.kind === 'result') return this.compatible(target.ok, actual);
    if (actual.kind === 'result') return this.compatible(target, actual.ok);

    // integer flows into decimal and money; text accepts uuid.
    if (target.kind === 'primitive' && actual.kind === 'primitive') {
      if (target.name === 'decimal' && actual.name === 'integer') return true;
      if (target.name === 'text' && actual.name === 'uuid') return true;
      if (target.name === 'json') return true;
      return false;
    }
    if (target.kind === 'list' && actual.kind === 'list') return this.compatible(target.of, actual.of);
    if (target.kind === 'set' && actual.kind === 'set') return this.compatible(target.of, actual.of);
    if (target.kind === 'map' && actual.kind === 'map') {
      return this.compatible(target.key, actual.key) && this.compatible(target.value, actual.value);
    }
    return false;
  }

  private expect(actual: IRType, expected: IRType, span: SourceSpan | undefined, label: string): void {
    if (!this.compatible(expected, actual)) {
      this.error('AIL2115', `${label} expects ${typeToString(expected)} but received ${typeToString(actual)}`, span);
    }
  }

  private expectNumeric(type: IRType, span: SourceSpan | undefined, label: string): void {
    if (type === UNKNOWN) return;
    if (!isNumeric(type)) {
      this.error('AIL2116', `${label} expects a number but received ${typeToString(type)}`, span);
    }
  }

  private expectOrderable(type: IRType, span: SourceSpan | undefined): void {
    if (type === UNKNOWN || isOrderable(type)) return;
    this.error('AIL2118', `${typeToString(type)} has no order, so it cannot be compared this way`, span, {
      hint: 'numbers, timestamps, dates and durations can be ordered; use "is" or "is not" for anything else',
    });
  }

  error(code: string, message: string, span: SourceSpan | undefined, extra: { hint?: string } = {}): void {
    const hint = extra.hint && extra.hint.length > 0 ? { hint: extra.hint } : {};
    this.context.diagnostics.error('type', code, message, span ?? this.fallbackSpan, hint);
  }

  warn(code: string, message: string, span: SourceSpan | undefined, hint?: string): void {
    this.context.diagnostics.warn('type', code, message, span ?? this.fallbackSpan, hint ? { hint } : {});
  }

  /** Scope seeded with an aggregate's own fields, used when checking its operations. */
  scopeForAggregate(aggregate: IRAggregateDecl): Scope {
    const scope = new Scope();
    for (const field of aggregate.fields) scope.define(field.name, field.type);
    return scope;
  }

  get index(): ModuleIndex {
    return this.context.index;
  }
}

export { NOTHING, BOOLEAN, TEXT, INTEGER, DECIMAL, TIMESTAMP, UUID };
