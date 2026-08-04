/**
 * Shared statement and expression lowering.
 *
 * Every backend walks the same IR in the same order; only the surface syntax
 * differs. `LanguageEmitter` owns the walk and delegates the language-specific
 * fragments to abstract hooks, so a new target implements roughly twenty small
 * methods instead of re-deriving control flow.
 */
import {
  CodeWriter,
  camelCase,
  implementationFor,
  unwrap,
  type BinaryOperator,
  type CodegenTarget,
  type IRArgument,
  type IRDeclaration,
  type IRExpression,
  type IROperation,
  type IRStatement,
  type IRType,
  type ModuleIndex,
  type UnaryOperator,
} from '@haic/core';

export interface EmitterOptions {
  index: ModuleIndex;
  /** Name of the operation currently being emitted, used in error messages. */
  operation?: string;
}

export abstract class LanguageEmitter {
  constructor(protected readonly index: ModuleIndex) {}

  /** Backend this emitter lowers into; decides which native block it may use. */
  abstract readonly target: CodegenTarget;

  // -- required hooks -------------------------------------------------------

  /** Renders an IR type as a type annotation in the target language. */
  abstract typeName(type: IRType): string;

  /** Renders a literal value. */
  abstract literal(value: string | number | boolean | null, type: IRType): string;

  /** Local variable / field name in target casing. */
  abstract identifier(name: string): string;

  /** `a.b.c` in target syntax, already cased. */
  abstract member(path: readonly string[]): string;

  /** A call to an operation, with the owner already resolved. */
  abstract call(receiver: string | null, operation: string, args: readonly IRArgument[]): string;

  /** Construction of a declared shape. */
  abstract construct(typeName: string, args: readonly IRArgument[]): string;

  /** `now` and `new id` intrinsics. */
  abstract now(): string;
  abstract newId(): string;

  /** A list literal. `elementType` is set by the analyzer when it is known. */
  abstract listLiteral(items: readonly string[], elementType: IRType | null): string;

  /** Aggregate helpers over a collection expression. */
  abstract aggregateFn(fn: 'sum' | 'count' | 'min' | 'max' | 'average', collection: string, projection: string | null, elementVar: string): string;

  /**
   * Map and filter, which answer with a list rather than a scalar.
   *
   * `elementType` is the element of the *result*, which the statically typed
   * backends need in order to name the collector or the slice they build.
   */
  abstract projectFn(fn: 'each' | 'only', collection: string, projection: string, elementVar: string, elementType: IRType | null): string;

  /** Binary and unary operators. */
  abstract binary(operator: BinaryOperator, left: string, right: string, operandType: IRType | null): string;
  abstract unary(operator: UnaryOperator, operand: string): string;

  // -- statement hooks ------------------------------------------------------

  abstract emitLet(writer: CodeWriter, name: string, value: string): void;
  abstract emitSet(writer: CodeWriter, target: string, value: string): void;
  abstract emitPerform(writer: CodeWriter, value: string): void;
  abstract emitReturn(writer: CodeWriter, value: string | null): void;
  abstract emitFail(writer: CodeWriter, errorName: string, args: readonly IRArgument[]): void;
  abstract emitPublish(writer: CodeWriter, eventName: string, args: readonly IRArgument[]): void;
  abstract emitAppend(writer: CodeWriter, collection: string, value: string): void;
  abstract emitRemove(writer: CodeWriter, collection: string, value: string): void;
  abstract emitWhen(writer: CodeWriter, condition: string, then: () => void, otherwise: (() => void) | null): void;
  abstract emitForEach(writer: CodeWriter, item: string, collection: string, body: () => void): void;

  // -- shared walk ----------------------------------------------------------

