/** Java surface syntax for the shared IR walk. */
import {
  camelCase,
  escapeReserved,
  pascalCase,
  screamingSnakeCase,
  typeToString,
  unwrap,
  type BinaryOperator,
  type CodeWriter,
  type IRArgument,
  type IRDeclaration,
  type IRExpression,
  type IRField,
  type IRParameter,
  type IRStatement,
  type IRType,
  type ModuleIndex,
  type UnaryOperator,
} from '@haic/core';
import { LanguageEmitter } from '../../shared/emitter.js';

/**
 * `decimal` becomes `double` rather than `BigDecimal`: the shared walk hands
 * `binary()` operands it cannot type, so `a.add(b)` versus `a + b` would be a
 * guess on every arithmetic node. One numeric syntax beats a broken one.
 */
const PRIMITIVES: Record<string, string> = {
  text: 'String',
  integer: 'long',
  decimal: 'double',
  boolean: 'boolean',
  uuid: 'java.util.UUID',
  timestamp: 'java.time.Instant',
  date: 'java.time.LocalDate',
  duration: 'java.time.Duration',
  json: 'Object',
  bytes: 'byte[]',
  nothing: 'void',
};

/** Generic arguments and nullable fields cannot hold a Java primitive. */
const BOXED: Record<string, string> = {
  integer: 'Long',
  decimal: 'Double',
  boolean: 'Boolean',
  nothing: 'Void',
};

const ARITHMETIC = new Set<BinaryOperator>(['add', 'subtract', 'multiply', 'divide']);

export interface JavaEmitterOptions {
  /** Ports the enclosing class holds, mapped from port name to field name. */
  portFields?: ReadonlyMap<string, string>;
  /** Declaration whose body is being emitted; bare names resolve against its fields. */
  self?: IRDeclaration;
  /** `local` renders own fields bare, as a record's compact constructor requires. */
  fieldAccess?: 'this' | 'local';
}

export class JavaEmitter extends LanguageEmitter {
  readonly target = 'java' as const;

  private readonly portFields: ReadonlyMap<string, string>;
  private readonly self: IRDeclaration | undefined;
  private readonly fieldAccess: 'this' | 'local';
  /** Names in scope with their declared type, so `a.b` picks the right accessor. */
  private readonly locals = new Map<string, IRType>();

  constructor(index: ModuleIndex, options: JavaEmitterOptions = {}) {
    super(index);
    this.portFields = options.portFields ?? new Map();
    this.self = options.self;
    this.fieldAccess = options.fieldAccess ?? 'this';
  }

  /** Seeds a name whose type is known from a signature rather than from a statement. */
  declareLocal(name: string, type: IRType): this {
    this.locals.set(name, type);
    return this;
  }

  // -- types ----------------------------------------------------------------

  typeName(type: IRType): string {
    switch (type.kind) {
      case 'primitive':
        return PRIMITIVES[type.name] ?? 'Object';
      case 'named':
        return pascalCase(type.name);
      case 'list':
        return `java.util.List<${this.boxedTypeName(type.of)}>`;
      case 'set':
        return `java.util.Set<${this.boxedTypeName(type.of)}>`;
      case 'map':
        return `java.util.Map<${this.boxedTypeName(type.key)}, ${this.boxedTypeName(type.value)}>`;
      case 'optional':
        // Absence is `null`, so the carried type must be a reference type.
        return this.boxedTypeName(type.of);
      case 'result':
        // Checked errors leave through `throws`; only the ok type is returned.
        return this.typeName(type.ok);
    }
  }

  boxedTypeName(type: IRType): string {
    if (type.kind === 'primitive') return BOXED[type.name] ?? PRIMITIVES[type.name] ?? 'Object';
    return this.typeName(type);
  }

  /** Value used when a shape is constructed without one of its fields. */
  defaultValue(type: IRType): string {
    const inner = type.kind === 'optional' ? type.of : type;
    if (inner.kind === 'list') return 'java.util.List.of()';
    if (inner.kind === 'set') return 'java.util.Set.of()';
    if (inner.kind === 'map') return 'java.util.Map.of()';
    if (type.kind !== 'optional' && inner.kind === 'primitive') {
      if (inner.name === 'integer') return '0L';
      if (inner.name === 'decimal') return '0.0';
      if (inner.name === 'boolean') return 'false';
    }
    return 'null';
  }

  /** Renders a documentation line describing the HADL type it came from. */
  describeType(type: IRType): string {
    return typeToString(type);
  }

  // -- names and expressions ------------------------------------------------

