/**
 * Which scenarios a backend can compile into a test.
 *
 * `haic test` runs scenarios against the IR, which is fast, needs no toolchain,
 * and cannot execute a fenced block — so the part of a system most worth
 * exercising is exactly the part the interpreter has to skip. Compiling a
 * scenario into the target language closes that gap: the same `given`, the same
 * call, the same expectations, run against the code that actually ships.
 *
 * The selection here is deliberately narrow. A scenario over an aggregate
 * operation needs nothing but the aggregate: construct it, call the method,
 * check the result. A scenario over a service needs its ports wired, its
 * adapters chosen and its publisher observed, and guessing at that would produce
 * a test that fails for reasons the design never described. Those stay with the
 * interpreter, which already knows how to fake them, and are reported here as
 * skipped rather than quietly dropped.
 */
import { camelCase } from '../naming.js';
import type { ModuleIndex } from './index-module.js';
import type { IRAggregateDecl, IRArgument, IRExpression, IROperation, IRScenarioDecl, IRType } from './schema.js';

export interface ScenarioPlan {
  scenario: IRScenarioDecl;
  /** Title as written in the heading, which is what a reader recognises. */
  title: string;
  aggregate: IRAggregateDecl;
  operation: IROperation;
  /** `given` binding holding the receiver, e.g. `book`. */
  receiver: string;
  /** Local the result is bound to, or null when the operation returns nothing. */
  binding: string | null;
  expectations: IRScenarioDecl['expectations'];
  /** `given` steps, with every literal carrying the type its field declares. */
  given: IRScenarioDecl['given'];
  /** The `when` call, retyped the same way. */
  call: IRExpression;
}

export interface SkippedScenario {
  title: string;
  reason: string;
}

export interface ScenarioSelection {
  compiled: ScenarioPlan[];
  skipped: SkippedScenario[];
}

export function scenarioPlans(index: ModuleIndex): ScenarioSelection {
  const compiled: ScenarioPlan[] = [];
  const skipped: SkippedScenario[] = [];

  for (const scenario of index.scenarios) {
    const title = titleOf(scenario);
    const call = scenario.when.call;
    if (call.kind !== 'call') {
      skipped.push({ title, reason: 'its "when" is not an operation call' });
      continue;
    }

    const owner = index.resolvePhrase(call.operation).find((entry) => entry.owner.kind === 'aggregate');
    if (!owner) {
      skipped.push({ title, reason: `"${call.operation}" is not an aggregate operation, so a test would have to wire its ports` });
      continue;
    }

    const aggregate = owner.owner as IRAggregateDecl;
    const receiver = receiverBinding(call.arguments, aggregate, scenario);
    if (!receiver) {
      skipped.push({ title, reason: `it does not pass a ${aggregate.name} bound by "given"` });
      continue;
    }

    const publishes = scenario.expectations.find((expectation) => expectation.kind === 'publishes');
    if (publishes) {
      skipped.push({ title, reason: 'it expects an event, and only a service publishes one' });
      continue;
    }

    const operation = aggregate.operations.find((candidate) => candidate.phrase === owner.operation.phrase);
    if (!operation) {
      skipped.push({ title, reason: `${aggregate.name} declares no body for "${call.operation}"` });
      continue;
    }

    const unusable = unusableValue(index, scenario, operation);
    if (unusable) {
      skipped.push({ title, reason: unusable });
      continue;
    }

    compiled.push({
      scenario,
      title,
      aggregate,
      operation,
      receiver,
      binding: returnsNothing(operation) ? null : scenario.when.binding,
      expectations: scenario.expectations,
      given: scenario.given.map((step) => ({ ...step, value: retyped(index, step.value, undefined) })),
      call: retypedCall(index, call, operation),
    });
  }

  return { compiled, skipped };
}

/**
 * A value the interpreter accepts but a generated test would not.
 *
 * `given order be Order with id = "o-1"` reads well and runs fine here, where a
 * uuid is a string like any other. It does not survive contact with a backend
 * that models `uuid` as a uuid: pydantic rejects `"o-1"`, and so do Java and
 * Rust. Compiling that scenario would produce a test that fails for a reason
 * the design never described, so it stays with the interpreter and says why.
 */
