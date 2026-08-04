/** Python surface syntax for the shared IR walk. */
import {
  escapeReserved,
  kebabCase,
  pascalCase,
  screamingSnakeCase,
  snakeCase,
  unwrap,
  type BinaryOperator,
  type CodeWriter,
  type IRArgument,
  type IRExpression,
  type IRType,
  type ModuleIndex,
  type UnaryOperator,
} from '@haic/core';
import { LanguageEmitter } from '../../shared/emitter.js';

const PRIMITIVES: Record<string, string> = {
  text: 'str',
  integer: 'int',
  decimal: 'decimal.Decimal',
  boolean: 'bool',
  uuid: 'uuid.UUID',
  timestamp: 'datetime.datetime',
  date: 'datetime.date',
  duration: 'datetime.timedelta',
  json: 'Any',
  bytes: 'bytes',
  nothing: 'None',
};

/** Builtins are legal as attributes, parameters and keyword arguments, so they are kept as declared. */
const SHADOWABLE_BUILTINS: ReadonlySet<string> = new Set(['id', 'type', 'list', 'dict', 'set', 'str', 'int', 'float', 'bytes']);

/** `orderId` -> `order_id`, renaming only what the Python grammar rejects. */
export function pythonName(name: string): string {
  const snake = snakeCase(name);
  return SHADOWABLE_BUILTINS.has(snake) ? snake : escapeReserved(snake, 'python');
}

/** `find order by id` -> `find_order_by_id`. */
export function methodName(phrase: string): string {
  return snakeCase(phrase);
}

export class PythonEmitter extends LanguageEmitter {
  readonly target = 'python' as const;

  /** Names bound by the operation being emitted; anything else may belong to `self`. */
  private readonly locals = new Set<string>();

  constructor(
    index: ModuleIndex,
    /** Ports the enclosing class holds, mapped from port name to attribute name. */
    private readonly portFields: ReadonlyMap<string, string> = new Map(),
    /** Attributes of the enclosing class, so bare references to them read as `self.x`. */
    private readonly selfFields: ReadonlySet<string> = new Set(),
  ) {
    super(index);
  }

  /** Opens a fresh local scope; parameters shadow the attributes of the enclosing class. */
  enterOperation(parameters: readonly string[] = []): void {
    this.locals.clear();
    for (const name of parameters) this.locals.add(pythonName(name));
  }

  typeName(type: IRType): string {
    switch (type.kind) {
      case 'primitive':
        return PRIMITIVES[type.name] ?? 'Any';
      case 'named':
        return pascalCase(type.name);
      case 'list':
        return `list[${this.typeName(type.of)}]`;
      case 'set':
        return `set[${this.typeName(type.of)}]`;
      case 'map':
        return `dict[${this.typeName(type.key)}, ${this.typeName(type.value)}]`;
      case 'optional':
        return `${this.typeName(type.of)} | None`;
      case 'result':
        // Checked errors are raised; the contract lives in the docstring.
        return this.typeName(type.ok);
    }
  }

  literal(value: string | number | boolean | null, type: IRType): string {
    if (value === null) return 'None';
    if (typeof value === 'boolean') return value ? 'True' : 'False';
    if (typeof value === 'number') {
      const inner = unwrap(type);
      const decimal = inner.kind === 'primitive' && inner.name === 'decimal';
      return decimal ? `decimal.Decimal("${value}")` : String(value);
    }
    // An unquoted capitalised default refers to an enum member.
    if (type.kind === 'named' && this.index.typed(type.name, 'enum')) {
      return `${pascalCase(type.name)}.${screamingSnakeCase(value)}`;
    }
    // A uuid is a `uuid.UUID` here, and a bare string compares equal to none.
    const inner = unwrap(type);
    if (inner.kind === 'primitive' && inner.name === 'uuid') return `uuid.UUID(${JSON.stringify(value)})`;
    return JSON.stringify(value);
  }

  identifier(name: string): string {
    return pythonName(name);
  }

  member(path: readonly string[]): string {
    return path.map((part, index) => (index === 0 ? this.head(part) : this.identifier(part))).join('.');
  }