  /**
   * Emits an operation's body: the fenced block written for this target when
   * there is one, the lowered statements otherwise.
   *
   * Native code is copied out line for line, only re-indented to sit where the
   * body belongs. Nothing rewrites it — the point of writing it was that the
   * author, not the compiler, decides what it says. Backends read the answer to
   * skip the fix-ups they apply to code they generated themselves, such as
   * Go's trailing zero-value return.
   */
  emitImplementation(writer: CodeWriter, operation: IROperation): 'native' | 'statements' | 'missing' {
    const chosen = implementationFor(operation, this.target);
    if (chosen.kind === 'native') {
      writer.line(`${this.commentPrefix()}Written in ${chosen.block.dialect} in the .hadl source, copied verbatim.`);
      for (const line of chosen.block.code) writer.line(line);
      return 'native';
    }
    if (chosen.kind === 'missing') {
      // The build reports this as an error before any file is written; the
      // comment is here so a partial output is never silently wrong.
      writer.line(`${this.commentPrefix()}No ${this.target} body: this operation is written for ${chosen.written.join(', ')}.`);
      this.emitEmptyBody(writer);
      return 'missing';
    }
    this.emitBlock(writer, operation.body);
    return 'statements';
  }

  /** Line-comment marker of the target language. */
  protected commentPrefix(): string {
    return '// ';
  }

  emitBlock(writer: CodeWriter, statements: readonly IRStatement[]): void {
    if (statements.length === 0) {
      this.emitEmptyBody(writer);
      return;
    }
    for (const statement of statements) this.emitStatement(writer, statement);
  }

  /** Placeholder emitted when an operation has no body yet. */
  protected emitEmptyBody(writer: CodeWriter): void {
    writer.line(this.todoComment());
  }

  protected todoComment(): string {
    return '// no body declared in the .hadl source';
  }

  emitStatement(writer: CodeWriter, statement: IRStatement): void {
    switch (statement.kind) {
      case 'let':
        this.emitLet(writer, this.identifier(statement.name), this.expression(statement.value));
        return;
      case 'set':
        this.emitSet(writer, this.member(statement.target), this.expression(statement.value));
        return;
      case 'perform':
        this.emitPerform(writer, this.expression(statement.value));
        return;
      case 'return':
        this.emitReturn(writer, statement.value ? this.expression(statement.value) : null);
        return;
      case 'fail':
        this.emitFail(writer, statement.error, statement.arguments);
        return;
      case 'publish':
        this.emitPublish(writer, statement.event, statement.arguments);
        return;
      case 'append':
        this.emitAppend(writer, this.member(statement.collection), this.expression(statement.value));
        return;
      case 'remove':
        this.emitRemove(writer, this.member(statement.collection), this.expression(statement.value));
        return;
      case 'when':
        this.emitWhen(
          writer,
          this.expression(statement.condition),
          () => this.emitBlock(writer, statement.then),
          statement.otherwise.length > 0 ? () => this.emitBlock(writer, statement.otherwise) : null,
        );
        return;
      case 'for-each':
        this.emitForEach(writer, this.identifier(statement.item), this.expression(statement.collection), () =>
          this.emitBlock(writer, statement.body),
        );
        return;
    }
  }

  expression(expression: IRExpression): string {
    switch (expression.kind) {
      case 'literal':
        return this.literal(expression.value, expression.type);
      case 'reference':
        return this.member(expression.path);
      case 'now':
        return this.now();
      case 'new-id':
        return this.newId();
      case 'unary':
        return this.unary(expression.operator, this.expression(expression.operand));
      case 'binary':
        return this.binary(expression.operator, this.expression(expression.left), this.expression(expression.right), null);
      case 'call':
        return this.call(expression.receiver, expression.operation, expression.arguments);
      case 'construct':
        return this.construct(expression.type, expression.arguments);
      case 'list':
        return this.listLiteral(
          expression.items.map((item) => this.expression(item)),
          expression.elementType ?? null,
        );
      case 'aggregate': {
        const element = 'each';
        const collection = this.expression(expression.collection);
        const source = expression.sourceType ?? null;
        const projection = expression.of ? this.projection(expression.of, element, source) : null;
        return this.aggregateFn(expression.fn, collection, projection, element);
      }
      case 'project': {
        const element = 'item';
        const collection = this.expression(expression.collection);
        return this.projectFn(
          expression.fn,
          collection,
          this.elementProjection(expression.of, element, expression.sourceType ?? null),
          element,
          expression.elementType ?? null,
        );
      }
    }
  }

