/** TypeScript surface syntax for the shared IR walk. */
import {
  camelCase,
  escapeReserved,
  pascalCase,
  typeToString,
  type BinaryOperator,
  type CodeWriter,
  type IRArgument,
  type IRType,
  type ModuleIndex,
  type UnaryOperator,
} from '@ai-lang/core';
import { LanguageEmitter } from '../../shared/emitter.js';

const PRIMITIVES: Record<string, string> = {
  text: 'string',
  integer: 'number',
  decimal: 'number',
  boolean: 'boolean',
  uuid: 'string',
  timestamp: 'Date',
  date: 'string',
  duration: 'number',
  json: 'unknown',
  bytes: 'Uint8Array',
  nothing: 'void',
};

export class TypeScriptEmitter extends LanguageEmitter {
  constructor(
    index: ModuleIndex,
    /** Ports the enclosing class holds, mapped from port name to field name. */
    private readonly portFields: ReadonlyMap<string, string> = new Map(),
    /**
     * Fields of the enclosing class. Inside an aggregate, `items` in the source
     * means `this.items` in the output; parameters shadow them and are excluded.
     */
    private readonly selfFields: ReadonlySet<string> = new Set(),
  ) {
    super(index);
  }

  typeName(type: IRType): string {
    switch (type.kind) {
      case 'primitive':
        return PRIMITIVES[type.name] ?? 'unknown';
      case 'named':
        return pascalCase(type.name);
      case 'list':
        return `${this.typeName(type.of)}[]`;
      case 'set':
        return `Set<${this.typeName(type.of)}>`;
      case 'map':
        return `Map<${this.typeName(type.key)}, ${this.typeName(type.value)}>`;
      case 'optional':
        return `${this.typeName(type.of)} | null`;
      case 'result':
        // Checked errors are thrown; the contract lives in the JSDoc `@throws`.
        return this.typeName(type.ok);
    }
  }

  literal(value: string | number | boolean | null, type: IRType): string {
    if (value === null) return 'null';
    if (typeof value === 'string') {
      // An unquoted capitalised default refers to an enum member.
      if (type.kind === 'named') return `${pascalCase(type.name)}.${value}`;
      return JSON.stringify(value);
    }
    return String(value);
  }

  identifier(name: string): string {
    return escapeReserved(camelCase(name), 'typescript');
  }

  member(path: readonly string[]): string {
    return path.map((part, index) => (index === 0 ? this.head(part) : this.identifier(part))).join('.');
  }

  /** The first segment may be a field of `this`, a local, or an enum member. */
  private head(name: string): string {
    if (/^[A-Z]/.test(name)) {
      const owner = this.index.enums.find((e) => e.values.some((v) => v.name === name));
      if (owner) return `${pascalCase(owner.name)}.${name}`;
      return pascalCase(name);
    }
    if (this.selfFields.has(name)) return `this.${this.identifier(name)}`;
    return this.identifier(name);
  }

  call(receiver: string | null, operation: string, args: readonly IRArgument[]): string {
    const owner = this.ownerOf(operation);
    const method = camelCase(operation);
    const rendered = this.argumentsOf(args);

    if (owner?.kind === 'port') {
      const field = this.portFields.get(owner.name) ?? camelCase(owner.name);
      return `await this.${field}.${method}(${this.argumentObject(rendered)})`;
    }
    if (owner?.kind === 'aggregate') {
      // The receiver is passed as the argument named after the aggregate.
      const receiverName = camelCase(owner.name);
      const instance = rendered.find((a) => a.name === receiverName)?.value ?? 'this';
      const rest = rendered.filter((a) => a.name !== receiverName);
      return `${instance}.${method}(${this.argumentObject(rest)})`;
    }
    if (receiver) return `await ${pascalCase(receiver)}.${method}(${this.argumentObject(rendered)})`;
    return `await this.${method}(${this.argumentObject(rendered)})`;
  }

  private argumentObject(args: Array<{ name: string; value: string }>): string {
    if (args.length === 0) return '';
    return `{ ${args.map((a) => (a.name === a.value ? a.name : `${a.name}: ${a.value}`)).join(', ')} }`;
  }

