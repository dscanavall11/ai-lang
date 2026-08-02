/** Rust surface syntax for the shared IR walk. */
import {
  escapeReserved,
  pascalCase,
  screamingSnakeCase,
  snakeCase,
  typeToString,
  type BinaryOperator,
  type CodeWriter,
  type IRArgument,
  type IRExpression,
  type IRStatement,
  type IRType,
  type ModuleIndex,
  type UnaryOperator,
} from '@ai-lang/core';
import { LanguageEmitter } from '../../shared/emitter.js';

const PRIMITIVES: Record<string, string> = {
  text: 'String',
  integer: 'i64',
  decimal: 'rust_decimal::Decimal',
  boolean: 'bool',
  uuid: 'uuid::Uuid',
  timestamp: 'chrono::DateTime<chrono::Utc>',
  date: 'chrono::NaiveDate',
  duration: 'chrono::Duration',
  json: 'serde_json::Value',
  bytes: 'Vec<u8>',
  nothing: '()',
};

export interface RustEmitterOptions {
  /** Ports the enclosing struct holds, mapped from port name to field name. */
  portFields?: ReadonlyMap<string, string>;
  /** Field names reachable through `self` inside the enclosing impl block. */
  selfFields?: ReadonlySet<string>;
  /** Per-module error enum every `Result` in this module carries. */
  errorEnum?: string;
}

export class RustEmitter extends LanguageEmitter {
  private readonly portFields: ReadonlyMap<string, string>;
  private readonly selfFields: ReadonlySet<string>;
  readonly errorEnum: string;
  /** Locals that a later statement writes to, so `let` can add `mut`. */
  private mutableLocals: ReadonlySet<string> = new Set();
  private returnsResult = false;

  constructor(index: ModuleIndex, options: RustEmitterOptions = {}) {
    super(index);
    this.portFields = options.portFields ?? new Map();
    this.selfFields = options.selfFields ?? new Set();
    this.errorEnum = options.errorEnum ?? 'DomainError';
  }

  // -- types and names ------------------------------------------------------

  typeName(type: IRType): string {
    switch (type.kind) {
      case 'primitive':
        return PRIMITIVES[type.name] ?? 'serde_json::Value';
      case 'named':
        return pascalCase(type.name);
      case 'list':
        return `Vec<${this.typeName(type.of)}>`;
      case 'set':
        return `std::collections::HashSet<${this.typeName(type.of)}>`;
      case 'map':
        return `std::collections::HashMap<${this.typeName(type.key)}, ${this.typeName(type.value)}>`;
      case 'optional':
        return `Option<${this.typeName(type.of)}>`;
      case 'result':
        return `Result<${this.typeName(type.ok)}, ${this.errorEnum}>`;
    }
  }

  /** Return type of a fallible operation: every port, service and handler call. */
  resultType(type: IRType): string {
    return type.kind === 'result' ? this.typeName(type) : `Result<${this.typeName(type)}, ${this.errorEnum}>`;
  }

  /** Payload carried by `resultType`, used to decide whether `Ok(())` fits. */
  okType(type: IRType): IRType {
    return type.kind === 'result' ? type.ok : type;
  }

  literal(value: string | number | boolean | null, type: IRType): string {
    if (value === null) return 'None';
    if (typeof value === 'boolean') return String(value);
    if (typeof value === 'number') return String(value);
    // An unquoted capitalised default refers to an enum member.
    if (type.kind === 'named') return `${pascalCase(type.name)}::${pascalCase(value)}`;
    if (type.kind === 'primitive' && type.name === 'uuid') return `uuid::Uuid::parse_str(${quote(value)}).unwrap_or_default()`;
    return `${quote(value)}.to_string()`;
  }

  identifier(name: string): string {
    return escapeReserved(snakeCase(name), 'rust');
  }

  /** Operation phrases become method names: "find order by id" -> `find_order_by_id`. */
  methodName(phrase: string): string {
    return escapeReserved(snakeCase(phrase), 'rust');
  }

  member(path: readonly string[]): string {
    return path.map((part, index) => (index === 0 ? this.head(part) : this.identifier(part))).join('.');
  }

  /** The first segment may be an enum member, a field of `self`, or a local. */
  private head(name: string): string {
    if (/^[A-Z]/.test(name)) {
      const owner = this.index.enums.find((e) => e.values.some((v) => v.name === name));
      return owner ? `${pascalCase(owner.name)}::${name}` : pascalCase(name);
    }
    const local = this.identifier(name);
    return this.selfFields.has(name) ? `self.${local}` : local;
  }

  // -- expressions ----------------------------------------------------------

