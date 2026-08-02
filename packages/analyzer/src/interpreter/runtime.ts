/**
 * Executing the IR.
 *
 * `ail test` runs a design before any target code exists, so this evaluates the
 * same statements and expressions the backends lower. It is deliberately not a
 * production runtime: ports resolve to an in-memory store, `now` is frozen, and
 * identifiers are counted rather than random, because a scenario that passes
 * twice for different reasons is worse than one that fails.
 */
import {
  camelCase,
  elementType,
  normalisePhrase,
  type IRAggregateDecl,
  type IRDeclaration,
  type IRExpression,
  type IRField,
  type IRModule,
  type IROperation,
  type IRQueryDecl,
  type IRStatement,
  type ModuleIndex,
} from '@ai-lang/core';
import { compare, emptyFor, equals, isRecord, record, show, type RecordValue, type Value } from './values.js';

/** Raised by `fail`, and by a port that cannot find what it was asked for. */
export class DomainFailure extends Error {
  constructor(
    readonly error: string,
    readonly details: Map<string, Value>,
  ) {
    super(error);
  }
}

/** Raised when the interpreter genuinely cannot proceed. Never a test failure. */
export class Unsupported extends Error {}

export interface PublishedEvent {
  name: string;
  payload: RecordValue;
}

/** Frozen so that two runs of the same scenario produce the same values. */
const EPOCH = new Date('2026-01-01T00:00:00.000Z');

export class Interpreter {
  readonly published: PublishedEvent[] = [];
  /** Stored aggregates, keyed by type then identity. */
  private readonly store = new Map<string, Map<string, RecordValue>>();
  private nextId = 0;

  constructor(private readonly index: ModuleIndex) {}

  get module(): IRModule {
    return this.index.module;
  }

  // -------------------------------------------------------------------------
  // Store
  // -------------------------------------------------------------------------

  seed(value: RecordValue): void {
    const key = this.identityOf(value);
    if (key === null) return;
    const bucket = this.store.get(value.type) ?? new Map<string, RecordValue>();
    bucket.set(key, value);
    this.store.set(value.type, bucket);
  }