  construct(typeName: string, args: readonly IRArgument[]): string {
    const declaration = this.index.get(typeName);
    const rendered = this.argumentsOf(args);
    const literal = `{ ${rendered.map((a) => (a.name === a.value ? a.name : `${a.name}: ${a.value}`)).join(', ')} }`;

    // Value objects, entities and aggregates are classes; the rest are plain shapes.
    if (declaration?.kind === 'value-object' || declaration?.kind === 'entity' || declaration?.kind === 'aggregate') {
      return `new ${pascalCase(typeName)}(${literal})`;
    }
    return `${literal} satisfies ${pascalCase(typeName)}`;
  }

  listLiteral(items: readonly string[], _elementType: IRType | null): string {
    return `[${items.join(', ')}]`;
  }

  now(): string {
    return 'new Date()';
  }

  newId(): string {
    return 'randomUUID()';
  }

  projectFn(fn: 'each' | 'only', collection: string, projection: string, elementVar: string, _elementType: IRType | null): string {
    return `${collection}.${fn === 'each' ? 'map' : 'filter'}((${elementVar}) => ${projection})`;
  }

  aggregateFn(
    fn: 'sum' | 'count' | 'min' | 'max' | 'average',
    collection: string,
    projection: string | null,
    elementVar: string,
  ): string {
    const map = projection ? `${collection}.map((${elementVar}) => ${projection})` : collection;
    switch (fn) {
      case 'count':
        return `${collection}.length`;
      case 'sum':
        return `${map}.reduce((total, value) => total + value, 0)`;
      case 'average':
        return `(${map}.reduce((total, value) => total + value, 0) / Math.max(1, ${collection}.length))`;
      case 'min':
        return `Math.min(...${map})`;
      case 'max':
        return `Math.max(...${map})`;
    }
  }

  binary(operator: BinaryOperator, left: string, right: string, _operandType: IRType | null): string {
    switch (operator) {
      case 'equals':
        return `${left} === ${right}`;
      case 'not-equals':
        return `${left} !== ${right}`;
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
        return `${left}.includes(${right})`;
      case 'starts-with':
        return `${left}.startsWith(${right})`;
      case 'ends-with':
        return `${left}.endsWith(${right})`;
      case 'matches':
        return `new RegExp(${right}).test(${left})`;
    }
  }

  unary(operator: UnaryOperator, operand: string): string {
    switch (operator) {
      case 'not':
        return `!(${operand})`;
      case 'negate':
        return `-(${operand})`;
      case 'is-empty':
        return `${operand}.length === 0`;
      case 'is-not-empty':
        return `${operand}.length > 0`;
      case 'is-present':
        return `${operand} !== null && ${operand} !== undefined`;
      case 'is-absent':
        return `${operand} === null || ${operand} === undefined`;
    }
  }

  emitLet(writer: CodeWriter, name: string, value: string): void {
    writer.line(`const ${name} = ${value};`);
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
    const rendered = this.argumentsOf(args);
    const payload = rendered.length > 0 ? `{ ${rendered.map((a) => `${a.name}: ${a.value}`).join(', ')} }` : '{}';
    writer.line(`throw new ${pascalCase(errorName)}(${payload});`);
  }

  emitPublish(writer: CodeWriter, eventName: string, args: readonly IRArgument[]): void {
    const rendered = this.argumentsOf(args);
    const payload = `{ ${rendered.map((a) => (a.name === a.value ? a.name : `${a.name}: ${a.value}`)).join(', ')} }`;
    writer.line(`await this.eventPublisher.publish('${pascalCase(eventName)}', ${payload});`);
  }

  emitAppend(writer: CodeWriter, collection: string, value: string): void {
    writer.line(`${collection}.push(${value});`);
  }

  emitRemove(writer: CodeWriter, collection: string, value: string): void {
    writer.line(`${collection} = ${collection}.filter((candidate) => candidate !== ${value});`);
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
    writer.line(`for (const ${item} of ${collection}) {`);
    writer.block(body);
    writer.line('}');
  }

  /** Renders a documentation line describing the AI-Lang type it came from. */
  describeType(type: IRType): string {
    return typeToString(type);
  }
}
