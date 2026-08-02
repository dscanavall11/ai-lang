/**
 * Analysis context and pass interface.
 *
 * Each semantic rule lives in its own pass. Adding a rule means adding a pass to
 * the pipeline; no existing pass changes. Passes share the read-only module
 * index and report through the same diagnostic bag.
 */
import type { DiagnosticBag, DiagnosticStage, IRModule, IRProject, IRType, ModuleIndex, SourceSpan } from '@ai-lang/core';

export interface AnalysisContext {
  readonly project: IRProject;
  readonly module: IRModule;
  readonly index: ModuleIndex;
  readonly diagnostics: DiagnosticBag;
  /** Indexes of the other modules in the project, keyed by module name. */
  readonly siblings: ReadonlyMap<string, ModuleIndex>;
  /**
   * Checked errors each operation body actually raises, keyed by
   * `Owner.phrase`. Filled by the type pass, read by the error-flow pass.
   */
  readonly raisedErrors: Map<string, Set<string>>;
}

export interface SemanticPass {
  readonly id: string;
  readonly stage: DiagnosticStage;
  run(context: AnalysisContext): void;
}

/** Lexical scope for operation bodies: parameters, then `let` bindings. */
export class Scope {
  private readonly bindings = new Map<string, IRType>();

  constructor(private readonly parent: Scope | null = null) {}

  child(): Scope {
    return new Scope(this);
  }

  define(name: string, type: IRType): void {
    this.bindings.set(name, type);
  }

  lookup(name: string): IRType | undefined {
    return this.bindings.get(name) ?? this.parent?.lookup(name);
  }

  has(name: string): boolean {
    return this.lookup(name) !== undefined;
  }

  /** Names visible in this scope and its ancestors, for "did you mean" hints. */
  names(): string[] {
    const out = new Set<string>();
    let scope: Scope | null = this;
    while (scope) {
      for (const key of scope.bindings.keys()) out.add(key);
      scope = scope.parent;
    }
    return [...out];
  }
}

/** Levenshtein-based suggestion used across passes to make errors actionable. */
export function suggest(name: string, candidates: readonly string[]): string | undefined {
  let best: { value: string; distance: number } | null = null;
  for (const candidate of candidates) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (distance <= Math.max(2, Math.floor(name.length / 3)) && (!best || distance < best.distance)) {
      best = { value: candidate, distance };
    }
  }
  return best?.value;
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const columns = b.length + 1;
  let previous = Array.from({ length: columns }, (_, i) => i);
  for (let i = 1; i < rows; i += 1) {
    const current = [i, ...Array<number>(columns - 1).fill(0)];
    for (let j = 1; j < columns; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[columns - 1]!;
}

export function withSuggestion(message: string, name: string, candidates: readonly string[]): string | undefined {
  const match = suggest(name, candidates);
  return match ? `${message} Did you mean "${match}"?` : undefined;
}

export const NOWHERE: SourceSpan = {
  file: '<generated>',
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 1, offset: 0 },
};
