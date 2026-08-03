/**
 * Running scenarios.
 *
 * Three outcomes, and the third matters: a scenario the interpreter cannot
 * execute is **inconclusive**, never a pass. Reporting "0 failures" for work
 * that never ran is the one thing a test runner must not do.
 */
import { indexModule, type IRModule, type IRScenarioDecl, type SourceSpan } from '@haic/core';
import { DomainFailure, Interpreter, Unsupported } from './runtime.js';
import { isRecord, show, type Value } from './values.js';

export type Outcome = 'passed' | 'failed' | 'inconclusive';

export interface ScenarioResult {
  module: string;
  /** Identifier in the IR. */
  name: string;
  /** The heading as written, which is what a reader recognises. */
  title: string;
  outcome: Outcome;
  span: SourceSpan | undefined;
  /** One line per expectation that did not hold, or the reason it could not run. */
  problems: string[];
}

export interface TestReport {
  results: ScenarioResult[];
  passed: number;
  failed: number;
  inconclusive: number;
  get ok(): boolean;
}

export function runScenarios(modules: readonly IRModule[]): TestReport {
  const results: ScenarioResult[] = [];
  for (const module of modules) {
    const index = indexModule(module);
    for (const scenario of index.scenarios) {
      results.push(runScenario(module, scenario));
    }
  }

  const passed = results.filter((r) => r.outcome === 'passed').length;
  const failed = results.filter((r) => r.outcome === 'failed').length;
  const inconclusive = results.filter((r) => r.outcome === 'inconclusive').length;
  return {
    results,
    passed,
    failed,
    inconclusive,
    // An inconclusive scenario is not a pass, so it cannot leave the run green.
    get ok() {
      return failed === 0 && inconclusive === 0;
    },
  };
}

function runScenario(module: IRModule, scenario: IRScenarioDecl): ScenarioResult {
  const interpreter = new Interpreter(indexModule(module));
  const scope = new Map<string, Value>();
  const base: Omit<ScenarioResult, 'outcome' | 'problems'> = {
    module: module.name,
    name: scenario.name,
    title: scenario.description?.split('\n')[0] ?? scenario.name,
    span: scenario.span,
  };

  // -- given ---------------------------------------------------------------
  for (const step of scenario.given) {
    try {
      const value = interpreter.evaluate(step.value, scope);
      scope.set(step.binding, value);
      if (isRecord(value)) interpreter.seed(value);
    } catch (thrown) {
      return { ...base, outcome: inconclusiveOr(thrown), problems: [`given ${step.binding}: ${reason(thrown)}`] };
    }
  }

  // -- when ----------------------------------------------------------------
  let raised: DomainFailure | null = null;
  try {
    scope.set(scenario.when.binding, interpreter.evaluate(scenario.when.call, scope));
  } catch (thrown) {
    if (thrown instanceof DomainFailure) raised = thrown;
    else return { ...base, outcome: 'inconclusive', problems: [reason(thrown)] };
  }

  // -- then ----------------------------------------------------------------
  const problems: string[] = [];
  for (const expectation of scenario.expectations) {
    switch (expectation.kind) {
      case 'fails': {
        if (raised === null) problems.push(`expected it to fail with ${expectation.error}, but it succeeded`);
        else if (raised.error !== expectation.error) {
          problems.push(`expected it to fail with ${expectation.error}, but it failed with ${describe(raised)}`);
        }
        break;
      }

      case 'publishes': {
        if (interpreter.published.some((event) => event.name === expectation.event)) break;
        const seen = interpreter.published.map((event) => event.name);
        problems.push(
          seen.length === 0
            ? `expected it to publish ${expectation.event}, but nothing was published`
            : `expected it to publish ${expectation.event}, but it published ${seen.join(', ')}`,
        );
        break;
      }

      case 'holds': {
        // A condition cannot be judged if the operation never returned.
        if (raised !== null && !scenario.expectations.some((e) => e.kind === 'fails')) break;
        try {
          if (!interpreter.evaluate(expectation.condition, scope)) {
            problems.push(`this did not hold: ${explain(interpreter, expectation.condition, scope)}`);
          }
        } catch (thrown) {
          return { ...base, outcome: 'inconclusive', problems: [reason(thrown)] };
        }
        break;
      }
    }
  }

  // An unexpected failure is a failure, even when every stated expectation held.
  if (raised !== null && !scenario.expectations.some((e) => e.kind === 'fails')) {
    problems.push(`it failed unexpectedly with ${describe(raised)}`);
  }

  return { ...base, outcome: problems.length === 0 ? 'passed' : 'failed', problems };
}

/** Renders a failed comparison with both sides evaluated, which is the useful part. */
function explain(interpreter: Interpreter, condition: Parameters<Interpreter['evaluate']>[0], scope: Map<string, Value>): string {
  if (condition.kind === 'binary') {
    try {
      const left = interpreter.evaluate(condition.left, scope);
      const right = interpreter.evaluate(condition.right, scope);
      return `${show(left)} ${condition.operator.replace(/-/g, ' ')} ${show(right)}`;
    } catch {
      return condition.operator.replace(/-/g, ' ');
    }
  }
  if (condition.kind === 'unary') {
    try {
      return `${show(interpreter.evaluate(condition.operand, scope))} ${condition.operator.replace(/-/g, ' ')}`;
    } catch {
      return condition.operator.replace(/-/g, ' ');
    }
  }
  return 'the condition was false';
}

function describe(failure: DomainFailure): string {
  const details = [...failure.details].map(([key, value]) => `${key} = ${show(value)}`).join(', ');
  return details.length > 0 ? `${failure.error} (${details})` : failure.error;
}

function inconclusiveOr(thrown: unknown): Outcome {
  return thrown instanceof DomainFailure ? 'failed' : 'inconclusive';
}

function reason(thrown: unknown): string {
  if (thrown instanceof Unsupported) return `${thrown.message} — this scenario did not run`;
  if (thrown instanceof DomainFailure) return describe(thrown);
  return thrown instanceof Error ? thrown.message : String(thrown);
}
