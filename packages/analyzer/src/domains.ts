/**
 * What a field's constraints admit, computed rather than assumed.
 *
 * The checks built on this file follow one rule, fixed in ADR-014: **every
 * finding carries a concrete witness** — a value, or the pair of constraints no
 * value can satisfy. An analysis that cannot construct its witness stays
 * silent, because a warning the reader cannot verify with a value in hand is
 * worse than none.
 *
 * That rule is why this is interval arithmetic and not an inference engine.
 * Intervals are decidable, instant, and every answer they give can be written
 * down. The general engine is the trap the backlog names: undecidable, slow,
 * and wrong in ways a user cannot argue with.
 *
 * `satisfiesConstraint` lives here and is the same function the interpreter
 * runs when a scenario constructs a value, so the verdict at check time and
 * the verdict at run time cannot drift apart.
 */
import type { IRConstraint, IRField } from '@haic/core';

/** One closed numeric interval. `min > max` is the empty domain. */
export interface NumericRange {
  min: number;
  max: number;
}

const EVERYTHING: NumericRange = { min: -Infinity, max: Infinity };

/** The values `min`/`max` constraints leave possible. */
export function numericRange(constraints: readonly IRConstraint[]): NumericRange {
  let range = EVERYTHING;
  for (const constraint of constraints) {
    if (constraint.kind === 'min') range = { ...range, min: Math.max(range.min, constraint.value) };
    if (constraint.kind === 'max') range = { ...range, max: Math.min(range.max, constraint.value) };
  }
  return range;
}

/** The lengths `length` constraints leave possible. */
export function lengthRange(constraints: readonly IRConstraint[]): NumericRange {
  let range: NumericRange = { min: 0, max: Infinity };
  for (const constraint of constraints) {
    if (constraint.kind === 'min-length') range = { ...range, min: Math.max(range.min, constraint.value) };
    if (constraint.kind === 'max-length') range = { ...range, max: Math.min(range.max, constraint.value) };
    if (constraint.kind === 'length') {
      range = { min: Math.max(range.min, constraint.value), max: Math.min(range.max, constraint.value) };
    }
  }
  return range;
}

/**
 * The sentence that proves a field impossible, or null when it is not.
 *
 * The message is the witness: it names the two bounds no value can sit
 * between. A field like this is not merely suspicious — every construction of
 * the declaring type will fail, in the interpreter and in every backend.
 */
export function contradiction(field: IRField): string | null {
  const range = numericRange(field.constraints);
  if (range.min > range.max) {
    return `no value is at least ${range.min} and at most ${range.max}`;
  }

  const lengths = lengthRange(field.constraints);
  if (lengths.min > lengths.max) {
    return `no value has a length of at least ${lengths.min} and at most ${lengths.max}`;
  }

  const pattern = field.constraints.find((c) => c.kind === 'pattern');
  if (pattern && pattern.kind === 'pattern') {
    try {
      new RegExp(pattern.value);
    } catch {
      return `"${pattern.value}" does not compile as a regular expression, so nothing can ever match it`;
    }
  }

  return null;
}

/**
 * Does this value satisfy this constraint? One answer for the whole compiler:
 * the interpreter calls it when a scenario constructs a value, and the domain
 * checks call it at check time, so the two cannot disagree.
 *
 * Type mismatches answer `true` on purpose — whether a value has the right
 * type is `HADL2155`'s question, not this one's.
 */
export function satisfiesConstraint(value: unknown, constraint: IRConstraint): boolean {
  switch (constraint.kind) {
    case 'min':
      return typeof value !== 'number' || value >= constraint.value;
    case 'max':
      return typeof value !== 'number' || value <= constraint.value;
    case 'min-length':
      return lengthOf(value) >= constraint.value;
    case 'max-length':
      return lengthOf(value) <= constraint.value;
    case 'length':
      return lengthOf(value) === constraint.value;
    case 'pattern':
      return typeof value !== 'string' || safeRegExp(constraint.value)?.test(value) !== false;
    default:
      return true;
  }
}

/** The constraint a literal breaks, with the words to say so, or null. */
export function violatedConstraint(
  field: IRField,
  value: string | number | boolean | null,
): { constraint: IRConstraint; witness: string } | null {
  if (value === null) return null;
  for (const constraint of field.constraints) {
    if (constraint.kind === 'default') continue;
    if (satisfiesConstraint(value, constraint)) continue;
    return { constraint, witness: `${show(value)} breaks "${describeConstraint(constraint)}"` };
  }
  return null;
}

/** How a comparison against `literal` can go, given what the range admits. */
export type Verdict = 'always' | 'never' | null;

/**
 * `hits < 0` when hits is declared `at least 0`: never. The comparison is
 * decided by the declaration, not by any run, and the witness is the bound.
 */
export function comparisonVerdict(
  range: NumericRange,
  operator: 'greater-than' | 'greater-or-equal' | 'less-than' | 'less-or-equal',
  literal: number,
): Verdict {
  if (range.min === -Infinity && range.max === Infinity) return null;
  switch (operator) {
    case 'greater-than':
      if (range.min > literal) return 'always';
      if (range.max <= literal) return 'never';
      return null;
    case 'greater-or-equal':
      if (range.min >= literal) return 'always';
      if (range.max < literal) return 'never';
      return null;
    case 'less-than':
      if (range.max < literal) return 'always';
      if (range.min >= literal) return 'never';
      return null;
    case 'less-or-equal':
      if (range.max <= literal) return 'always';
      if (range.min > literal) return 'never';
      return null;
  }
}

/** `at least 5` in the words the author wrote, for witnesses. */
export function describeConstraint(constraint: IRConstraint): string {
  switch (constraint.kind) {
    case 'min':
      return `at least ${constraint.value}`;
    case 'max':
      return `at most ${constraint.value}`;
    case 'min-length':
      return `min length ${constraint.value}`;
    case 'max-length':
      return `max length ${constraint.value}`;
    case 'length':
      return `length ${constraint.value}`;
    case 'pattern':
      return `pattern "${constraint.value}"`;
    default:
      return constraint.kind;
  }
}

/** The bound of a range in the words a witness wants. */
export function describeRange(range: NumericRange): string {
  if (range.min !== -Infinity && range.max !== Infinity) return `between ${range.min} and ${range.max}`;
  if (range.min !== -Infinity) return `at least ${range.min}`;
  return `at most ${range.max}`;
}

function lengthOf(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.length;
  return 0;
}

function safeRegExp(source: string): RegExp | null {
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

function show(value: string | number | boolean): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}
