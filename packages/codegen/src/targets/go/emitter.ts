/** Go surface syntax for the shared IR walk. */
import {
  camelCase,
  elementType,
  escapeReserved,
  snakeCase,
  unwrap,
  words,
  type BinaryOperator,
  type CodeWriter,
  type IRArgument,
  type IRExpression,
  type IRField,
  type IRParameter,
  type IRStatement,
  type IRType,
  type ModuleIndex,
  type UnaryOperator,
} from '@haic/core';
import { LanguageEmitter } from '../../shared/emitter.js';

const PRIMITIVES: Record<string, string> = {
  text: 'string',
  integer: 'int64',
  decimal: 'float64',
  boolean: 'bool',
  uuid: 'string',
  timestamp: 'time.Time',
  date: 'time.Time',
  duration: 'time.Duration',
  json: 'any',
  bytes: '[]byte',
  nothing: '',
};

/** Words gofmt and the Go style guide keep fully capitalised. */
const INITIALISMS = new Set(['api', 'db', 'http', 'https', 'id', 'ip', 'json', 'sql', 'ssh', 'tls', 'uri', 'url', 'utf8', 'uuid', 'xml']);

function goWord(word: string): string {
  return INITIALISMS.has(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1);
}

/** Exported identifier, e.g. `find order by id` becomes `FindOrderByID`. */
export function goExported(name: string): string {
  return words(name).map(goWord).join('');
}

/** Unexported identifier, e.g. `OrderRepository` becomes `orderRepository`. */
export function goUnexported(name: string): string {
  const parts = words(name);
  return escapeReserved([parts[0] ?? '', ...parts.slice(1).map(goWord)].join(''), 'go');
}

/** Package clause for a module: lowercase, no separators. */
export function goPackage(name: string): string {
  return snakeCase(name).replace(/_/g, '') || 'app';
}

/** Go string literal. JSON escaping is a subset of Go's. */
export function goString(value: string): string {
  return JSON.stringify(value);
}

export interface GoEmitterOptions {
  /** Package selector for domain types, `domain.` outside the domain package. */
  domainPrefix?: string;
  /** Ports the enclosing struct holds, mapped from port name to field name. */
  portFields?: ReadonlyMap<string, string>;
  /** Method receiver, `s` for services, `h` for handlers, the initial for aggregates. */
  receiver?: string;
  /** Fields reachable through the receiver; bare references resolve against them. */
  receiverFields?: readonly IRField[];
  /** Field holding the event publisher. */
  publisherField?: string;
}

/** Shape of the enclosing operation's Go return list. */
interface ReturnShape {
  /** Zero value of the ok type; empty when the operation returns `error` alone. */
  zero: string;
  /** The signature ends in `error`, so failures can travel instead of panicking. */
  fallible: boolean;
}

/** Facts about the statement being lowered that the shared walk does not carry. */
interface StatementShape {
  /** The value is a call whose last result is an `error`. */
  fallible: boolean;
  /** That call also yields a value this statement throws away. */
  discards: boolean;
  /** The assignment target is an optional field, so the value needs its address. */
  pointerTarget: boolean;
  /** Nothing later in the operation reads this binding, and Go rejects that. */
  unused: boolean;
}

const NO_STATEMENT: StatementShape = { fallible: false, discards: false, pointerTarget: false, unused: false };

/**
 * Every name the body reads.
 *
 * Go refuses to compile a local nobody uses, and HADL has a legitimate reason
 * to write one: `let task be find task by id` binds a value only so the missing
 * case can fail. Knowing which names are read lets that binding be discarded
 * instead of declared.
 */