  literal(value: string | number | boolean | null, type: IRType): string {
    if (value === null) return 'null';
    if (typeof value === 'string') {
      if (type.kind === 'named') return `${pascalCase(type.name)}.${enumConstant(value)}`;
      return JSON.stringify(value);
    }
    if (typeof value === 'boolean') return String(value);
    return type.kind === 'primitive' && type.name === 'integer' ? `${value}L` : String(value);
  }

  identifier(name: string): string {
    return escapeReserved(camelCase(name), 'java');
  }

  member(path: readonly string[]): string {
    const [head, ...rest] = path;
    if (head === undefined) return 'this';

    let rendered = this.head(head);
    let current = this.headType(head);
    for (const segment of rest) {
      const owner = namedOf(current);
      rendered += `.${this.accessor(owner, segment)}`;
      current = owner ? this.fieldType(owner, segment) : null;
    }
    return rendered;
  }

  /** The first segment may be an enum member, a local, or a field of the enclosing shape. */
  private head(name: string): string {
    if (/^[A-Z]/.test(name)) {
      const owner = this.index.enums.find((e) => e.values.some((v) => v.name === name));
      return owner ? `${pascalCase(owner.name)}.${enumConstant(name)}` : pascalCase(name);
    }
    if (this.locals.has(name)) return this.identifier(name);
    if (this.selfField(name)) return this.fieldAccess === 'local' ? this.identifier(name) : `this.${this.identifier(name)}`;
    return this.identifier(name);
  }

  /** Records expose `x()`, entities and aggregates expose `getX()`. */
  private accessor(owner: string | null, field: string): string {
    const declaration = owner ? this.index.get(owner) : undefined;
    const isRecord =
      declaration?.kind === 'value-object' ||
      declaration?.kind === 'command' ||
      declaration?.kind === 'event' ||
      declaration?.kind === 'dto';
    return isRecord ? `${this.identifier(field)}()` : `get${pascalCase(field)}()`;
  }

  call(receiver: string | null, operation: string, args: readonly IRArgument[]): string {
    const resolved = this.index.resolvePhrase(operation)[0];
    const owner = resolved?.owner;
    const method = camelCase(operation);
    const rendered = this.argumentsOf(args);

    if (owner?.kind === 'port') {
      const field = this.portFields.get(owner.name) ?? camelCase(owner.name);
      return `this.${field}.${method}(${this.operationArguments(resolved?.operation.parameters, rendered)})`;
    }
    if (owner?.kind === 'aggregate') {
      // The receiver travels as the argument named after the aggregate.
      const receiverName = camelCase(owner.name);
      const instance = rendered.find((a) => a.name === receiverName)?.value ?? 'this';
      const rest = rendered.filter((a) => a.name !== receiverName);
      return `${instance}.${method}(${this.operationArguments(resolved?.operation.parameters, rest)})`;
    }
    const target = receiver ? pascalCase(receiver) : 'this';
    return `${target}.${method}(${this.operationArguments(resolved?.operation.parameters, rendered)})`;
  }

  construct(typeName: string, args: readonly IRArgument[]): string {
    return `new ${pascalCase(typeName)}(${this.shapeArguments(typeName, args)})`;
  }

  listLiteral(items: readonly string[], _elementType: IRType | null): string {
    return items.length === 0 ? 'java.util.List.of()' : `java.util.List.of(${items.join(', ')})`;
  }

  now(): string {
    return 'java.time.Instant.now()';
  }

  newId(): string {
    return 'java.util.UUID.randomUUID()';
  }

  projectFn(fn: 'each' | 'only', collection: string, projection: string, elementVar: string, _elementType: IRType | null): string {
    // toList() since 16, and the generated pom targets 21.
    const stage = fn === 'each' ? 'map' : 'filter';
    return `${collection}.stream().${stage}(${elementVar} -> ${projection}).toList()`;
  }

  aggregateFn(
    fn: 'sum' | 'count' | 'min' | 'max' | 'average',
    collection: string,
    projection: string | null,
    elementVar: string,
  ): string {
    const numbers = `${collection}.stream().mapToDouble(${elementVar} -> ${projection ?? elementVar})`;
    switch (fn) {
      case 'count':
        return `${collection}.size()`;
      case 'sum':
        return `${numbers}.sum()`;
      case 'average':
        return `${numbers}.average().orElse(0.0)`;
      case 'min':
        return `${numbers}.min().orElse(0.0)`;
      case 'max':
        return `${numbers}.max().orElse(0.0)`;
    }
  }

