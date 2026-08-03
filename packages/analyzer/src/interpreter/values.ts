/**
 * The value model the interpreter works with.
 *
 * Deliberately close to what the generated code holds: records are plain objects
 * tagged with their declared type, enums are their member name, and a timestamp
 * is a `Date`. Nothing here needs to serialise, so nothing here is clever.
 */
import type { IRType } from '@haic/core';

export interface RecordValue {
  /** Declaration this record was built from. */
  readonly type: string;
  readonly fields: Map<string, Value>;
}

export type Value = null | boolean | number | string | Date | Value[] | RecordValue;

/** Accepts `undefined` so callers can test a map lookup without narrowing first. */
export function isRecord(value: Value | undefined): value is RecordValue {
  return typeof value === 'object' && value !== null && value !== undefined && !Array.isArray(value) && !(value instanceof Date);
}

export function record(type: string, fields: Iterable<readonly [string, Value]>): RecordValue {
  return { type, fields: new Map(fields) };
}

/** Structural equality, so two records built the same way compare equal. */
export function equals(left: Value, right: Value): boolean {
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => equals(item, right[index]!));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right) || left.type !== right.type) return false;
    if (left.fields.size !== right.fields.size) return false;
    for (const [key, value] of left.fields) {
      if (!right.fields.has(key) || !equals(value, right.fields.get(key)!)) return false;
    }
    return true;
  }
  return left === right;
}

/** Ordering for the comparison operators. `null` means the values are unordered. */
export function compare(left: Value, right: Value): number | null {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : left > right ? 1 : 0;
  return null;
}

/** How a value appears in a failed expectation. */
export function show(value: Value): string {
  if (value === null) return 'nothing';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(show).join(', ')}]`;
  if (isRecord(value)) {
    const fields = [...value.fields].map(([key, inner]) => `${key} = ${show(inner)}`).join(', ');
    return `${value.type} with ${fields}`;
  }
  return typeof value === 'string' ? `"${value}"` : String(value);
}

/** The value a field takes when a scenario leaves it out. */
export function emptyFor(type: IRType): Value {
  switch (type.kind) {
    case 'list':
    case 'set':
      return [];
    case 'optional':
      return null;
    case 'primitive':
      if (type.name === 'boolean') return false;
      if (type.name === 'integer' || type.name === 'decimal' || type.name === 'duration') return 0;
      if (type.name === 'text' || type.name === 'uuid' || type.name === 'date') return '';
      return null;
    default:
      return null;
  }
}