function collectReferences(statements: readonly IRStatement[]): Set<string> {
  const names = new Set<string>();

  const fromExpression = (expression: IRExpression): void => {
    switch (expression.kind) {
      case 'reference':
        if (expression.path[0]) names.add(expression.path[0]);
        return;
      case 'binary':
        fromExpression(expression.left);
        fromExpression(expression.right);
        return;
      case 'unary':
        fromExpression(expression.operand);
        return;
      case 'call':
        if (expression.receiver) names.add(expression.receiver);
        for (const argument of expression.arguments) fromExpression(argument.value);
        return;
      case 'construct':
        if (expression.source?.[0]) names.add(expression.source[0]);
        for (const argument of expression.arguments) fromExpression(argument.value);
        return;
      case 'aggregate':
        fromExpression(expression.collection);
        if (expression.of) fromExpression(expression.of);
        return;
      case 'list':
        for (const item of expression.items) fromExpression(item);
        return;
      default:
        return;
    }
  };

  const fromStatement = (statement: IRStatement): void => {
    switch (statement.kind) {
      case 'let':
      case 'perform':
        fromExpression(statement.value);
        return;
      case 'set':
      case 'append':
      case 'remove':
        // The head of the target path is read before it is written into.
        if (statement.kind === 'set' ? statement.target[0] : statement.collection[0]) {
          names.add((statement.kind === 'set' ? statement.target[0] : statement.collection[0]) as string);
        }
        fromExpression(statement.value);
        return;
      case 'when':
        fromExpression(statement.condition);
        for (const inner of [...statement.then, ...statement.otherwise]) fromStatement(inner);
        return;
      case 'for-each':
        fromExpression(statement.collection);
        for (const inner of statement.body) fromStatement(inner);
        return;
      case 'fail':
      case 'publish':
        for (const argument of statement.arguments) fromExpression(argument.value);
        return;
      case 'return':
        if (statement.value) fromExpression(statement.value);
        return;
    }
  };

  for (const statement of statements) fromStatement(statement);
  return names;
}