  binary(operator: BinaryOperator, left: string, right: string, operandType: IRType | null): string {
    switch (operator) {
      case 'equals':
        return isValueType(operandType) ? `${left} == ${right}` : `java.util.Objects.equals(${left}, ${right})`;
      case 'not-equals':
        return isValueType(operandType) ? `${left} != ${right}` : `!java.util.Objects.equals(${left}, ${right})`;
      // Instant, LocalDate and BigDecimal have no relational operators, so all
      // ordering goes through one Comparable helper that boxing makes universal.
      case 'greater-than':
        return `Ordering.gt(${left}, ${right})`;
      case 'greater-or-equal':
        return `Ordering.ge(${left}, ${right})`;
      case 'less-than':
        return `Ordering.lt(${left}, ${right})`;
      case 'less-or-equal':
        return `Ordering.le(${left}, ${right})`;
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
        return `${left}.contains(${right})`;
      case 'starts-with':
        return `${left}.startsWith(${right})`;
      case 'ends-with':
        return `${left}.endsWith(${right})`;
      case 'matches':
        return `${left}.matches(${right})`;
    }
  }

  unary(operator: UnaryOperator, operand: string): string {
    switch (operator) {
      case 'not':
        return `!(${operand})`;
      case 'negate':
        return `-(${operand})`;
      case 'is-empty':
        return `${operand}.isEmpty()`;
      case 'is-not-empty':
        return `!${operand}.isEmpty()`;
      case 'is-present':
        return `${operand} != null`;
      case 'is-absent':
        return `${operand} == null`;
    }
  }

  // -- statements -----------------------------------------------------------

  emitLet(writer: CodeWriter, name: string, value: string): void {
    writer.line(`var ${name} = ${value};`);
  }

  emitSet(writer: CodeWriter, target: string, value: string): void {
    writer.line(`${target} = ${value};`);
  }

  emitPerform(writer: CodeWriter, value: string): void {
    writer.line(`${value};`);
  }

  emitReturn(writer: CodeWriter, value: string | null): void {
    writer.line(value === null ? 'return;' : `return ${value};`);
  }

  emitFail(writer: CodeWriter, errorName: string, args: readonly IRArgument[]): void {
    writer.line(`throw new ${pascalCase(errorName)}(${this.shapeArguments(errorName, args)});`);
  }

  emitPublish(writer: CodeWriter, eventName: string, args: readonly IRArgument[]): void {
    const type = pascalCase(eventName);
    writer.line(`this.eventPublisher.publish(${type}.TOPIC, new ${type}(${this.shapeArguments(eventName, args)}));`);
  }

  emitAppend(writer: CodeWriter, collection: string, value: string): void {
    writer.line(`${collection}.add(${value});`);
  }

  emitRemove(writer: CodeWriter, collection: string, value: string): void {
    writer.line(`${collection}.remove(${value});`);
  }

  emitWhen(writer: CodeWriter, condition: string, then: () => void, otherwise: (() => void) | null): void {
    writer.line(`if (${condition}) {`);
    writer.block(then);
    if (otherwise) {
      writer.line('} else {');
      writer.block(otherwise);
    }
    writer.line('}');
  }

  emitForEach(writer: CodeWriter, item: string, collection: string, body: () => void): void {
    writer.line(`for (var ${item} : ${collection}) {`);
    writer.block(body);
    writer.line('}');
  }

  override emitStatement(writer: CodeWriter, statement: IRStatement): void {
    switch (statement.kind) {
      case 'let': {
        const value = this.expression(statement.value);
        const type = this.typeOf(statement.value);
        if (type) this.locals.set(statement.name, type);
        this.emitLet(writer, this.identifier(statement.name), value);
        return;
      }
      case 'set': {
        // Fields are private, so an assignment to `a.b` has to go through `setB`.
        const value = this.expression(statement.value);
        const last = statement.target[statement.target.length - 1] ?? 'value';
        if (statement.target.length === 1) {
          this.emitSet(writer, this.head(last), value);
          return;
        }
        writer.line(`${this.member(statement.target.slice(0, -1))}.set${pascalCase(last)}(${value});`);
        return;
      }
      case 'for-each': {
        const collection = this.expression(statement.collection);
        const element = elementOf(this.typeOf(statement.collection));
        if (element) this.locals.set(statement.item, element);
        this.emitForEach(writer, this.identifier(statement.item), collection, () => this.emitBlock(writer, statement.body));
        return;
      }
      default:
        super.emitStatement(writer, statement);
    }
  }