  call(receiver: string | null, operation: string, args: readonly IRArgument[]): string {
    const owner = this.ownerOf(operation);
    const method = this.methodName(operation);

    if (owner?.kind === 'port') {
      const field = this.portFields.get(owner.name) ?? this.identifier(owner.name);
      return `self.${field}.${method}(${this.callArguments(operation, args)}).await?`;
    }
    if (owner?.kind === 'aggregate') {
      // The receiver travels as the argument named after the aggregate.
      const receiverName = this.identifier(owner.name);
      const instance = this.renderedArguments(args).find((a) => a.name === receiverName)?.value ?? 'self';
      return `${instance}.${method}(${this.callArguments(operation, args, receiverName)})?`;
    }
    if (receiver) return `${pascalCase(receiver)}::${method}(${this.callArguments(operation, args)}).await?`;
    return `self.${method}(${this.callArguments(operation, args)}).await?`;
  }

  construct(typeName: string, args: readonly IRArgument[]): string {
    const declaration = this.index.get(typeName);
    const rendered = this.renderedArguments(args);

    // Value objects validate on construction, so they go through `new`.
    if (declaration?.kind === 'value-object') {
      const ordered = declaration.fields.map((f) => rendered.find((a) => a.name === this.identifier(f.name))?.value ?? 'Default::default()');
      return `${pascalCase(typeName)}::new(${ordered.join(', ')})?`;
    }
    return `${pascalCase(typeName)} { ${rendered.map((a) => (a.name === a.value ? a.name : `${a.name}: ${a.value}`)).join(', ')} }`;
  }

  now(): string {
    return 'chrono::Utc::now()';
  }

  newId(): string {
    return 'uuid::Uuid::new_v4()';
  }

  aggregateFn(
    fn: 'sum' | 'count' | 'min' | 'max' | 'average',
    collection: string,
    projection: string | null,
    elementVar: string,
  ): string {
    const values = projection ? `${collection}.iter().map(|${elementVar}| ${projection})` : `${collection}.iter().cloned()`;
    switch (fn) {
      case 'count':
        return `${collection}.len() as i64`;
      case 'sum':
        return `${values}.sum()`;
      case 'min':
        return `${values}.min().unwrap_or_default()`;
      case 'max':
        return `${values}.max().unwrap_or_default()`;
      case 'average':
        // `max(1)` keeps the division defined on an empty collection.
        return `(${values}.sum::<f64>() / (${collection}.len().max(1) as f64))`;
    }
  }

  binary(operator: BinaryOperator, left: string, right: string, _operandType: IRType | null): string {
    switch (operator) {
      case 'equals':
        return `${left} == ${right}`;
      case 'not-equals':
        return `${left} != ${right}`;
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
        return `(${left} && ${right})`;
      case 'or':
        return `(${left} || ${right})`;
      case 'contains':
        return `${left}.contains(&${right})`;
      case 'starts-with':
        return `${left}.starts_with(&${right})`;
      case 'ends-with':
        return `${left}.ends_with(&${right})`;
      case 'matches':
        // `!` coerces to bool, so the placeholder still type-checks.
        return `unimplemented!("regex matching needs a regex crate; compare {} against {}", ${left}, ${right})`;
    }
  }

  unary(operator: UnaryOperator, operand: string): string {
    switch (operator) {
      case 'not':
        return `!(${operand})`;
      case 'negate':
        return `-(${operand})`;
      case 'is-empty':
        return `${operand}.is_empty()`;
      case 'is-not-empty':
        return `!${operand}.is_empty()`;
      case 'is-present':
        return `${operand}.is_some()`;
      case 'is-absent':
        return `${operand}.is_none()`;
    }
  }

  /** Bare field references inside a projection belong to the loop element. */
  protected override projection(expression: IRExpression, elementVar: string): string {
    return this.expression(prefixHead(expression, elementVar));
  }

  // -- statements -----------------------------------------------------------

  emitLet(writer: CodeWriter, name: string, value: string): void {
    const mutable = this.mutableLocals.has(name) ? 'mut ' : '';
    writer.line(`let ${mutable}${name} = ${value};`);
  }

  emitSet(writer: CodeWriter, target: string, value: string): void {
    writer.line(`${target} = ${value};`);
  }

  emitPerform(writer: CodeWriter, value: string): void {
    writer.line(`${value};`);
  }

  emitReturn(writer: CodeWriter, value: string | null): void {
    if (value === null) writer.line(this.returnsResult ? 'return Ok(());' : 'return;');
    else writer.line(this.returnsResult ? `return Ok(${value});` : `return ${value};`);
  }

  emitFail(writer: CodeWriter, errorName: string, args: readonly IRArgument[]): void {
    const declaration = this.index.typed(errorName, 'error');
    // Unchecked errors are defects, so they abort instead of joining the contract.
    if (declaration && !declaration.checked) {
      writer.line(this.panic(declaration.message, args));
      return;
    }
    const rendered = this.renderedArguments(args);
    const payload = rendered.length > 0 ? ` { ${rendered.map((a) => `${a.name}: ${a.value}`).join(', ')} }` : '';
    writer.line(`return Err(${this.errorEnum}::${pascalCase(errorName)}${payload});`);
  }

