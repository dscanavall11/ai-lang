/**
 * Domain-Driven Design invariants, enforced by the compiler rather than by
 * convention. These are the rules that stop generated code from drifting into
 * an anemic model or a tangle of cross-aggregate references.
 */
import { referencedNames, type SourceSpan } from '@ai-lang/core';
import type { AnalysisContext, SemanticPass } from '../context.js';
import { typesOfDeclaration, walkExpressions } from '../walk.js';

export const dddPass: SemanticPass = {
  id: 'ddd',
  stage: 'ddd',
  run(context) {
    checkAggregateMembership(context);
    checkAggregateBoundaries(context);
    checkAggregateReferences(context);
    checkValueObjects(context);
    checkEventsAndCommands(context);
    checkDomainPurity(context);
    checkAnemicModel(context);
  },
};

/** `contains` must name entities, and every entity must belong to exactly one aggregate. */
function checkAggregateMembership(context: AnalysisContext): void {
  const owners = new Map<string, string>();

  for (const aggregate of context.index.aggregates) {
    for (const entityName of aggregate.entities) {
      const entity = context.index.get(entityName);
      if (!entity) {
        error(context, 'AIL2201', `aggregate ${aggregate.name} contains "${entityName}", which is not declared`, aggregate.span);
        continue;
      }
      if (entity.kind !== 'entity') {
        error(
          context,
          'AIL2202',
          `aggregate ${aggregate.name} contains ${entity.kind} ${entityName}; only entities live inside an aggregate`,
          aggregate.span,
          entity.kind === 'aggregate'
            ? 'aggregates reference each other by identity, never by containment'
            : 'value objects are used as field types, not as contained entities',
        );
        continue;
      }
      const previous = owners.get(entityName);
      if (previous && previous !== aggregate.name) {
        error(
          context,
          'AIL2203',
          `entity ${entityName} is claimed by both ${previous} and ${aggregate.name}`,
          aggregate.span,
          'an entity belongs to exactly one aggregate',
        );
        continue;
      }
      owners.set(entityName, aggregate.name);
      if (entity.aggregate && entity.aggregate !== aggregate.name) {
        error(
          context,
          'AIL2204',
          `entity ${entityName} says it belongs to ${entity.aggregate} but ${aggregate.name} contains it`,
          entity.span,
        );
      }
    }
  }

  for (const entity of context.index.entities) {
    if (!owners.has(entity.name) && !entity.aggregate) {
      warn(
        context,
        'AIL2205',
        `entity ${entity.name} does not belong to any aggregate`,
        entity.span,
        `add "contains ${entity.name}" to the owning aggregate, or make ${entity.name} an aggregate itself`,
      );
    }
  }
}

/** Only the aggregate root is visible outside its own boundary. */
function checkAggregateBoundaries(context: AnalysisContext): void {
  const owner = new Map<string, string>();
  for (const aggregate of context.index.aggregates) {
    for (const entityName of aggregate.entities) owner.set(entityName, aggregate.name);
  }
  if (owner.size === 0) return;

  for (const declaration of context.module.declarations) {
    if (declaration.kind === 'aggregate' || declaration.kind === 'entity') continue;
    for (const use of typesOfDeclaration(declaration)) {
      for (const name of referencedNames(use.type)) {
        const aggregateName = owner.get(name);
        if (!aggregateName) continue;
        error(
          context,
          'AIL2206',
          `${use.where} reaches into ${aggregateName} to use its inner entity ${name}`,
          use.span ?? declaration.span,
          `go through the aggregate root ${aggregateName}, or expose a dto that carries just the data you need`,
        );
      }
    }
  }
}

/** Aggregates reference other aggregates by identity, never by embedding them. */
function checkAggregateReferences(context: AnalysisContext): void {
  const aggregates = new Set(context.index.aggregates.map((a) => a.name));
  for (const aggregate of context.index.aggregates) {
    for (const field of aggregate.fields) {
      for (const name of referencedNames(field.type)) {
        if (name === aggregate.name || !aggregates.has(name)) continue;
        error(
          context,
          'AIL2207',
          `aggregate ${aggregate.name} embeds aggregate ${name} in field "${field.name}"`,
          field.span ?? aggregate.span,
          `store the identity instead: "- ${field.name}Id: uuid, required"`,
        );
      }
    }
  }
}

