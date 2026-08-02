/**
 * A phase reads the state, writes its own slice of it, and reports what it
 * could not decide. Phases never call each other: the pipeline order is the
 * only coupling, so a new phase is added to the array and nothing else changes.
 */
import type { DiagnosticBag } from '@ai-lang/core';
import type { ArchitectState } from './types.js';

export interface Phase {
  /** Stable id, used in diagnostics and in the generated plan. */
  readonly id: string;
  /** Human title, used as the heading of the artifact this phase feeds. */
  readonly title: string;
  run(state: ArchitectState, diagnostics: DiagnosticBag): void;
}