function unusableValue(index: ModuleIndex, scenario: IRScenarioDecl, operation: IROperation): string | null {
  const problems: string[] = [];

  const check = (type: IRType | undefined, value: IRExpression, where: string): void => {
    if (!type || value.kind !== 'literal' || typeof value.value !== 'string') return;
    if (unwrapOptional(type).kind !== 'primitive') return;
    if ((unwrapOptional(type) as { name: string }).name !== 'uuid') return;
    if (UUID.test(value.value)) return;
    problems.push(`${where} is "${value.value}", which is not a uuid`);
  };

  for (const step of scenario.given) {
    if (step.value.kind !== 'construct') continue;
    const shape = index.get(step.value.type);
    if (!shape || !('fields' in shape)) continue;
    for (const argument of step.value.arguments) {
      check(shape.fields.find((field) => field.name === argument.name)?.type, argument.value, `${step.value.type}.${argument.name}`);
    }
  }

  if (scenario.when.call.kind === 'call') {
    for (const argument of scenario.when.call.arguments) {
      check(operation.parameters.find((parameter) => parameter.name === argument.name)?.type, argument.value, argument.name);
    }
  }

  return problems.length === 0 ? null : `${problems[0]}, and a generated test would be checked`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A literal, carrying the type of the field it fills rather than its own.
 *
 * The parser types `"7f3a…"` as text, because that is what it looks like. A
 * backend that models `uuid` as a uuid then emits a bare string into a call
 * that wanted a UUID, and the comparison inside the operation silently never
 * matches. Filling in the declared type before lowering is what keeps a
 * generated test asking the question the scenario asked.
 */
function retyped(index: ModuleIndex, expression: IRExpression, declared: IRType | undefined): IRExpression {
  if (expression.kind === 'literal') {
    return declared && typeof expression.value === 'string' ? { ...expression, type: declared } : expression;
  }
  if (expression.kind === 'construct') {
    const shape = index.get(expression.type);
    const fields = shape && 'fields' in shape ? shape.fields : [];
    return {
      ...expression,
      arguments: expression.arguments.map((argument) => ({
        ...argument,
        value: retyped(index, argument.value, fields.find((field) => field.name === argument.name)?.type),
      })),
    };
  }
  if (expression.kind === 'list') {
    return { ...expression, items: expression.items.map((item) => retyped(index, item, elementOf(declared))) };
  }
  return expression;
}

function retypedCall(index: ModuleIndex, call: IRExpression, operation: IROperation): IRExpression {
  if (call.kind !== 'call') return call;
  return {
    ...call,
    arguments: call.arguments.map((argument) => ({
      ...argument,
      value: retyped(index, argument.value, operation.parameters.find((parameter) => parameter.name === argument.name)?.type),
    })),
  };
}

function elementOf(type: IRType | undefined): IRType | undefined {
  if (!type) return undefined;
  const inner = type.kind === 'optional' ? type.of : type;
  return inner.kind === 'list' || inner.kind === 'set' ? inner.of : undefined;
}

function unwrapOptional(type: IRType): IRType {
  return type.kind === 'optional' ? type.of : type;
}

/** The scenario the plan came from expects a failure rather than a value. */
export function expectedFailure(plan: ScenarioPlan): string | null {
  const fails = plan.expectations.find((expectation) => expectation.kind === 'fails');
  return fails && fails.kind === 'fails' ? fails.error : null;
}

function receiverBinding(args: readonly IRArgument[], aggregate: IRAggregateDecl, scenario: IRScenarioDecl): string | null {
  const expected = camelCase(aggregate.name);
  const argument = args.find((candidate) => camelCase(candidate.name) === expected);
  if (!argument || argument.value.kind !== 'reference' || argument.value.path.length !== 1) return null;

  const binding = argument.value.path[0]!;
  return scenario.given.some((step) => step.binding === binding) ? binding : null;
}

function returnsNothing(operation: IROperation): boolean {
  const returns = operation.returns.kind === 'result' ? operation.returns.ok : operation.returns;
  return returns.kind === 'primitive' && returns.name === 'nothing';
}

/** The heading as written; the description's first line is where it lands. */
function titleOf(scenario: IRScenarioDecl): string {
  return scenario.description?.split('\n')[0]?.trim() || scenario.name;
}