/** Value objects are compared by value, so they may not hold entities or aggregates. */
function checkValueObjects(context: AnalysisContext): void {
  const identified = new Set([...context.index.entities, ...context.index.aggregates].map((d) => d.name));
  for (const valueObject of context.index.valueObjects) {
    for (const field of valueObject.fields) {
      for (const name of referencedNames(field.type)) {
        if (!identified.has(name)) continue;
        error(
          context,
          'AIL2208',
          `value object ${valueObject.name} holds ${name}, which has an identity`,
          field.span ?? valueObject.span,
          'value objects are compared field by field; reference the identity as a uuid instead',
        );
      }
    }
  }
}

function checkEventsAndCommands(context: AnalysisContext): void {
  const aggregates = new Map(context.index.aggregates.map((a) => [a.name, a]));

  for (const event of context.index.events) {
    if (event.source && !aggregates.has(event.source)) {
      error(context, 'AIL2209', `event ${event.name} comes from "${event.source}", which is not an aggregate`, event.span);
    }
  }
  for (const command of context.index.commands) {
    if (command.target && !aggregates.has(command.target)) {
      error(context, 'AIL2210', `command ${command.name} targets "${command.target}", which is not an aggregate`, command.span);
    }
  }
  for (const aggregate of aggregates.values()) {
    for (const eventName of aggregate.emits) {
      const event = context.index.get(eventName);
      if (event?.kind !== 'event') {
        error(context, 'AIL2211', `aggregate ${aggregate.name} emits "${eventName}", which is not a declared event`, aggregate.span);
        continue;
      }
      if (event.source && event.source !== aggregate.name) {
        error(
          context,
          'AIL2212',
          `event ${eventName} says it comes from ${event.source} but ${aggregate.name} emits it`,
          aggregate.span,
        );
      }
    }
  }
}

/** The domain layer performs no I/O: aggregate operations may not call ports. */
function checkDomainPurity(context: AnalysisContext): void {
  const portPhrases = new Map<string, string>();
  for (const port of context.index.ports) {
    for (const operation of port.operations) portPhrases.set(operation.phrase.toLowerCase(), port.name);
  }

  for (const aggregate of context.index.aggregates) {
    for (const operation of aggregate.operations) {
      for (const expression of walkExpressions(operation.body)) {
        if (expression.kind !== 'call') continue;
        const portName = portPhrases.get(expression.operation.toLowerCase());
        if (!portName) continue;
        error(
          context,
          'AIL2213',
          `${aggregate.name}.${operation.phrase} calls "${expression.operation}" on port ${portName}`,
          expression.span ?? operation.span,
          'aggregates hold rules, not I/O; move the call into the service that orchestrates this operation',
        );
      }
    }
  }
}

/** An aggregate with neither rules nor behaviour is a database row wearing a costume. */
function checkAnemicModel(context: AnalysisContext): void {
  for (const aggregate of context.index.aggregates) {
    if (aggregate.invariants.length > 0 || aggregate.operations.length > 0) continue;
    warn(
      context,
      'AIL2214',
      `aggregate ${aggregate.name} has no invariants and no operations`,
      aggregate.span,
      'add the rule that makes this aggregate a consistency boundary, or model it as a dto if it is really just data',
    );
  }
}

function error(context: AnalysisContext, code: string, message: string, span: SourceSpan | undefined, hint?: string): void {
  context.diagnostics.error('ddd', code, message, span ?? fallback(context), hint ? { hint } : {});
}

function warn(context: AnalysisContext, code: string, message: string, span: SourceSpan | undefined, hint?: string): void {
  context.diagnostics.warn('ddd', code, message, span ?? fallback(context), hint ? { hint } : {});
}

function fallback(context: AnalysisContext): SourceSpan {
  const file = context.module.source?.file ?? '<unknown>';
  return { file, start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } };
}