  /** The first segment may be an enum member, an attribute of `self`, or a local. */
  private head(name: string): string {
    if (/^[A-Z]/.test(name)) {
      const owner = this.index.enums.find((e) => e.values.some((v) => v.name === name));
      if (owner) return `${pascalCase(owner.name)}.${screamingSnakeCase(name)}`;
      return pascalCase(name);
    }
    const rendered = this.identifier(name);
    return !this.locals.has(rendered) && this.selfFields.has(rendered) ? `self.${rendered}` : rendered;
  }

  call(receiver: string | null, operation: string, args: readonly IRArgument[]): string {
    const owner = this.ownerOf(operation);
    const method = methodName(operation);
    const rendered = this.argumentsOf(args);

    if (owner?.kind === 'port') {
      const field = this.portFields.get(owner.name) ?? attributeName(owner.name);
      return `await self.${field}.${method}(${this.keywords(rendered)})`;
    }
    if (owner?.kind === 'aggregate') {
      // The receiver is passed as the argument named after the aggregate.
      const receiverName = this.identifier(owner.name);
      const instance = rendered.find((a) => a.name === receiverName)?.value ?? 'self';
      const rest = rendered.filter((a) => a.name !== receiverName);
      return `${instance}.${method}(${this.keywords(rest)})`;
    }
    if (receiver) return `await ${pascalCase(receiver)}.${method}(${this.keywords(rendered)})`;
    return `await self.${method}(${this.keywords(rendered)})`;
  }

  construct(typeName: string, args: readonly IRArgument[]): string {
    // Every declared shape is a Pydantic model, so construction is always by keyword.
    return `${pascalCase(typeName)}(${this.keywords(this.argumentsOf(args))})`;
  }

  listLiteral(items: readonly string[], _elementType: IRType | null): string {
    return `[${items.join(', ')}]`;
  }

  now(): string {
    return 'datetime.datetime.now(datetime.UTC)';
  }

  newId(): string {
    return 'uuid.uuid4()';
  }

  projectFn(fn: 'each' | 'only', collection: string, projection: string, elementVar: string, _elementType: IRType | null): string {
    return fn === 'each'
      ? `[${projection} for ${elementVar} in ${collection}]`
      : `[${elementVar} for ${elementVar} in ${collection} if ${projection}]`;
  }

  aggregateFn(
    fn: 'sum' | 'count' | 'min' | 'max' | 'average',
    collection: string,
    projection: string | null,
    elementVar: string,
  ): string {
    const values = projection ? `${projection} for ${elementVar} in ${collection}` : collection;
    switch (fn) {
      case 'count':
        return `len(${collection})`;
      case 'sum':
        return `sum(${values})`;
      case 'average':
        return `(sum(${values}) / len(${collection}) if ${collection} else 0)`;
      case 'min':
        return `min(${values})`;
      case 'max':
        return `max(${values})`;
    }
  }

  binary(operator: BinaryOperator, left: string, right: string, _operandType: IRType | null): string {
    switch (operator) {
      case 'equals':
        return `${left} ${IDENTITIES.has(right) ? 'is' : '=='} ${right}`;
      case 'not-equals':
        return `${left} ${IDENTITIES.has(right) ? 'is not' : '!='} ${right}`;
      case 'greater-than':
        return `${left} > ${right}`;
      case 'greater-or-equal':
        return `${left} >= ${right}`;
      case 'less-than':
        return `${left} < ${right}`;
      case 'less-or-equal':
        return `${left} <= ${right}`;
      case 'add':
        return `(${left} + ${right})`;
      case 'subtract':
        return `(${left} - ${right})`;
      case 'multiply':
        return `(${left} * ${right})`;
      case 'divide':
        return `(${left} / ${right})`;
      case 'and':
        return `(${left} and ${right})`;
      case 'or':
        return `(${left} or ${right})`;
      case 'contains':
        return `${right} in ${left}`;
      case 'starts-with':
        return `${left}.startswith(${right})`;
      case 'ends-with':
        return `${left}.endswith(${right})`;
      case 'matches':
        return `re.fullmatch(${right}, ${left}) is not None`;
    }
  }

  unary(operator: UnaryOperator, operand: string): string {
    switch (operator) {
      case 'not':
        return `not (${operand})`;
      case 'negate':
        return `-(${operand})`;
      case 'is-empty':
        return `len(${operand}) == 0`;
      case 'is-not-empty':
        return `len(${operand}) > 0`;
      case 'is-present':
        return `${operand} is not None`;
      case 'is-absent':
        return `${operand} is None`;
    }
  }

