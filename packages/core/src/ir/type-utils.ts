/** Structural helpers over `IRType`. Shared by the analyzer and every generator. */
import type { IRType, PrimitiveType } from './schema.js';

export function primitive(name: PrimitiveType): IRType {
  return { kind: 'primitive', name };
}

export function named(name: string): IRType {
  return { kind: 'named', name };
}

export function list(of: IRType): IRType {
  return { kind: 'list', of };
}

export function optional(of: IRType): IRType {
  return of.kind === 'optional' ? of : { kind: 'optional', of };
}

export function result(ok: IRType, errors: string[]): IRType {
  return { kind: 'result', ok, errors };
}

export const NOTHING: IRType = { kind: 'primitive', name: 'nothing' };

/** Strips `optional` and `result` wrappers to reach the carried type. */
export function unwrap(type: IRType): IRType {
  if (type.kind === 'optional') return unwrap(type.of);
  if (type.kind === 'result') return unwrap(type.ok);
  return type;
}

export function isNothing(type: IRType): boolean {
  return type.kind === 'primitive' && type.name === 'nothing';
}

export function isCollection(type: IRType): boolean {
  const inner = type.kind === 'optional' ? type.of : type;
  return inner.kind === 'list' || inner.kind === 'set' || inner.kind === 'map';
}

export function elementType(type: IRType): IRType | null {
  const inner = type.kind === 'optional' ? type.of : type;
  if (inner.kind === 'list' || inner.kind === 'set') return inner.of;
  if (inner.kind === 'map') return inner.value;
  return null;
}

export function isNumeric(type: IRType): boolean {
  const inner = unwrap(type);
  return inner.kind === 'primitive' && (inner.name === 'integer' || inner.name === 'decimal');
}

/**
 * Types with a natural order, so `is greater than` and friends make sense.
 * Text is deliberately excluded: lexicographic ordering is almost never what
 * someone writing a business rule means.
 */
export function isOrderable(type: IRType): boolean {
  const inner = unwrap(type);
  if (inner.kind !== 'primitive') return false;
  return (
    inner.name === 'integer' ||
    inner.name === 'decimal' ||
    inner.name === 'timestamp' ||
    inner.name === 'date' ||
    inner.name === 'duration'
  );
}

export function isTextual(type: IRType): boolean {
  const inner = unwrap(type);
  return inner.kind === 'primitive' && (inner.name === 'text' || inner.name === 'uuid');
}

/** Errors declared on a `result` type, including nested results. */
export function declaredErrors(type: IRType): string[] {
  if (type.kind === 'result') return [...type.errors, ...declaredErrors(type.ok)];
  if (type.kind === 'optional') return declaredErrors(type.of);
  return [];
}

export function typeEquals(a: IRType, b: IRType): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'primitive':
      return a.name === (b as typeof a).name;
    case 'named':
      return a.name === (b as typeof a).name;
    case 'list':
    case 'set':
    case 'optional':
      return typeEquals(a.of, (b as typeof a).of);
    case 'map':
      return typeEquals(a.key, (b as typeof a).key) && typeEquals(a.value, (b as typeof a).value);
    case 'result': {
      const other = b as typeof a;
      return (
        typeEquals(a.ok, other.ok) &&
        a.errors.length === other.errors.length &&
        a.errors.every((e) => other.errors.includes(e))
      );
    }
  }
}

/** Renders a type back into AI-Lang surface syntax. Used by diagnostics and docs. */
export function typeToString(type: IRType): string {
  switch (type.kind) {
    case 'primitive':
      return type.name;
    case 'named':
      return type.name;
    case 'list':
      return `list of ${typeToString(type.of)}`;
    case 'set':
      return `set of ${typeToString(type.of)}`;
    case 'map':
      return `map from ${typeToString(type.key)} to ${typeToString(type.value)}`;
    case 'optional':
      return `${typeToString(type.of)} or nothing`;
    case 'result':
      return type.errors.length > 0 ? `${typeToString(type.ok)} or ${type.errors.join(', ')}` : typeToString(type.ok);
  }
}

/** Every named type mentioned anywhere inside `type`. */
export function referencedNames(type: IRType, into: Set<string> = new Set()): Set<string> {
  switch (type.kind) {
    case 'named':
      into.add(type.name);
      break;
    case 'list':
    case 'set':
    case 'optional':
      referencedNames(type.of, into);
      break;
    case 'map':
      referencedNames(type.key, into);
      referencedNames(type.value, into);
      break;
    case 'result':
      referencedNames(type.ok, into);
      for (const e of type.errors) into.add(e);
      break;
    case 'primitive':
      break;
  }
  return into;
}
