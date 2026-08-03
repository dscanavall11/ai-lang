/**
 * Phase 5 — implementation plan.
 *
 * The task list follows the dependency direction of the architecture: the
 * domain has nothing to wait for, the application waits for the domain, and the
 * edges wait for the application. Each task is sized to one aggregate feature,
 * because that is the unit a reviewer can hold in their head.
 */
import type { DiagnosticBag } from '@haic/core';
import type { Phase } from '../phase.js';
import type { ArchitectState, DddLayer, TaskPlan } from '../types.js';
import { adapterName, repositoryName, serviceName } from '../naming.js';

export const planPhase: Phase = {
  id: 'plan',
  title: 'Implementation plan',

  run(state: ArchitectState, diagnostics: DiagnosticBag): void {
    const tasks: TaskPlan[] = [];
    let counter = 0;
    const nextId = (): string => `T${String(++counter).padStart(3, '0')}`;

    for (const context of state.architecture.contexts) {
      const aggregates = state.model.aggregates.filter((a) => a.context === context.name);
      const entities = state.model.entities.filter((e) => e.context === context.name);
      const valueObjects = state.model.valueObjects.filter((v) => v.context === context.name);
      const endpoints = state.design.endpoints.filter((e) => e.context === context.name);
      const events = state.model.events.filter((e) => e.context === context.name);

      // Value objects first: aggregates depend on them, and they need no context.
      const valueObjectTasks = valueObjects.map((valueObject) =>
        add(tasks, nextId(), context.name, 'domain', `Define value object ${valueObject.name}`, [], true, null),
      );

      const entityTasks = entities.map((entity) =>
        add(tasks, nextId(), context.name, 'domain', `Define entity ${entity.name}`, valueObjectTasks, true, null),
      );

      const aggregateTasks = new Map<string, string>();
      for (const aggregate of aggregates) {
        const owned = entities.filter((e) => e.aggregate === aggregate.name);
        const dependencies = [...valueObjectTasks, ...owned.map((e) => taskIdFor(tasks, context.name, `Define entity ${e.name}`))];
        const id = add(
          tasks,
          nextId(),
          context.name,
          'domain',
          `Define aggregate ${aggregate.name} with ${count(aggregate.invariants.length, 'invariant')}`,
          dependencies.filter(Boolean),
          true,
          null,
        );
        aggregateTasks.set(aggregate.name, id);
      }

      for (const event of events) {
        const source = aggregateTasks.get(event.source);
        add(tasks, nextId(), context.name, 'domain', `Define event ${event.name}`, source ? [source] : [], true, null);
      }

      // Application: one port and one service operation per aggregate.
      const portTasks = new Map<string, string>();
      for (const aggregate of aggregates) {
        const dependsOn = aggregateTasks.get(aggregate.name);
        const id = add(
          tasks,
          nextId(),
          context.name,
          'application',
          `Declare port ${repositoryName(aggregate.name)}`,
          dependsOn ? [dependsOn] : [],
          true,
          null,
        );
        portTasks.set(aggregate.name, id);
      }

      const serviceTasks = new Map<string, string>();
      for (const aggregate of aggregates) {
        const port = portTasks.get(aggregate.name);
        const id = add(
          tasks,
          nextId(),
          context.name,
          'application',
          `Implement ${serviceName(aggregate.name)}`,
          port ? [port] : [],
          false,
          null,
        );
        serviceTasks.set(aggregate.name, id);
      }

      // Infrastructure and edges can proceed in parallel once the service exists.
      for (const aggregate of aggregates) {
        const service = serviceTasks.get(aggregate.name);
        add(
          tasks,
          nextId(),
          context.name,
          'infrastructure',
          `Implement adapter ${adapterName(aggregate.name)}`,
          service ? [service] : [],
          true,
          null,
        );
      }

      for (const endpoint of endpoints) {
        const service = serviceTasks.get(endpoint.resource);
        add(
          tasks,
          nextId(),
          context.name,
          'interface',
          `Expose ${endpoint.method} ${endpoint.path}`,
          service ? [service] : [],
          true,
          endpoint.capability,
        );
      }

      if (aggregates.length === 0) {
        diagnostics.info(
          'architect',
          'HADL3090',
          `bounded context ${context.name} produced no aggregates, so it has no tasks`,
          { file: state.input.path, start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } },
          { hint: 'the requirements may describe it only in passing; say what it owns, or drop it' },
        );
      }
    }

    state.plan = { tasks };
  },
};

function add(
  tasks: TaskPlan[],
  id: string,
  context: string,
  layer: DddLayer,
  title: string,
  dependsOn: readonly string[],
  parallel: boolean,
  capability: string | null,
): string {
  tasks.push({ id, context, layer, title, dependsOn: [...new Set(dependsOn)], parallel, capability });
  return id;
}

function taskIdFor(tasks: readonly TaskPlan[], context: string, title: string): string {
  return tasks.find((t) => t.context === context && t.title === title)?.id ?? '';
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