  emitLet(writer: CodeWriter, name: string, value: string): void {
    writer.line(`${name} = ${value}`);
    this.locals.add(name);
  }

  emitSet(writer: CodeWriter, target: string, value: string): void {
    writer.line(`${target} = ${value}`);
  }

  emitPerform(writer: CodeWriter, value: string): void {
    writer.line(value);
  }

  emitReturn(writer: CodeWriter, value: string | null): void {
    writer.line(value === null ? 'return' : `return ${value}`);
  }

  emitFail(writer: CodeWriter, errorName: string, args: readonly IRArgument[]): void {
    writer.line(`raise ${pascalCase(errorName)}(${this.keywords(this.argumentsOf(args))})`);
  }

  emitPublish(writer: CodeWriter, eventName: string, args: readonly IRArgument[]): void {
    const topic = this.index.typed(eventName, 'event')?.topic ?? kebabCase(eventName);
    const payload = `${pascalCase(eventName)}(${this.keywords(this.argumentsOf(args))})`;
    writer.line(`await self._event_publisher.publish("${topic}", ${payload})`);
  }

  emitAppend(writer: CodeWriter, collection: string, value: string): void {
    writer.line(`${collection}.append(${value})`);
  }

  emitRemove(writer: CodeWriter, collection: string, value: string): void {
    writer.line(`${collection} = [candidate for candidate in ${collection} if candidate != ${value}]`);
  }

  emitWhen(writer: CodeWriter, condition: string, then: () => void, otherwise: (() => void) | null): void {
    writer.line(`if ${condition}:`);
    writer.block(then);
    if (otherwise) {
      writer.line('else:');
      writer.block(otherwise);
    }
  }

  emitForEach(writer: CodeWriter, item: string, collection: string, body: () => void): void {
    this.locals.add(item);
    writer.line(`for ${item} in ${collection}:`);
    writer.block(body);
  }

  /** A Python block is never empty, so the placeholder carries a statement. */
  protected override emitEmptyBody(writer: CodeWriter): void {
    writer.line(this.todoComment());
    writer.line('pass');
  }

  protected override todoComment(): string {
    return '# no body declared in the .hadl source';
  }

  protected override commentPrefix(): string {
    return '# ';
  }

  /** Keyword arguments are named after the fields they fill. */
  protected override argumentsOf(args: readonly IRArgument[]): Array<{ name: string; value: string }> {
    return args.map((argument) => ({ name: this.identifier(argument.name), value: this.expression(argument.value) }));
  }

  /** Inside `by ...` every unbound reference belongs to the element, nested paths included. */
  protected override projection(expression: IRExpression, elementVar: string): string {
    const bound = (head: string): boolean => {
      const rendered = this.identifier(head);
      return /^[A-Z]/.test(head) || this.locals.has(rendered) || this.selfFields.has(rendered);
    };
    return this.expression(prefixElement(expression, elementVar, bound));
  }

  private keywords(args: ReadonlyArray<{ name: string; value: string }>): string {
    return args.map((argument) => `${argument.name}=${argument.value}`).join(', ');
  }
}

/** `OrderRepository` -> `_order_repository`, the attribute injected ports are stored in. */
export function attributeName(portName: string): string {
  return `_${snakeCase(portName)}`;
}

/** Comparisons against these render with `is` rather than `==`. */
const IDENTITIES: ReadonlySet<string> = new Set(['None', 'True', 'False']);

/** Rewrites references that are not bound in the enclosing scope as fields of `variable`. */
function prefixElement(expression: IRExpression, variable: string, bound: (head: string) => boolean): IRExpression {
  const recurse = (inner: IRExpression): IRExpression => prefixElement(inner, variable, bound);
  switch (expression.kind) {
    case 'reference':
      return bound(expression.path[0] ?? '') ? expression : { ...expression, path: [variable, ...expression.path] };
    case 'binary':
      return { ...expression, left: recurse(expression.left), right: recurse(expression.right) };
    case 'unary':
      return { ...expression, operand: recurse(expression.operand) };
    case 'call':
    case 'construct':
      return { ...expression, arguments: expression.arguments.map((a) => ({ ...a, value: recurse(a.value) })) };
    case 'aggregate':
      return { ...expression, collection: recurse(expression.collection), of: expression.of ? recurse(expression.of) : null };
    default:
      return expression;
  }
}