  emitPublish(writer: CodeWriter, eventName: string, args: readonly IRArgument[]): void {
    const topic = `${screamingSnakeCase(eventName)}_TOPIC`;
    const payload = this.construct(eventName, args);
    writer.line(`self.event_publisher.publish(${topic}, serde_json::json!(${payload})).await;`);
  }

  emitAppend(writer: CodeWriter, collection: string, value: string): void {
    writer.line(`${collection}.push(${value});`);
  }

  emitRemove(writer: CodeWriter, collection: string, value: string): void {
    writer.line(`${collection}.retain(|candidate| candidate != &${value});`);
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
    writer.line(`for ${item} in &${collection} {`);
    writer.block(body);
    writer.line('}');
  }

  /** Emits a body plus the trailing tail expression Rust expects. */
  emitOperationBody(writer: CodeWriter, body: readonly IRStatement[], returns: IRType, fallible: boolean): void {
    this.returnsResult = fallible;
    this.mutableLocals = mutatedLocals(body);
    this.emitBlock(writer, body);

    if (body.length > 0 && body[body.length - 1]?.kind === 'return') return;
    const unit = isUnit(this.okType(returns));
    if (fallible) writer.line(unit ? 'Ok(())' : 'Ok(Default::default())');
    else if (!unit) writer.line('Default::default()');
  }

  /** Renders a documentation line describing the AI-Lang type it came from. */
  describeType(type: IRType): string {
    return typeToString(type);
  }

  // -- helpers --------------------------------------------------------------

  private renderedArguments(args: readonly IRArgument[]): Array<{ name: string; value: string }> {
    return args.map((argument) => ({ name: this.identifier(argument.name), value: this.expression(argument.value) }));
  }

  /** Rust calls are positional, so arguments are reordered to match the signature. */
  private callArguments(phrase: string, args: readonly IRArgument[], skip?: string): string {
    const rendered = this.renderedArguments(args).filter((a) => a.name !== skip);
    const signature = this.index.resolvePhrase(phrase)[0]?.operation;
    if (!signature) return rendered.map((a) => a.value).join(', ');
    return signature.parameters
      .map((parameter) => this.identifier(parameter.name))
      .filter((name) => name !== skip)
      .map((name) => rendered.find((a) => a.name === name)?.value ?? 'Default::default()')
      .join(', ');
  }

  private panic(message: string, args: readonly IRArgument[]): string {
    const rendered = this.renderedArguments(args);
    const values: string[] = [];
    const template = message.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
      const argument = rendered.find((a) => a.name === this.identifier(name));
      if (!argument) return match.replace('{', '{{').replace('}', '}}');
      values.push(argument.value);
      return '{}';
    });
    return values.length > 0 ? `panic!(${quote(template)}, ${values.join(', ')});` : `panic!(${quote(template)});`;
  }
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function isUnit(type: IRType): boolean {
  return type.kind === 'primitive' && type.name === 'nothing';
}

/** Locals a later statement writes to; they need `let mut`. */
function mutatedLocals(statements: readonly IRStatement[]): ReadonlySet<string> {
  const names = new Set<string>();
  const walk = (block: readonly IRStatement[]): void => {
    for (const statement of block) {
      switch (statement.kind) {
        case 'set':
        case 'append':
        case 'remove': {
          const head = statement.kind === 'set' ? statement.target[0] : statement.collection[0];
          if (head) names.add(escapeReserved(snakeCase(head), 'rust'));
          break;
        }
        case 'when':
          walk(statement.then);
          walk(statement.otherwise);
          break;
        case 'for-each':
          walk(statement.body);
          break;
        default:
          break;
      }
    }
  };
  walk(statements);
  return names;
}

/** Rewrites `quantity` and `unitPrice.amount` as members of `variable`. */
function prefixHead(expression: IRExpression, variable: string): IRExpression {
  switch (expression.kind) {
    case 'reference':
      return /^[a-z]/.test(expression.path[0] ?? '') ? { ...expression, path: [variable, ...expression.path] } : expression;
    case 'binary':
      return { ...expression, left: prefixHead(expression.left, variable), right: prefixHead(expression.right, variable) };
    case 'unary':
      return { ...expression, operand: prefixHead(expression.operand, variable) };
    case 'call':
    case 'construct':
      return { ...expression, arguments: expression.arguments.map((a) => ({ ...a, value: prefixHead(a.value, variable) })) };
    case 'aggregate':
      return {
        ...expression,
        collection: prefixHead(expression.collection, variable),
        of: expression.of ? prefixHead(expression.of, variable) : null,
      };
    default:
      return expression;
  }
}
