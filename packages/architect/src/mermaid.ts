/**
 * Mermaid diagrams.
 *
 * The diagrams are part of the review surface: a reader who will not open the
 * IR will look at the context map. They are built from the same state the
 * `.hadl` files come from, so they can never drift.
 */
import type { AggregatePlan, BoundedContextPlan, ContextEdge, EntityPlan, ValueObjectPlan } from './types.js';

export function contextMapDiagram(contexts: readonly BoundedContextPlan[], edges: readonly ContextEdge[]): string {
  const lines = ['flowchart LR'];
  for (const context of contexts) {
    lines.push(`  ${context.name}["${context.name}<br/><small>${context.kind}</small>"]`);
  }
  for (const edge of edges) {
    lines.push(`  ${edge.upstream} -->|${edge.relationship}| ${edge.downstream}`);
  }
  if (edges.length === 0) lines.push('  %% no context shares vocabulary with another');
  return lines.join('\n');
}

export interface WorkflowSteps {
  actor: string;
  route: string;
  service: string;
  operation: string;
  repository: string;
  aggregate: string;
  event: string | null;
  errors: readonly string[];
}

export function workflowDiagram(steps: WorkflowSteps): string {
  const lines = ['sequenceDiagram', '  autonumber', `  actor ${identifier(steps.actor)}`];
  lines.push(`  participant Api as ${steps.route}`);
  lines.push(`  participant Service as ${steps.service}`);
  lines.push(`  participant Repository as ${steps.repository}`);
  lines.push(`  ${identifier(steps.actor)}->>Api: ${steps.route}`);
  lines.push(`  Api->>Service: ${steps.operation}`);
  lines.push(`  Service->>Repository: load ${steps.aggregate}`);
  lines.push(`  Repository-->>Service: ${steps.aggregate}`);
  for (const error of steps.errors) {
    lines.push(`  alt ${error}`);
    lines.push(`    Service-->>Api: ${error}`);
    lines.push('  end');
  }
  lines.push(`  Service->>Repository: save ${steps.aggregate}`);
  if (steps.event) lines.push(`  Service-->>Api: ${steps.event}`);
  lines.push(`  Api-->>${identifier(steps.actor)}: response`);
  return lines.join('\n');
}

export function modelDiagram(
  aggregates: readonly AggregatePlan[],
  entities: readonly EntityPlan[],
  valueObjects: readonly ValueObjectPlan[],
): string {
  const lines = ['classDiagram'];

  for (const aggregate of aggregates) {
    lines.push(...classBlock(aggregate.name, 'aggregate root', aggregate.fields));
  }
  for (const entity of entities) {
    lines.push(...classBlock(entity.name, 'entity', entity.fields));
  }
  for (const valueObject of valueObjects) {
    lines.push(...classBlock(valueObject.name, 'value object', valueObject.fields));
  }
  for (const entity of entities) {
    lines.push(`  ${entity.aggregate} "1" *-- "many" ${entity.name} : contains`);
  }
  for (const aggregate of aggregates) {
    for (const field of aggregate.fields) {
      const target = referenceTarget(field.name, aggregates, entities);
      if (target) lines.push(`  ${aggregate.name} ..> ${target} : ${field.name}`);
    }
  }
  return lines.join('\n');
}

function classBlock(name: string, stereotype: string, fields: readonly { name: string; type: string }[]): string[] {
  const lines = [`  class ${name} {`, `    <<${stereotype}>>`];
  for (const field of fields) lines.push(`    +${memberType(field.type)} ${field.name}`);
  lines.push('  }');
  return lines;
}

/** Mermaid members cannot carry spaces, so collection syntax is compacted. */
function memberType(type: string): string {
  const list = /^list of (.+)$/.exec(type);
  if (list) return `${list[1]!}[]`;
  const optional = /^(.+) or nothing$/.exec(type);
  if (optional) return `${optional[1]!}?`;
  return type.replace(/\s+/g, '_');
}

function referenceTarget(
  fieldName: string,
  aggregates: readonly AggregatePlan[],
  entities: readonly EntityPlan[],
): string | null {
  const match = /^(.+)Id$/.exec(fieldName);
  if (!match) return null;
  const target = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1);
  const known = [...aggregates.map((a) => a.name), ...entities.map((e) => e.name)];
  return known.includes(target) ? target : null;
}

function identifier(text: string): string {
  return text.replace(/[^A-Za-z0-9]/g, '') || 'Actor';
}
