/**
 * Which scenarios a backend can compile into a test.
 *
 * `haic test` runs scenarios against the IR, which is fast, needs no toolchain,
 * and cannot execute a fenced block — so the part of a system most worth
 * exercising is exactly the part the interpreter has to skip. Compiling a
 * scenario into the target language closes that gap: the same `given`, the same
 * call, the same expectations, run against the code that actually ships.
 *
 * Two shapes compile. An aggregate scenario needs nothing but the aggregate:
 * construct it, call the method, check the result. A service scenario needs its
 * ports standing in for a database and its publisher watched, which is exactly
 * what the interpreter does — so the backend builds the same thing in the target
 * language: an in-memory double per port, seeded from `given`, and a publisher
 * that records what it was handed.
 *
 * What does not compile is reported, never dropped. A port whose operations are
 * not the repository phrases a double can answer would need a body nobody wrote,
 * and inventing one produces a test that fails for reasons the design never
 * described. That scenario stays with the interpreter and says why.
 */
import { camelCase } from '../naming.js';
import type { ModuleIndex } from './index-module.js';
import type {
  IRAggregateDecl,
  IRArgument,
  IRExpression,
  IROperation,
  IROperationSignature,
  IRPortDecl,
  IRScenarioDecl,
  IRServiceDecl,
  IRType,
} from './schema.js';

interface PlanBase {
  scenario: IRScenarioDecl;
  /** Title as written in the heading, which is what a reader recognises. */
  title: string;
  operation: IROperation;
  /** Local the result is bound to, or null when the operation returns nothing. */
  binding: string | null;
  expectations: IRScenarioDecl['expectations'];
  /** `given` steps, with every literal carrying the type its field declares. */
  given: IRScenarioDecl['given'];
  /** The `when` call, retyped the same way. */
  call: IRExpression;
}

/** A scenario over an aggregate: no wiring, because there is nothing to wire. */
export interface AggregatePlan extends PlanBase {
  kind: 'aggregate';
  aggregate: IRAggregateDecl;
  /** `given` binding holding the receiver, e.g. `book`. */
  receiver: string;
}

/** A scenario over a service, with the doubles the test has to stand up first. */
export interface ServicePlan extends PlanBase {
  kind: 'service';
  service: IRServiceDecl;
  /** Outbound ports the service holds, in constructor order. */
  ports: IRPortDecl[];
  /** `given` aggregates, and the port operation that puts each one in the store. */
  seeds: Array<{ binding: string; port: IRPortDecl; save: IROperationSignature }>;
  /** Whether any expectation watches the publisher. */
  observesEvents: boolean;
}

export type ScenarioPlan = AggregatePlan | ServicePlan;

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

    const resolved = index.resolvePhrase(call.operation);
    const owner = resolved.find((entry) => entry.owner.kind === 'aggregate');
    const serviceOwner = resolved.find((entry) => entry.owner.kind === 'service');

    if (!owner && serviceOwner) {
      const plan = servicePlan(index, scenario, title, serviceOwner.owner as IRServiceDecl, serviceOwner.operation.phrase);
      if ('reason' in plan) skipped.push({ title, reason: plan.reason });
      else compiled.push(plan);
      continue;
    }
    if (!owner) {
      skipped.push({ title, reason: `"${call.operation}" is not an operation this module declares a body for` });
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


    compiled.push({
      kind: 'aggregate',
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
 * A service scenario, or the reason it stays with the interpreter.
 *
 * The doubles a test needs are the ones the in-memory adapter already knows how
 * to be: find one by id, save one, list them, delete one. A port asking for
 * anything else has a body only its author can write, and a test built on a
 * guess at it would fail for reasons the design never described.
 */
function servicePlan(
  index: ModuleIndex,
  scenario: IRScenarioDecl,
  title: string,
  service: IRServiceDecl,
  phrase: string,
): ServicePlan | { reason: string } {
  const operation = service.operations.find((candidate) => candidate.phrase === phrase);
  if (!operation) return { reason: `${service.name} declares no body for "${phrase}"` };

  const ports: IRPortDecl[] = [];
  for (const name of service.uses) {
    const port = index.typed(name, 'port');
    if (!port) return { reason: `${name} is not a port this module declares` };
    const unfakeable = port.operations.find((candidate) => repositoryPhrase(candidate.phrase) === null);
    if (unfakeable) {
      return { reason: `${port.name}.${unfakeable.phrase} is not a repository phrase a test double can answer` };
    }
    ports.push(port);
  }

  // Every aggregate the scenario seeds has to reach the store the service reads
  // from, which means some port has to be able to save it.
  const seeds: ServicePlan['seeds'] = [];
  for (const step of scenario.given) {
    if (step.value.kind !== 'construct') continue;
    const shape = index.get(step.value.type);
    if (shape?.kind !== 'aggregate') continue;

    const found = savesAggregate(ports, shape.name);
    if (!found) return { reason: `no port saves a ${shape.name}, so "given ${step.binding}" could not be stored` };
    seeds.push({ binding: step.binding, port: found.port, save: found.save });
  }

  return {
    kind: 'service',
    scenario,
    title,
    service,
    operation,
    ports,
    seeds,
    observesEvents: scenario.expectations.some((expectation) => expectation.kind === 'publishes'),
    binding: returnsNothing(operation) ? null : scenario.when.binding,
    expectations: scenario.expectations,
    given: scenario.given.map((step) => ({ ...step, value: retyped(index, step.value, undefined) })),
    call: retypedCall(index, scenario.when.call, operation),
  };
}

/** The port operation that stores `aggregate`, if one of them does. */
function savesAggregate(ports: readonly IRPortDecl[], aggregate: string): { port: IRPortDecl; save: IROperationSignature } | null {
  for (const port of ports) {
    for (const operation of port.operations) {
      if (repositoryPhrase(operation.phrase) !== 'save') continue;
      const parameter = operation.parameters[0]?.type;
      if (parameter?.kind === 'named' && parameter.name === aggregate) return { port, save: operation };
    }
  }
  return null;
}

/**
 * The four phrase families an in-memory double answers.
 *
 * The same four the in-memory adapter recognises, deliberately: a test double
 * that behaved differently from the adapter would be testing something else.
 */
export function repositoryPhrase(phrase: string): 'find' | 'save' | 'list' | 'delete' | null {
  const normalised = phrase.toLowerCase();
  if (/^(find|get|read|load)\b.*\bby id$/.test(normalised)) return 'find';
  if (/^(save|store|persist|upsert)\b/.test(normalised)) return 'save';
  if (/^(list|find all|search)\b/.test(normalised)) return 'list';
  if (/^(delete|remove)\b/.test(normalised)) return 'delete';
  return null;
}


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