  /**
   * Renders the `by ...` part of an aggregate. Everything inside it names a
   * field of the current element, so every reference gets the loop variable:
   * `quantity times unitPrice.amount` becomes `each.quantity * each.unitPrice.amount`.
   */
  protected projection(expression: IRExpression, elementVar: string, source: IRType | null = null): string {
    return this.expression(prefixReferences(expression, elementVar, undefined, this.fieldsOf(source)));
  }

  /**
   * The same rebinding for a map or a filter, kept separate because a fold may
   * coerce its leaves to a number and a projection must not: `each of items by
   * productId` yields text, and `only … where` yields a boolean.
   */
  protected elementProjection(expression: IRExpression, elementVar: string, source: IRType | null): string {
    return this.expression(prefixReferences(expression, elementVar, undefined, this.fieldsOf(source)));
  }

  /** Field names of the element being folded over, when the analyzer recorded its type. */
  private fieldsOf(type: IRType | null): ReadonlySet<string> | null {
    if (!type) return null;
    const named = unwrap(type);
    if (named.kind !== 'named') return null;
    const declaration = this.index.get(named.name);
    return declaration && 'fields' in declaration ? new Set(declaration.fields.map((field) => field.name)) : null;
  }

  /** Declaration a call phrase belongs to, when it can be resolved locally. */
  protected ownerOf(phrase: string): IRDeclaration | undefined {
    return this.index.resolvePhrase(phrase)[0]?.owner;
  }

  protected argumentsOf(args: readonly IRArgument[]): Array<{ name: string; value: string }> {
    return args.map((argument) => ({ name: camelCase(argument.name), value: this.expression(argument.value) }));
  }
}

/** Rewrites references so they read as members of `variable`, unless already rooted there. */
export function prefixReferences(
  expression: IRExpression,
  variable: string,
  roots: ReadonlySet<string> = new Set(),
  fields: ReadonlySet<string> | null = null,
): IRExpression {
  switch (expression.kind) {
    case 'reference': {
      const head = expression.path[0]!;
      if (head === variable || roots.has(head) || /^[A-Z]/.test(head)) return expression;
      // Once the element's fields are known, everything else came from the
      // enclosing scope — an operation parameter, a local — and rebinding it
      // onto the element would silently invent a field that does not exist.
      if (fields && !fields.has(head)) return expression;
      return { ...expression, path: [variable, ...expression.path] };
    }
    case 'binary':
      return {
        ...expression,
        left: prefixReferences(expression.left, variable, roots, fields),
        right: prefixReferences(expression.right, variable, roots, fields),
      };
    case 'unary':
      return { ...expression, operand: prefixReferences(expression.operand, variable, roots, fields) };
    case 'call':
    case 'construct':
      return {
        ...expression,
        arguments: expression.arguments.map((a) => ({ ...a, value: prefixReferences(a.value, variable, roots, fields) })),
      };
    case 'list':
      return { ...expression, items: expression.items.map((item) => prefixReferences(item, variable, roots, fields)) };
    case 'aggregate':
      return {
        ...expression,
        collection: prefixReferences(expression.collection, variable, roots, fields),
        of: expression.of ? prefixReferences(expression.of, variable, roots, fields) : null,
      };
    case 'project':
      return {
        ...expression,
        collection: prefixReferences(expression.collection, variable, roots, fields),
        of: prefixReferences(expression.of, variable, roots, fields),
      };
    default:
      return expression;
  }
}
