/**
 * Open questions.
 *
 * The architect never guesses silently. Whenever the requirements leave a
 * decision open, the phase records the ambiguity, the question a human has to
 * answer, and the assumption taken so the pipeline can continue.
 */
import type { DiagnosticBag, SourceSpan } from '@haic/core';
import type { ArchitectState, OpenQuestion } from './types.js';

export const QUESTION_CODES = {
  storyWithoutBenefit: 'HADL3010',
  capabilityWithoutCriteria: 'HADL3011',
  actorWithoutCapability: 'HADL3012',
  noCapabilities: 'HADL3013',
  unclassifiedSubdomain: 'HADL3020',
  thinContext: 'HADL3021',
  noStackSignal: 'HADL3030',
  duplicateRoute: 'HADL3031',
  crossAggregateRule: 'HADL3040',
  unmodelledRule: 'HADL3041',
  entityReference: 'HADL3042',
  assumedBroker: 'HADL3050',
} as const;

export interface QuestionDraft {
  code: string;
  phase: string;
  line: number;
  ambiguity: string;
  question: string;
  assumption: string;
  evidence: string;
}

/** Records an open question and mirrors it as an `info` diagnostic. */
export function ask(state: ArchitectState, diagnostics: DiagnosticBag, draft: QuestionDraft): OpenQuestion {
  const question: OpenQuestion = {
    id: `Q-${String(state.openQuestions.length + 1).padStart(3, '0')}`,
    ...draft,
  };
  state.openQuestions.push(question);
  diagnostics.info('architect', draft.code, `${draft.ambiguity} ${draft.question}`, spanOf(state.input.path, draft.line), {
    hint: `assumed for now: ${draft.assumption}`,
  });
  return question;
}

export function spanOf(file: string, line: number): SourceSpan {
  const position = { line: Math.max(1, line), column: 1, offset: 0 };
  return { file, start: position, end: position };
}