  private identityOf(value: RecordValue): string | null {
    const declaration = this.index.get(value.type);
    const field = declaration && 'identity' in declaration ? declaration.identity[0] : 'id';
    const identity = value.fields.get(field ?? 'id');
    return identity === undefined || identity === null ? null : String(identity);
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  evaluate(expression: IRExpression, scope: Map<string, Value>): Value {
    switch (expression.kind) {
      case 'literal':
        return expression.value;
      case 'now':
        return EPOCH;
      case 'new-id':
        // Counted, not random: a scenario asserting on an id must stay stable.
        this.nextId += 1;
        return `00000000-0000-4000-8000-${String(this.nextId).padStart(12, '0')}`;
      case 'list':
        return expression.items.map((item) => this.evaluate(item, scope));
      case 'reference':
        return this.reference(expression.path, scope);
      case 'unary':
        return this.unary(expression, scope);
      case 'binary':
        return this.binary(expression, scope);
      case 'aggregate':
        return this.aggregate(expression, scope);
      case 'project':
        return this.project(expression, scope);
      case 'construct':
        return this.construct(expression, scope);
      case 'call':
        return this.call(expression, scope);
    }
  }

  private reference(path: readonly string[], scope: Map<string, Value>): Value {
    const [head, ...rest] = path;
    if (head === undefined) return null;

    let current: Value;
    if (scope.has(head)) current = scope.get(head)!;
    else if (/^[A-Z]/.test(head)) current = head; // an enum member is its own name
    else throw new Unsupported(`"${head}" is not in scope`);

    for (const part of rest) {
      if (!isRecord(current)) {
        if (typeof current === 'string') return current; // `OrderStatus.Draft`
        throw new Unsupported(`cannot read "${part}" of ${show(current)}`);
      }
      current = current.fields.get(part) ?? null;
    }
    return current;
  }

  private unary(expression: Extract<IRExpression, { kind: 'unary' }>, scope: Map<string, Value>): Value {
    const operand = this.evaluate(expression.operand, scope);
    switch (expression.operator) {
      case 'not':
        return !operand;
      case 'negate':
        return -(operand as number);
      case 'is-empty':
        return length(operand) === 0;
      case 'is-not-empty':
        return length(operand) > 0;
      case 'is-present':
        return operand !== null;
      case 'is-absent':
        return operand === null;
    }
  }

  private binary(expression: Extract<IRExpression, { kind: 'binary' }>, scope: Map<string, Value>): Value {
    // Short-circuit before evaluating the right side, as every backend does.
    if (expression.operator === 'and') {
      return Boolean(this.evaluate(expression.left, scope)) && Boolean(this.evaluate(expression.right, scope));
    }
    if (expression.operator === 'or') {
      return Boolean(this.evaluate(expression.left, scope)) || Boolean(this.evaluate(expression.right, scope));
    }

    const left = this.evaluate(expression.left, scope);
    const right = this.evaluate(expression.right, scope);

    switch (expression.operator) {
      case 'equals':
        return equals(left, right);
      case 'not-equals':
        return !equals(left, right);
      case 'add':
        return (left as number) + (right as number);
      case 'subtract':
        return (left as number) - (right as number);
      case 'multiply':
        return (left as number) * (right as number);
      case 'divide':
        return (left as number) / (right as number);
      case 'contains':
        return Array.isArray(left) ? left.some((item) => equals(item, right)) : String(left).includes(String(right));
      case 'starts-with':
        return String(left).startsWith(String(right));
      case 'ends-with':
        return String(left).endsWith(String(right));
      case 'matches':
        return new RegExp(String(right)).test(String(left));
      default: {
        const order = compare(left, right);
        if (order === null) return false; // an unordered pair never satisfies an ordering
        switch (expression.operator) {
          case 'greater-than':
            return order > 0;
          case 'greater-or-equal':
            return order >= 0;
          case 'less-than':
            return order < 0;
          default:
            return order <= 0;
        }
      }
    }
  }

  private aggregate(expression: Extract<IRExpression, { kind: 'aggregate' }>, scope: Map<string, Value>): Value {
    const collection = this.evaluate(expression.collection, scope);
    const items = Array.isArray(collection) ? collection : [];
    if (expression.fn === 'count') return items.length;

    const projected = items.map((item) => {
      if (!expression.of) return Number(item);
      const inner = new Map(scope);
      if (isRecord(item)) for (const [key, value] of item.fields) inner.set(key, value);
      return Number(this.evaluate(expression.of, inner));
    });

    switch (expression.fn) {
      case 'sum':
        return projected.reduce((total, value) => total + value, 0);
      case 'average':
        return projected.length === 0 ? 0 : projected.reduce((total, value) => total + value, 0) / projected.length;
      case 'min':
        return projected.length === 0 ? 0 : Math.min(...projected);
      default:
        return projected.length === 0 ? 0 : Math.max(...projected);
    }
  }

  /** `each` maps and `only` filters, both evaluating `of` once per element. */
  private project(expression: Extract<IRExpression, { kind: 'project' }>, scope: Map<string, Value>): Value {
    const collection = this.evaluate(expression.collection, scope);
    const items = Array.isArray(collection) ? collection : [];
    const perElement = (item: Value): Value => {
      const inner = new Map(scope);
      if (isRecord(item)) for (const [key, value] of item.fields) inner.set(key, value);
      return this.evaluate(expression.of, inner);
    };
    return expression.fn === 'each' ? items.map(perElement) : items.filter((item) => perElement(item) === true);
  }

  construct(expression: Extract<IRExpression, { kind: 'construct' }>, scope: Map<string, Value>): RecordValue {
    const declaration = this.index.get(expression.type);
    const fields = new Map<string, Value>();
    for (const argument of expression.arguments) fields.set(argument.name, this.evaluate(argument.value, scope));

    // A field left out takes its default, then its empty value, exactly as the
    // generated constructors do.
    if (declaration && 'fields' in declaration) {
      for (const field of declaration.fields) {
        if (fields.has(field.name)) continue;
        fields.set(field.name, defaultOf(field));
      }
    }
    const built = record(expression.type, fields);
    this.checkRules(built);
    return built;
  }

  /** Runs the constraints and invariants the declaration states. */
  checkRules(value: RecordValue): void {
    const declaration = this.index.get(value.type);
    if (!declaration || !('fields' in declaration)) return;

    for (const field of declaration.fields) {
      const held = value.fields.get(field.name) ?? null;
      for (const constraint of field.constraints) {
        if (!satisfies(held, constraint)) {
          throw new DomainFailure(
            'ConstraintViolation',
            new Map<string, Value>([
              ['shape', value.type],
              ['field', field.name],
              ['rule', describeConstraint(constraint)],
            ]),
          );
        }
      }
    }

    if (!('invariants' in declaration)) return;
    const scope = new Map<string, Value>(value.fields);
    for (const invariant of declaration.invariants) {
      if (this.evaluate(invariant.condition, scope)) continue;
      throw new DomainFailure(
        'InvariantViolation',
        new Map<string, Value>([
          ['shape', value.type],
          ['rule', invariant.description],
        ]),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  private call(expression: Extract<IRExpression, { kind: 'call' }>, scope: Map<string, Value>): Value {
    const args = new Map<string, Value>();
    for (const argument of expression.arguments) args.set(argument.name, this.evaluate(argument.value, scope));
    return this.invoke(expression.operation, args);
  }

  /** Resolves a phrase to an aggregate method, a service operation or a port. */
  invoke(phrase: string, args: Map<string, Value>): Value {
    const candidates = this.index.resolvePhrase(phrase);
    // An inbound port names a use case the service carries out, so the body wins
    // over the declaration. Only an outbound port falls through to the store.
    const resolved = candidates.find((c) => c.owner.kind !== 'port') ?? candidates[0];
    if (!resolved) throw new Unsupported(`no operation named "${phrase}"`);

    if (resolved.owner.kind === 'port') return this.port(resolved.owner.name, phrase, args);

    if (resolved.owner.kind === 'aggregate') {
      const receiverName = camelCase(resolved.owner.name);
      const receiver = args.get(receiverName);
      if (!isRecord(receiver)) throw new Unsupported(`"${phrase}" needs "${receiverName}" to be a ${resolved.owner.name}`);
      return this.runOperation(resolved.operation as IROperation, args, receiver);
    }
    return this.runOperation(resolved.operation as IROperation, args, null);
  }

  private runOperation(operation: IROperation, args: Map<string, Value>, receiver: RecordValue | null): Value {
    const scope = new Map<string, Value>(args);
    // An aggregate operation reads and writes its own fields directly.
    if (receiver) for (const [key, value] of receiver.fields) scope.set(key, value);

    const outcome = this.runBlock(operation.body, scope, receiver);
    return outcome.kind === 'returned' ? outcome.value : null;
  }

  /**
   * The in-memory store standing in for every outbound port. Only the phrases a
   * repository is built from are understood; anything else stops the scenario as
   * inconclusive rather than passing it by accident.
   */
  private port(portName: string, phrase: string, args: Map<string, Value>): Value {
    const port = this.index.typed(portName, 'port');
    const signature = port?.operations.find((o) => normalisePhrase(o.phrase) === normalisePhrase(phrase));
    const normalised = normalisePhrase(phrase);
    const subject = subjectOf(signature?.returns ?? null, this.index);

    if (/^(find|get|read|load)\b.*\bby id$/.test(normalised)) {
      const bucket = this.store.get(subject ?? '') ?? new Map();
      const found = bucket.get(String(args.get('id') ?? ''));
      if (found) return found;
      const error = signature?.throws[0];
      if (!error) return null;
      const declaration = this.index.typed(error, 'error');
      const key = declaration?.fields[0]?.name ?? 'id';
      return failWith(error, new Map<string, Value>([[key, args.get('id') ?? null]]));
    }

    if (/^(save|store|persist|upsert)\b/.test(normalised)) {
      const [value] = [...args.values()];
      if (isRecord(value)) {
        this.checkRules(value);
        this.seed(value);
      }
      return null;
    }

    if (/^(delete|remove)\b/.test(normalised)) {
      this.store.get(subject ?? '')?.delete(String(args.get('id') ?? ''));
      return null;
    }

    if (/^(list|find all|search|find)\b/.test(normalised)) {
      const query = [...args.values()].find((value) => isRecord(value) && this.index.typed(value.type, 'query'));
      const rows = [...(this.store.get(subject ?? '') ?? new Map<string, RecordValue>()).values()];
      if (isRecord(query)) return this.applyQuery(this.index.typed(query.type, 'query')!, query, rows);

      // `list orders for customer` filters by whatever field the parameter names.
      const filtered = rows.filter((row) =>
        [...args.entries()].every(([name, value]) => !row.fields.has(name) || equals(row.fields.get(name)!, value)),
      );
      return filtered;
    }

    throw new Unsupported(`the interpreter has no in-memory form of "${phrase}" on port ${portName}`);
  }

  private applyQuery(query: IRQueryDecl, criteria: RecordValue, rows: readonly RecordValue[]): Value {
    const subject = camelCase(query.over);
    const matched = rows.filter((row) => {
      const scope = new Map<string, Value>(criteria.fields);
      scope.set(subject, row);
      return query.criteria.every((criterion) => {
        // A criterion whose optional parameter is absent does not apply.
        const skipped = criterion.guards.some((name) => {
          const field = query.fields.find((f) => f.name === name);
          return field !== undefined && !field.required && (criteria.fields.get(name) ?? null) === null;
        });
        return skipped || Boolean(this.evaluate(criterion.condition, scope));
      });
    });

    const sorted = [...matched].sort((left, right) => {
      for (const entry of query.sort) {
        const order = compare(this.reference(entry.path.slice(1), new Map([[subject, left]])), this.reference(entry.path.slice(1), new Map([[subject, right]])));
        if (order === null || order === 0) continue;
        return entry.direction === 'descending' ? -order : order;
      }
      return 0;
    });
    return query.limit ? sorted.slice(0, query.limit) : sorted;
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  private runBlock(
    statements: readonly IRStatement[],
    scope: Map<string, Value>,
    receiver: RecordValue | null,
  ): { kind: 'fell-through' } | { kind: 'returned'; value: Value } {
    for (const statement of statements) {
      const outcome = this.runStatement(statement, scope, receiver);
      if (outcome.kind === 'returned') return outcome;
    }
    return { kind: 'fell-through' };
  }

  private runStatement(
    statement: IRStatement,
    scope: Map<string, Value>,
    receiver: RecordValue | null,
  ): { kind: 'fell-through' } | { kind: 'returned'; value: Value } {
    switch (statement.kind) {
      case 'let':
        scope.set(statement.name, this.evaluate(statement.value, scope));
        return { kind: 'fell-through' };

      case 'set': {
        const value = this.evaluate(statement.value, scope);
        this.assign(statement.target, value, scope, receiver);
        return { kind: 'fell-through' };
      }

      case 'perform':
        this.evaluate(statement.value, scope);
        return { kind: 'fell-through' };

      case 'when': {
        const branch = this.evaluate(statement.condition, scope) ? statement.then : statement.otherwise;
        return this.runBlock(branch, new Map(scope), receiver);
      }

      case 'for-each': {
        const collection = this.evaluate(statement.collection, scope);
        for (const item of Array.isArray(collection) ? collection : []) {
          const inner = new Map(scope);
          inner.set(statement.item, item);
          const outcome = this.runBlock(statement.body, inner, receiver);
          if (outcome.kind === 'returned') return outcome;
        }
        return { kind: 'fell-through' };
      }

      case 'fail': {
        const details = new Map<string, Value>();
        for (const argument of statement.arguments) details.set(argument.name, this.evaluate(argument.value, scope));
        return failWith(statement.error, details);
      }

      case 'publish': {
        const payload = new Map<string, Value>();
        for (const argument of statement.arguments) payload.set(argument.name, this.evaluate(argument.value, scope));
        this.published.push({ name: statement.event, payload: record(statement.event, payload) });
        return { kind: 'fell-through' };
      }

      case 'append': {
        const list = this.read(statement.collection, scope, receiver);
        if (Array.isArray(list)) list.push(this.evaluate(statement.value, scope));
        return { kind: 'fell-through' };
      }

      case 'remove': {
        const value = this.evaluate(statement.value, scope);
        const list = this.read(statement.collection, scope, receiver);
        if (Array.isArray(list)) {
          const at = list.findIndex((item) => equals(item, value));
          if (at >= 0) list.splice(at, 1);
        }
        return { kind: 'fell-through' };
      }

      case 'return':
        return { kind: 'returned', value: statement.value ? this.evaluate(statement.value, scope) : null };
    }
  }

  private read(path: readonly string[], scope: Map<string, Value>, receiver: RecordValue | null): Value {
    if (path.length === 1 && receiver?.fields.has(path[0]!)) return receiver.fields.get(path[0]!)!;
    return this.reference(path, scope);
  }

  /** Writes through to the record so a scenario can assert on what it seeded. */
  private assign(path: readonly string[], value: Value, scope: Map<string, Value>, receiver: RecordValue | null): void {
    if (path.length === 1) {
      const name = path[0]!;
      if (receiver?.fields.has(name)) {
        receiver.fields.set(name, value);
        this.checkRules(receiver);
      }
      scope.set(name, value);
      return;
    }
    const target = this.reference(path.slice(0, -1), scope);
    if (!isRecord(target)) throw new Unsupported(`cannot assign to ${path.join('.')}`);
    target.fields.set(path[path.length - 1]!, value);
    this.checkRules(target);
  }
}

function failWith(error: string, details: Map<string, Value>): never {
  throw new DomainFailure(error, details);
}

function length(value: Value): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'string') return value.length;
  return value === null ? 0 : 1;
}

function defaultOf(field: IRField): Value {
  const fallback = field.constraints.find((c) => c.kind === 'default');
  if (fallback && fallback.kind === 'default') return fallback.value;
  return emptyFor(field.type);
}

/** The declared type a repository phrase stores, taken from its return type. */
function subjectOf(returns: Parameters<typeof elementType>[0] | null, index: ModuleIndex): string | null {
  if (!returns) return null;
  const inner = elementType(returns) ?? returns;
  const named = inner.kind === 'result' ? inner.ok : inner.kind === 'optional' ? inner.of : inner;
  const resolved = named.kind === 'list' ? named.of : named;
  if (resolved.kind !== 'named') return null;
  return index.get(resolved.name) ? resolved.name : null;
}

function satisfies(value: Value, constraint: IRField['constraints'][number]): boolean {
  switch (constraint.kind) {
    case 'min':
      return typeof value !== 'number' || value >= constraint.value;
    case 'max':
      return typeof value !== 'number' || value <= constraint.value;
    case 'min-length':
      return length(value) >= constraint.value;
    case 'max-length':
      return length(value) <= constraint.value;
    case 'length':
      return length(value) === constraint.value;
    case 'pattern':
      return typeof value !== 'string' || new RegExp(constraint.value).test(value);
    default:
      return true;
  }
}

function describeConstraint(constraint: IRField['constraints'][number]): string {
  switch (constraint.kind) {
    case 'min':
    case 'max':
      return `${constraint.kind} ${constraint.value}`;
    case 'min-length':
      return `min length ${constraint.value}`;
    case 'max-length':
      return `max length ${constraint.value}`;
    case 'length':
      return `length ${constraint.value}`;
    case 'pattern':
      return 'pattern';
    default:
      return constraint.kind;
  }
}

export { show, isRecord, type Value, type RecordValue, type IRAggregateDecl, type IRDeclaration };