/** Rendered values simple enough for `&value` to be legal Go. */
const ADDRESSABLE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export class GoEmitter extends LanguageEmitter {
  readonly target = 'go' as const;

  private returns: ReturnShape = { zero: '', fallible: true };
  private statement: StatementShape = NO_STATEMENT;
  /** Element type of the collection the aggregate being rendered folds over. */
  private element = 'float64';
  /** Inside an aggregate projection every leaf is converted to float64. */
  private folding = false;
  /** Names the operation being lowered reads, and how deep the walk currently is. */
  private referenced = new Set<string>();
  private depth = 0;
  /** Types of the locals in scope, so values reaching a pointer field get their address. */
  private readonly locals = new Map<string, IRType>();
  private readonly fields: ReadonlyMap<string, IRType>;

  constructor(
    index: ModuleIndex,
    private readonly options: GoEmitterOptions = {},
  ) {
    super(index);
    this.fields = new Map((options.receiverFields ?? []).map((field) => [field.name, field.type]));
  }

  // -- context --------------------------------------------------------------

  /** Declares the Go return list and the scope of the operation whose body follows. */
  enterOperation(returns: IRType, fallible: boolean, parameters: readonly IRParameter[] = []): void {
    this.returns = { zero: this.zeroValue(returns), fallible };
    this.locals.clear();
    for (const parameter of parameters) this.locals.set(parameter.name, parameter.type);
  }

  /** `zero, err` or plain `err`, matching the enclosing signature. */
  errorReturn(expression = 'err'): string {
    return this.returns.zero === '' ? expression : `${this.returns.zero}, ${expression}`;
  }

  /** Return statement closing an operation whose body does not end in one. */
  terminalReturn(): string | null {
    if (this.returns.fallible) return this.returns.zero === '' ? 'return nil' : `return ${this.returns.zero}, nil`;
    return this.returns.zero === '' ? null : `return ${this.returns.zero}`;
  }

  private get receiver(): string {
    return this.options.receiver ?? 's';
  }

  private get publisher(): string {
    return this.options.publisherField ?? 'events';
  }

  private qualify(name: string): string {
    return `${this.options.domainPrefix ?? ''}${goExported(name)}`;
  }

  // -- types ----------------------------------------------------------------

  typeName(type: IRType): string {
    switch (type.kind) {
      case 'primitive':
        return PRIMITIVES[type.name] ?? 'any';
      case 'named':
        return this.qualify(type.name);
      case 'list':
        return `[]${this.typeName(type.of)}`;
      case 'set':
        return `map[${this.typeName(type.of)}]struct{}`;
      case 'map':
        return `map[${this.typeName(type.key)}]${this.typeName(type.value)}`;
      case 'optional':
        return `*${this.typeName(type.of)}`;
      case 'result':
        // Checked errors travel in the second return value, never in the type.
        return this.typeName(type.ok);
    }
  }

  /** Value a failing operation returns alongside its error. */
  zeroValue(type: IRType): string {
    switch (type.kind) {
      case 'primitive':
        switch (type.name) {
          case 'text':
          case 'uuid':
            return '""';
          case 'integer':
          case 'decimal':
          case 'duration':
            return '0';
          case 'boolean':
            return 'false';
          case 'timestamp':
          case 'date':
            return 'time.Time{}';
          case 'nothing':
            return '';
          default:
            return 'nil';
        }
      case 'named':
        return this.index.typed(type.name, 'enum') ? '""' : `${this.qualify(type.name)}{}`;
      case 'result':
        return this.zeroValue(type.ok);
      default:
        return 'nil';
    }
  }

  literal(value: string | number | boolean | null, type: IRType): string {
    if (value === null) return 'nil';
    // An unquoted default on an enum-typed field names one of its constants.
    if (typeof value === 'string') return type.kind === 'named' ? `${this.qualify(type.name)}${goExported(value)}` : goString(value);
    return String(value);
  }

  identifier(name: string): string {
    return goUnexported(name);
  }

  member(path: readonly string[]): string {
    const rendered = path.map((part, index) => (index === 0 ? this.head(part) : goExported(part))).join('.');
    return this.folding ? `float64(${rendered})` : rendered;
  }

  /** The first segment may be a local, a receiver field, or an enum constant. */
  private head(name: string): string {
    if (/^[A-Z]/.test(name)) {
      const owner = this.index.enums.find((e) => e.values.some((v) => v.name === name));
      return owner ? `${this.qualify(owner.name)}${goExported(name)}` : this.qualify(name);
    }
    if (this.fields.has(name)) return `${this.receiver}.${goExported(name)}`;
    return goUnexported(name);
  }

  // -- expressions ----------------------------------------------------------

  call(receiver: string | null, operation: string, args: readonly IRArgument[]): string {
    const entry = this.index.resolvePhrase(operation)[0];
    const method = goExported(operation);
    const rendered = this.argumentsOf(args);

    /** Go calls are positional, so arguments follow the declared parameter order. */
    const positional = (holder: string | null): string[] => {
      const parameters = entry?.operation.parameters ?? [];
      if (parameters.length === 0) return rendered.filter((a) => a.name !== holder).map((a) => a.value);
      const byName = new Map(rendered.map((a) => [a.name, a.value]));
      return parameters.map((p) => byName.get(camelCase(p.name)) ?? this.zeroValue(p.type));
    };

    const owner = entry?.owner;
    if (owner?.kind === 'port') {
      const field = this.options.portFields?.get(owner.name) ?? goUnexported(owner.name);
      return `${this.receiver}.${field}.${method}(${['ctx', ...positional(null)].join(', ')})`;
    }
    if (owner?.kind === 'aggregate' || owner?.kind === 'service') {
      // The receiver arrives as the argument named after the owning declaration.
      const holder = camelCase(owner.name);
      const instance = rendered.find((a) => a.name === holder)?.value ?? this.receiver;
      const leading = owner.kind === 'service' ? ['ctx'] : [];
      return `${instance}.${method}(${[...leading, ...positional(holder)].join(', ')})`;
    }
    if (receiver) return `${goUnexported(receiver)}.${method}(${positional(null).join(', ')})`;
    return `${this.receiver}.${method}(${['ctx', ...positional(null)].join(', ')})`;
  }

  construct(typeName: string, args: readonly IRArgument[]): string {
    return `${this.qualify(typeName)}${this.structLiteral(typeName, args)}`;
  }

  /** `{Field: value, ...}`, taking the address of values that land on a pointer field. */
  private structLiteral(typeName: string, args: readonly IRArgument[]): string {
    const declaration = this.index.get(typeName);
    const fields = declaration && 'fields' in declaration ? declaration.fields : [];
    const rendered = args.map((argument) => {
      const field = fields.find((f) => camelCase(f.name) === camelCase(argument.name));
      const value = this.expression(argument.value);
      const address = field !== undefined && this.needsAddress(field.type, argument.value) && ADDRESSABLE.test(value);
      return `${goExported(argument.name)}: ${address ? `&${value}` : value}`;
    });
    return `{${rendered.join(', ')}}`;
  }

  listLiteral(items: readonly string[], elementType: IRType | null): string {
    // Go cannot write a literal without its element type, which is why the
    // analyzer records one.
    const element = elementType ? this.typeName(elementType) : 'any';
    return `[]${element}{${items.join(', ')}}`;
  }

  now(): string {
    return 'time.Now().UTC()';
  }

  newId(): string {
    return 'uuid.NewString()';
  }

  projectFn(fn: 'each' | 'only', collection: string, projection: string, elementVar: string, elementType: IRType | null): string {
    // Go has neither an expression-level map nor filter, and a func literal has
    // to name both its parameter and its result, so both ends are needed here.
    if (fn === 'only') {
      return `shared.Only(${collection}, func(${elementVar} ${this.element}) bool { return ${projection} })`;
    }
    const result = elementType ? this.typeName(elementType) : 'any';
    return `shared.Each(${collection}, func(${elementVar} ${this.element}) ${result} { return ${projection} })`;
  }

  aggregateFn(fn: 'sum' | 'count' | 'min' | 'max' | 'average', collection: string, projection: string | null, elementVar: string): string {
    if (fn === 'count') return `int64(len(${collection}))`;
    const helper = fn === 'sum' ? 'Sum' : fn === 'average' ? 'Avg' : fn === 'min' ? 'MinOf' : 'MaxOf';
    // Go has no expression-level fold, so aggregates go through the shared helpers.
    const of = projection === null ? 'shared.Identity' : `func(${elementVar} ${this.element}) float64 { return ${projection} }`;
    return `shared.${helper}(${collection}, ${of})`;
  }

  binary(operator: BinaryOperator, left: string, right: string, _operandType: IRType | null): string {
    switch (operator) {
      case 'equals':
        return `${left} == ${right}`;
      case 'not-equals':
        return `${left} != ${right}`;
      // time.Time is not ordered by operators, so ordering goes through the
      // shared helpers, which are generic over every ordered type.
      case 'greater-than':
        return `shared.Gt(${left}, ${right})`;
      case 'greater-or-equal':
        return `shared.Ge(${left}, ${right})`;
      case 'less-than':
        return `shared.Lt(${left}, ${right})`;
      case 'less-or-equal':
        return `shared.Le(${left}, ${right})`;
      case 'add':
        return `(${left} + ${right})`;
      case 'subtract':
        return `(${left} - ${right})`;
      case 'multiply':
        return `(${left} * ${right})`;
      case 'divide':
        return `(${left} / ${right})`;
      case 'and':
        return `(${left} && ${right})`;
      case 'or':
        return `(${left} || ${right})`;
      case 'contains':
        return `strings.Contains(${left}, ${right})`;
      case 'starts-with':
        return `strings.HasPrefix(${left}, ${right})`;
      case 'ends-with':
        return `strings.HasSuffix(${left}, ${right})`;
      case 'matches':
        return `regexp.MustCompile(${right}).MatchString(${left})`;
    }
  }

  unary(operator: UnaryOperator, operand: string): string {
    switch (operator) {
      case 'not':
        return `!(${operand})`;
      case 'negate':
        return `-(${operand})`;
      case 'is-empty':
        return `len(${operand}) == 0`;
      case 'is-not-empty':
        return `len(${operand}) > 0`;
      case 'is-present':
        return `${operand} != nil`;
      case 'is-absent':
        return `${operand} == nil`;
    }
  }

  override expression(node: IRExpression): string {
    if (node.kind === 'aggregate' || node.kind === 'project') this.element = this.elementTypeName(node.collection);
    return super.expression(node);
  }

  /** Aggregates fold to float64, so leaf references inside the projection are converted. */
  protected override projection(node: IRExpression, elementVar: string): string {
    this.folding = true;
    try {
      return super.projection(node, elementVar);
    } finally {
      this.folding = false;
    }
  }

  // -- statements -----------------------------------------------------------

  /** The outermost block is the operation body, which is what usage is scanned over. */
  override emitBlock(writer: CodeWriter, statements: readonly IRStatement[]): void {
    if (this.depth === 0) this.referenced = collectReferences(statements);
    this.depth += 1;
    try {
      super.emitBlock(writer, statements);
    } finally {
      this.depth -= 1;
    }
  }

  override emitStatement(writer: CodeWriter, statement: IRStatement): void {
    if (statement.kind === 'for-each') this.remember(statement.item, elementType(this.typeOf(statement.collection) ?? NOTHING_TYPE));
    this.statement = {
      fallible:
        (statement.kind === 'let' || statement.kind === 'perform') && this.isFallible(statement.value)
          ? true
          : statement.kind === 'return' && statement.value !== null && this.isFallible(statement.value),
      discards: statement.kind === 'perform' && this.yieldsValue(statement.value),
      pointerTarget: statement.kind === 'set' && this.needsAddress(this.pathType(statement.target), statement.value),
      unused: statement.kind === 'let' && !this.referenced.has(statement.name),
    };
    super.emitStatement(writer, statement);
    if (statement.kind === 'let') this.remember(statement.name, this.typeOf(statement.value));
    this.statement = NO_STATEMENT;
  }

  emitLet(writer: CodeWriter, name: string, value: string): void {
    // A binding nothing reads is kept for the failure it can raise, so it
    // becomes the guard itself rather than a local Go would reject.
    if (this.statement.unused) {
      if (!this.statement.fallible) {
        writer.line(`_ = ${value}`);
        return;
      }
      writer.line(`if _, err := ${value}; err != nil {`);
      writer.block(() => writer.line(`return ${this.errorReturn()}`));
      writer.line('}');
      return;
    }
    if (!this.statement.fallible) {
      writer.line(`${name} := ${value}`);
      return;
    }
    // Go has no exceptions: a fallible call becomes a binding plus a guard.
    writer.line(`${name}, err := ${value}`);
    this.emitGuard(writer);
  }

  emitSet(writer: CodeWriter, target: string, value: string): void {
    const address = this.statement.pointerTarget && ADDRESSABLE.test(value);
    writer.line(`${target} = ${address ? `&${value}` : value}`);
  }

  emitPerform(writer: CodeWriter, value: string): void {
    if (!this.statement.fallible) {
      writer.line(value);
      return;
    }
    writer.line(`if ${this.statement.discards ? '_, err' : 'err'} := ${value}; err != nil {`);
    writer.block(() => writer.line(`return ${this.errorReturn()}`));
    writer.line('}');
  }

  emitReturn(writer: CodeWriter, value: string | null): void {
    const rendered = value ?? (this.returns.zero === '' ? null : this.returns.zero);
    if (!this.returns.fallible) {
      writer.line(rendered === null ? 'return' : `return ${rendered}`);
      return;
    }
    // A fallible call already yields (value, error). Appending nil would nest a
    // tuple inside a tuple, which Go rejects outright.
    if (this.statement.fallible && rendered !== null) {
      writer.line(`return ${rendered}`);
      return;
    }
    writer.line(rendered === null ? 'return nil' : `return ${rendered}, nil`);
  }

  emitFail(writer: CodeWriter, errorName: string, args: readonly IRArgument[]): void {
    const payload = `&${this.qualify(errorName)}${this.structLiteral(errorName, args)}`;
    const declaration = this.index.typed(errorName, 'error');
    // Unchecked errors signal a defect, so they never travel as a value.
    if (declaration?.checked === false || !this.returns.fallible) {
      writer.line(`panic(${payload})`);
      return;
    }
    writer.line(`return ${this.errorReturn(payload)}`);
  }

  emitPublish(writer: CodeWriter, eventName: string, args: readonly IRArgument[]): void {
    const payload = `${this.qualify(eventName)}${this.structLiteral(eventName, args)}`;
    const call = `${this.receiver}.${this.publisher}.Publish(ctx, ${this.qualify(eventName)}Topic, ${payload})`;
    if (!this.returns.fallible) {
      writer.line(`_ = ${call}`);
      return;
    }
    writer.line(`if err := ${call}; err != nil {`);
    writer.block(() => writer.line(`return ${this.errorReturn()}`));
    writer.line('}');
  }

  emitAppend(writer: CodeWriter, collection: string, value: string): void {
    writer.line(`${collection} = append(${collection}, ${value})`);
  }

  emitRemove(writer: CodeWriter, collection: string, value: string): void {
    // Slices have no removal primitive; the element is spliced out in place.
    writer.line(`for position, candidate := range ${collection} {`);
    writer.block(() => {
      writer.line(`if candidate == ${value} {`);
      writer.block(() => {
        writer.line(`${collection} = append(${collection}[:position], ${collection}[position+1:]...)`);
        writer.line('break');
      });
      writer.line('}');
    });
    writer.line('}');
  }

  emitWhen(writer: CodeWriter, condition: string, then: () => void, otherwise: (() => void) | null): void {
    writer.line(`if ${condition} {`);
    writer.block(then);
    if (otherwise) {
      writer.line('} else {');
      writer.block(otherwise);
    }
    writer.line('}');
  }

  emitForEach(writer: CodeWriter, item: string, collection: string, body: () => void): void {
    writer.line(`for _, ${item} := range ${collection} {`);
    writer.block(body);
    writer.line('}');
  }

  /** `if err != nil { return zero, err }`, the tail of every lowered call. */
  private emitGuard(writer: CodeWriter): void {
    writer.line('if err != nil {');
    writer.block(() => writer.line(`return ${this.errorReturn()}`));
    writer.line('}');
  }

  // -- resolution helpers ---------------------------------------------------

  /** Ports and services always return an error; anything else only when it declares one. */
  private isFallible(node: IRExpression): boolean {
    if (node.kind !== 'call') return false;
    const entry = this.index.resolvePhrase(node.operation)[0];
    if (!entry) return false;
    return entry.owner.kind === 'port' || entry.owner.kind === 'service' || entry.operation.throws.length > 0;
  }

  private yieldsValue(node: IRExpression): boolean {
    if (node.kind !== 'call') return false;
    const entry = this.index.resolvePhrase(node.operation)[0];
    return entry !== undefined && this.typeName(entry.operation.returns) !== '';
  }

  private remember(name: string, type: IRType | null): void {
    if (type) this.locals.set(name, type);
  }

  /** Static type of an expression, as far as the module index can tell. */
  private typeOf(node: IRExpression): IRType | null {
    switch (node.kind) {
      case 'literal':
        return node.type;
      case 'reference':
        return this.pathType(node.path);
      case 'construct':
        return { kind: 'named', name: node.type };
      case 'now':
        return { kind: 'primitive', name: 'timestamp' };
      case 'new-id':
        return { kind: 'primitive', name: 'uuid' };
      case 'aggregate':
        return { kind: 'primitive', name: node.fn === 'count' ? 'integer' : 'decimal' };
      case 'call': {
        const entry = this.index.resolvePhrase(node.operation)[0];
        return entry ? okType(entry.operation.returns) : null;
      }
      default:
        return null;
    }
  }

  /** Walks `order.placedAt` down from a local or a receiver field to its declared type. */
  private pathType(path: readonly string[]): IRType | null {
    const head = path[0];
    if (!head) return null;
    let current = this.locals.get(head) ?? this.fields.get(head) ?? null;
    for (const segment of path.slice(1)) {
      if (!current) return null;
      const inner = unwrap(current);
      const declaration = inner.kind === 'named' ? this.index.get(inner.name) : undefined;
      const field = declaration && 'fields' in declaration ? declaration.fields.find((f) => f.name === segment) : undefined;
      current = field?.type ?? null;
    }
    return current;
  }

  /** Optional fields are pointers, so a value assigned to one has to be addressed. */
  private needsAddress(target: IRType | null, value: IRExpression): boolean {
    if (target?.kind !== 'optional') return false;
    const source = this.typeOf(value);
    return source === null || source.kind !== 'optional';
  }

  private elementTypeName(collection: IRExpression): string {
    const element = collection.kind === 'reference' ? elementType(this.pathType(collection.path) ?? NOTHING_TYPE) : null;
    return element ? this.typeName(element) : 'float64';
  }
}

const NOTHING_TYPE: IRType = { kind: 'primitive', name: 'nothing' };

/** Strips `result` wrappers while keeping `optional`, which Go models as a pointer. */
function okType(type: IRType): IRType {
  return type.kind === 'result' ? okType(type.ok) : type;
}