  override expression(expression: IRExpression): string {
    // Java needs the operand type to choose between `==` and `Objects.equals`.
    if (expression.kind === 'binary') {
      const operandType = this.typeOf(expression.left) ?? this.typeOf(expression.right);
      return this.binary(expression.operator, this.expression(expression.left), this.expression(expression.right), operandType);
    }
    // The shared walk renders the projection right after this, with `each` bound.
    if (expression.kind === 'aggregate') {
      const element = elementOf(this.typeOf(expression.collection));
      if (element) this.locals.set('each', element);
    }
    return super.expression(expression);
  }

  // -- type inference -------------------------------------------------------

  /** Best-effort static type of an expression. `null` means "unknown, fall back". */
  private typeOf(expression: IRExpression): IRType | null {
    switch (expression.kind) {
      case 'literal':
        return expression.type;
      case 'reference':
        return this.referenceType(expression.path);
      case 'now':
        return { kind: 'primitive', name: 'timestamp' };
      case 'new-id':
        return { kind: 'primitive', name: 'uuid' };
      case 'construct':
        return { kind: 'named', name: expression.type };
      case 'call': {
        const resolved = this.index.resolvePhrase(expression.operation)[0];
        return resolved ? unwrap(resolved.operation.returns) : null;
      }
      case 'list':
        return expression.elementType ? { kind: 'list', of: expression.elementType } : null;
      case 'aggregate':
        if (expression.fn === 'count') return { kind: 'primitive', name: 'integer' };
        return { kind: 'primitive', name: 'decimal' };
      case 'project':
        return expression.elementType ? { kind: 'list', of: expression.elementType } : null;
      case 'binary':
        return ARITHMETIC.has(expression.operator) ? this.typeOf(expression.left) : { kind: 'primitive', name: 'boolean' };
      case 'unary':
        return expression.operator === 'negate' ? this.typeOf(expression.operand) : { kind: 'primitive', name: 'boolean' };
    }
  }

  private referenceType(path: readonly string[]): IRType | null {
    const [head, ...rest] = path;
    if (head === undefined) return null;

    let current = this.headType(head);
    for (const segment of rest) {
      const owner = namedOf(current);
      current = owner ? this.fieldType(owner, segment) : null;
    }
    return current;
  }

  private headType(name: string): IRType | null {
    const local = this.locals.get(name);
    if (local) return local;
    const field = this.selfField(name);
    if (field) return field.type;
    const owner = this.index.enums.find((e) => e.values.some((v) => v.name === name));
    return owner ? { kind: 'named', name: owner.name } : null;
  }

  private selfField(name: string): IRField | undefined {
    return fieldsOf(this.self).find((f) => f.name === name);
  }

  private fieldType(owner: string, field: string): IRType | null {
    return fieldsOf(this.index.get(owner)).find((f) => f.name === field)?.type ?? null;
  }

  // -- argument lists -------------------------------------------------------

  /** Records and error classes take their fields positionally, in declaration order. */
  private shapeArguments(typeName: string, args: readonly IRArgument[]): string {
    const fields = fieldsOf(this.index.get(typeName));
    const rendered = this.argumentsOf(args);
    if (fields.length === 0) return rendered.map((a) => a.value).join(', ');
    return fields
      .map((field) => rendered.find((a) => a.name === camelCase(field.name))?.value ?? this.defaultValue(field.type))
      .join(', ');
  }

  private operationArguments(
    parameters: readonly IRParameter[] | undefined,
    rendered: ReadonlyArray<{ name: string; value: string }>,
  ): string {
    if (!parameters || parameters.length === 0) return rendered.map((a) => a.value).join(', ');
    return parameters.map((p) => rendered.find((a) => a.name === camelCase(p.name))?.value ?? 'null').join(', ');
  }
}

/** Fields of any declaration that carries them; `[]` for ports, services and the rest. */
export function fieldsOf(declaration: IRDeclaration | undefined): readonly IRField[] {
  return declaration && 'fields' in declaration ? declaration.fields : [];
}

export function enumConstant(name: string): string {
  return screamingSnakeCase(name);
}

/** Types compared with `==` rather than `Objects.equals`. */
function isValueType(type: IRType | null): boolean {
  if (!type || type.kind !== 'primitive') return false;
  return type.name === 'integer' || type.name === 'decimal' || type.name === 'boolean';
}

function namedOf(type: IRType | null): string | null {
  if (!type) return null;
  const inner = unwrap(type);
  return inner.kind === 'named' ? inner.name : null;
}

function elementOf(type: IRType | null): IRType | null {
  if (!type) return null;
  const inner = unwrap(type);
  if (inner.kind === 'list' || inner.kind === 'set') return inner.of;
  if (inner.kind === 'map') return inner.value;
  return null;
}
