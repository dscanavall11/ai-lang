/**
 * The AI Architect.
 *
 * Reads a plain-language requirements document and produces a reviewable spec
 * plus a first draft of the sources. Deterministic by construction: no LLM
 * calls, no network, no randomness. Anything the requirements leave open becomes
 * an explicit question rather than a guess.
 */
import { DiagnosticBag } from '@ai-lang/core';
import { RequirementsDocument } from './document.js';
import type { Phase } from './phase.js';
import { architecturePhase } from './phases/architecture.js';
import { designPhase } from './phases/design.js';
import { emitPhase } from './phases/emit.js';
import { explorePhase } from './phases/explore.js';
import { modelPhase } from './phases/model.js';
import { planPhase } from './phases/plan.js';
import type { ArchitectInput, ArchitectResult, ArchitectState } from './types.js';

/** Order is the only coupling between phases; a new one is appended here. */
export const defaultPhases: readonly Phase[] = [
  explorePhase,
  architecturePhase,
  designPhase,
  modelPhase,
  planPhase,
  emitPhase,
];

export interface ArchitectOptions {
  phases?: readonly Phase[];
}

export function runArchitect(input: ArchitectInput, options: ArchitectOptions = {}): ArchitectResult {
  const diagnostics = new DiagnosticBag();
  const state = initialState(input);

  for (const phase of options.phases ?? defaultPhases) {
    phase.run(state, diagnostics);
  }

  return {
    files: state.emit.files,
    diagnostics: diagnostics.items,
    openQuestions: state.openQuestions,
    state,
  };
}

function initialState(input: ArchitectInput): ArchitectState {
  return {
    input,
    document: new RequirementsDocument(input.requirements),
    explore: { actors: [], glossary: [], stories: [], capabilities: [], criteria: [], triggers: [], vocabulary: [] },
    architecture: { subdomains: [], contexts: [], contextMap: [], diagram: '' },
    design: { stacks: [], endpoints: [], events: [], workflows: [] },
    model: { aggregates: [], entities: [], valueObjects: [], commands: [], events: [], errors: [], diagram: '' },
    plan: { tasks: [] },
    emit: { files: [] },
    openQuestions: [],
  };
}

export { RequirementsDocument } from './document.js';
export type { Phase } from './phase.js';
export { explorePhase } from './phases/explore.js';
export { architecturePhase } from './phases/architecture.js';
export { designPhase } from './phases/design.js';
export { modelPhase } from './phases/model.js';
export { planPhase } from './phases/plan.js';
export { emitPhase } from './phases/emit.js';
export type * from './types.js';
