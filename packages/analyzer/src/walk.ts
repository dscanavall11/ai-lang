/** Structural traversal helpers. Passes describe *what* to check; this file knows *where* to look. */
import type { IRDeclaration, IRExpression, IRModule, IRStatement, IRType, SourceSpan } from '@ai-lang/core';

export interface TypeUse {
  type: IRType;
  span: SourceSpan | undefined;
  /** Human-readable location, e.g. `field Order.total`. */
  where: string;
}

/** Every type mentioned in the module, with the place it was written. */
export function* typesReferencedBy(module: IRModule): Generator<TypeUse> {
  for (const declaration of module.declarations) {
    yield* typesOfDeclaration(declaration);
  }
}

export function* typesOfDeclaration(declaration: IRDeclaration): Generator<TypeUse> {
  const label = `${declaration.kind} ${declaration.name}`;

  if ('fields' in declaration) {
    for (const field of declaration.fields) {
      yield { type: field.type, span: field.span, where: `field ${declaration.name}.${field.name}` };
    }
  }
  if ('operations' in declaration) {
    for (const operation of declaration.operations) {
      for (const parameter of operation.parameters) {
        yield { type: parameter.type, span: operation.span, where: `parameter "${parameter.name}" of ${label}.${operation.phrase}` };
      }
      yield { type: operation.returns, span: operation.span, where: `return type of ${label}.${operation.phrase}` };
    }
  }
  if (declaration.kind === 'endpoint') {
    if (declaration.request) yield { type: declaration.request, span: declaration.span, where: `request of ${label}` };
    for (const response of declaration.responses) {
      if (response.body) yield { type: response.body, span: declaration.span, where: `response ${response.status} of ${label}` };
    }
  }
}

/** Depth-first walk over statements, including nested blocks. */
export function* walkStatements(statements: readonly IRStatement[]): Generator<IRStatement> {
  for (const statement of statements) {
    yield statement;
    if (statement.kind === 'when') {
      yield* walkStatements(statement.then);
      yield* walkStatements(statement.otherwise);
    } else if (statement.kind === 'for-each') {
      yield* walkStatements(statement.body);
    }
  }
}

/** Depth-first walk over the expressions inside a statement list. */
export function* walkExpressions(statements: readonly IRStatement[]): Generator<IRExpression> {
  for (const statement of walkStatements(statements)) {
    switch (statement.kind) {
      case 'let':
      case 'set':
      case 'append':
      case 'remove':
        yield* walkExpression(statement.value);
        break;
      case 'perform':
        yield* walkExpression(statement.value);
        break;
      case 'when':
        yield* walkExpression(statement.condition);
        break;
      case 'for-each':
        yield* walkExpression(statement.collection);
        break;
      case 'fail':
      case 'publish':
        for (const argument of statement.arguments) yield* walkExpression(argument.value);
        break;
      case 'return':
        if (statement.value) yield* walkExpression(statement.value);
        break;
    }
  }
}

export function* walkExpression(expression: IRExpression): Generator<IRExpression> {
  yield expression;
  switch (expression.kind) {
    case 'binary':
      yield* walkExpression(expression.left);
      yield* walkExpression(expression.right);
      break;
    case 'unary':
      yield* walkExpression(expression.operand);
      break;
    case 'call':
    case 'construct':
      for (const argument of expression.arguments) yield* walkExpression(argument.value);
      break;
    case 'aggregate':
      yield* walkExpression(expression.collection);
      if (expression.of) yield* walkExpression(expression.of);
      break;
    case 'project':
      yield* walkExpression(expression.collection);
      yield* walkExpression(expression.of);
      break;
    default:
      break;
  }
}

/** All operation bodies in the module, tagged with their owner. */
export function* bodies(module: IRModule): Generator<{ owner: IRDeclaration; label: string; body: IRStatement[]; span: SourceSpan | undefined }> {
  for (const declaration of module.declarations) {
    if (declaration.kind === 'service' || declaration.kind === 'aggregate' || declaration.kind === 'adapter') {
      for (const operation of declaration.operations) {
        yield { owner: declaration, label: `${declaration.name}.${operation.phrase}`, body: operation.body, span: operation.span };
      }
    }
    if (declaration.kind === 'handler') {
      yield { owner: declaration, label: declaration.name, body: declaration.body, span: declaration.span };
    }
  }
}
