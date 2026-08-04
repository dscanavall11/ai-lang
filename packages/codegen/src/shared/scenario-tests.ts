/**
 * One scenario, written as a test, in whatever language the backend speaks.
 *
 * The walk is here rather than in each backend because the last time a small
 * piece of emission logic was copied per target, three of the five copies were
 * missing and a fenced block in an adapter vanished in silence. A backend
 * supplies five short hooks — declare a local, bind the result, call, assert,
 * assert-throws — and nothing else about the shape of a test is its business.
 */
import { CodeWriter, camelCase, expectedFailure, type ScenarioPlan } from '@haic/core';
import type { LanguageEmitter } from './emitter.js';

export interface TestHooks {
  /** How the target spells a local binding: `const x = …;`, `x := …`, `x = …`. */
  local(name: string, value: string): string;
  /** A statement that calls without keeping the result. */
  discard(value: string): string;
  /** `assert.ok(condition, message)` in the target's idiom. */
  assertTrue(condition: string, message: string): string[];
  /** Runs `call` and asserts it raises `error`. May span several lines. */
  assertRaises(call: string, error: string, message: string): string[];
  /** Local naming, so Python gets `resting_order` and TypeScript `restingOrder`. */
  name?(binding: string): string;
  /** Lines that stand up whatever the call needs before it runs. */
  setUp?(plan: ScenarioPlan): string[];
  /**
   * How the test calls the operation, when the emitter's own lowering would be
   * wrong here.
   *
   * A service body calls itself through `this`, and resolves its own phrase to
   * the inbound port it implements — correct inside the class, and meaningless
   * in a test that holds the service as a local. The backend spells that call
   * out rather than rewriting the text of one meant for somewhere else.
   */
  call?(plan: ScenarioPlan, emitter: LanguageEmitter): string;
}

/** Emits the body of one test: given, when, then. */
export function emitScenarioBody(writer: CodeWriter, emitter: LanguageEmitter, plan: ScenarioPlan, hooks: TestHooks): void {
  const named = hooks.name ?? camelCase;
  const rendered = (expression: Parameters<LanguageEmitter['expression']>[0]): string => emitter.expression(expression);

  for (const step of plan.given) {
    writer.line(hooks.local(named(step.binding), rendered(step.value)));
  }
  for (const line of hooks.setUp?.(plan) ?? []) writer.line(line);

  const call = hooks.call ? hooks.call(plan, emitter) : rendered(plan.call);
  const failure = expectedFailure(plan);
  if (failure) {
    // A scenario that expects a failure asserts nothing after it: the call did
    // not return, so there is no result for a `then` to read.
    for (const line of hooks.assertRaises(call, failure, plan.title)) writer.line(line);
    return;
  }

  if (plan.binding) writer.line(hooks.local(named(plan.binding), call));
  else writer.line(hooks.discard(call));

  for (const expectation of plan.expectations) {
    if (expectation.kind !== 'holds') continue;
    for (const line of hooks.assertTrue(rendered(expectation.condition), plan.title)) writer.line(line);
  }
}

/**
 * The scenarios that stayed with the interpreter, named in the generated file.
 *
 * A reader counting tests should never have to wonder where a scenario went.
 */
export function skippedComments(skipped: ReadonlyArray<{ title: string; reason: string }>, prefix = '// '): string[] {
  return skipped.map((skip) => `${prefix}${skip.title} — run by "haic test": ${skip.reason}.`);
}

export { CodeWriter };
