/**
 * A debugger for a design.
 *
 * A HADL scenario runs inside an interpreter this project already owns, which
 * means the question "why did it do that?" has a better answer than reading the
 * source again. The interpreter can say what it did: which branch it took,
 * what each name was bound to, which port it called and what came back.
 *
 * There is no breakpoint here and no stepping. The runs are milliseconds long
 * and the interesting part is always the sequence, so a trace you read after
 * the fact beats a prompt you drive during it. `haic test --trace` prints one;
 * a failing scenario prints the last few steps whether you asked or not,
 * because the step before a failure is the one worth seeing.
 */
import type { SourceSpan } from '@haic/core';
import { show, type Value } from './values.js';

export type TraceKind = 'call' | 'return' | 'let' | 'set' | 'branch' | 'loop' | 'publish' | 'fail' | 'port';

export interface TraceStep {
  kind: TraceKind;
  /** Nesting: one level per call the interpreter is inside. */
  depth: number;
  /** What happened, already rendered — `let total be 40` reads as `total = 40`. */
  detail: string;
  span?: SourceSpan;
}

/** Collects steps while a scenario runs. Off by default; nothing pays for it. */
export class Trace {
  readonly steps: TraceStep[] = [];
  private depth = 0;

  enter(): void {
    this.depth += 1;
  }

  leave(): void {
    this.depth = Math.max(0, this.depth - 1);
  }

  record(kind: TraceKind, detail: string, span?: SourceSpan): void {
    this.steps.push(span ? { kind, depth: this.depth, detail, span } : { kind, depth: this.depth, detail });
  }

  /** `find order by id(id = "…")`, in one line. */
  call(phrase: string, args: ReadonlyMap<string, Value>, span?: SourceSpan): void {
    const rendered = [...args].map(([name, value]) => `${name} = ${brief(value)}`).join(', ');
    this.record('call', `${phrase}(${rendered})`, span);
  }

  /** The last `limit` steps, which is what a failure needs. */
  tail(limit: number): TraceStep[] {
    return this.steps.slice(-limit);
  }
}

/**
 * A value, short enough to read.
 *
 * An aggregate printed in full is three lines of a trace nobody scans, and the
 * thing being debugged is the sequence rather than the contents. The full value
 * is one `haic ir` away when it matters.
 */
export function brief(value: Value, limit = 72): string {
  const rendered = show(value);
  return rendered.length <= limit ? rendered : `${rendered.slice(0, limit - 1)}…`;
}

/** Renders a trace the way a terminal wants it: one indented line per step. */
export function renderTrace(steps: readonly TraceStep[], indent = '    '): string[] {
  return steps.map((step) => `${indent}${'  '.repeat(step.depth)}${MARKS[step.kind]} ${step.detail}`);
}

const MARKS: Record<TraceKind, string> = {
  call: '→',
  return: '←',
  let: '·',
  set: '·',
  branch: '?',
  loop: '↻',
  publish: '!',
  fail: '✗',
  port: '⇄',
};
