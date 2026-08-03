/**
 * Phase 3 - design.
 *
 * Turns capabilities into an HTTP surface and a set of domain events, and picks
 * one code generation target per bounded context. A target is only chosen when
 * the requirements contain a signal that justifies it; otherwise the default is
 * recorded as an assumption, not presented as a decision.
 */
import type { CodegenTarget, DiagnosticBag } from '@haic/core';
import { DEFAULT_TARGET, STACK_RULES, matchMarker } from '../lexicon.js';
import { workflowDiagram } from '../mermaid.js';
import {
  aggregateName,
  eventName,
  methodFor,
  notFoundName,
  operationPhrase,
  repositoryName,
  routeFor,
  serviceName,
  topicName,
} from '../naming.js';
import type { Phase } from '../phase.js';
import { QUESTION_CODES, ask } from '../questions.js';
import type {
  ArchitectState,
  BoundedContextPlan,
  Capability,
  EndpointPlan,
  EventPlan,
  StackChoice,
  WorkflowDiagram,
} from '../types.js';

export const designPhase: Phase = {
  id: 'design',
  title: 'Design',

  run(state: ArchitectState, diagnostics: DiagnosticBag): void {
    const stacks = selectStacks(state, diagnostics);
    const endpoints = buildEndpoints(state, diagnostics);
    const events = buildEvents(state);
    const workflows = buildWorkflows(state, endpoints, events);
    state.design = { stacks, endpoints, events, workflows };
  },
};

// ---------------------------------------------------------------------------
// Technology selection
// ---------------------------------------------------------------------------

function selectStacks(state: ArchitectState, diagnostics: DiagnosticBag): StackChoice[] {
  const projectSignal = firstSignal(state.document.text);
  const choices: StackChoice[] = [];

  for (const context of state.architecture.contexts) {
    const local = firstSignal(textOf(state, context));
    const signal = local ?? projectSignal;
    if (signal) {
      choices.push({
        context: context.name,
        target: signal.target,
        signal: signal.marker,
        reason: `"${signal.marker}" appears in the ${local ? 'requirements for this context' : 'requirements'}, and ${signal.rationale}`,
      });
      continue;
    }
    choices.push({
      context: context.name,
      target: DEFAULT_TARGET,
      signal: null,
      reason: `no requirement states a performance, platform or data constraint, so the default target ${DEFAULT_TARGET} applies`,
    });
  }

  if (!projectSignal && choices.every((choice) => choice.signal === null) && choices.length > 0) {
    ask(state, diagnostics, {
      code: QUESTION_CODES.noStackSignal,
      phase: 'design',
      line: 1,
      ambiguity: 'the requirements state no performance budget, platform constraint or existing estate.',
      question: 'Which runtime must these services be written for, and why?',
      assumption: `every context is generated for ${DEFAULT_TARGET}`,
      evidence: state.document.title ?? state.input.projectName,
    });
  }
  return choices;
}

interface Signal {
  target: CodegenTarget;
  marker: string;
  rationale: string;
}

function firstSignal(text: string): Signal | null {
  for (const rule of STACK_RULES) {
    const marker = matchMarker(text, rule.markers);
    if (marker) return { target: rule.target, marker, rationale: rule.rationale };
  }
  return null;
}

function textOf(state: ArchitectState, context: BoundedContextPlan): string {
  const capabilities = capabilitiesOf(state, context);
  const criteria = state.explore.criteria.filter((criterion) =>
    criterion.capabilities.some((id) => context.capabilities.includes(id)),
  );
  return [...capabilities.map((c) => `${c.name} ${c.object} ${c.benefit ?? ''}`), ...criteria.map((c) => c.text)].join(' ');
}

// ---------------------------------------------------------------------------
// HTTP surface and events
// ---------------------------------------------------------------------------

function buildEndpoints(state: ArchitectState, diagnostics: DiagnosticBag): EndpointPlan[] {
  const endpoints: EndpointPlan[] = [];
  const routes = new Map<string, string>();

  for (const context of state.architecture.contexts) {
    for (const capability of capabilitiesOf(state, context)) {
      const method = methodFor(capability);
      const path = routeFor(capability);
      const route = `${method} ${path}`;
      const owner = routes.get(route);
      if (owner) {
        ask(state, diagnostics, {
          code: QUESTION_CODES.duplicateRoute,
          phase: 'design',
          line: capability.line,
          ambiguity: `"${capability.name}" and "${owner}" both map to ${route}.`,
          question: `How should ${route} tell the two apart?`,
          assumption: `only "${owner}" is exposed; "${capability.name}" has no route`,
          evidence: capability.name,
        });
        continue;
      }
      routes.set(route, capability.name);
      endpoints.push({
        context: context.name,
        capability: capability.id,
        method,
        path,
        resource: aggregateName(capability.aggregate),
        auth: capability.actor ? 'bearer' : 'none',
      });
    }
  }
  return endpoints;
}

function buildEvents(state: ArchitectState): EventPlan[] {
  const events: EventPlan[] = [];
  for (const context of state.architecture.contexts) {
    for (const capability of capabilitiesOf(state, context)) {
      if (capability.verbClass === 'read') continue;
      const name = eventName(capability);
      if (events.some((event) => event.name === name)) continue;
      events.push({
        context: context.name,
        capability: capability.id,
        name,
        source: aggregateName(capability.aggregate),
        topic: topicName(name),
      });
    }
  }
  return events;
}

/** One sequence diagram per capability of a core context. */
function buildWorkflows(
  state: ArchitectState,
  endpoints: readonly EndpointPlan[],
  events: readonly EventPlan[],
): WorkflowDiagram[] {
  const workflows: WorkflowDiagram[] = [];
  for (const context of state.architecture.contexts) {
    if (context.kind !== 'core') continue;
    for (const capability of capabilitiesOf(state, context)) {
      const endpoint = endpoints.find((e) => e.capability === capability.id);
      if (!endpoint) continue;
      const aggregate = aggregateName(capability.aggregate);
      const event = events.find((e) => e.capability === capability.id);
      workflows.push({
        context: context.name,
        capability: capability.id,
        title: capability.name,
        diagram: workflowDiagram({
          actor: capability.actor ?? 'Client',
          route: `${endpoint.method} ${endpoint.path}`,
          service: serviceName(aggregate),
          operation: operationPhrase(capability),
          repository: repositoryName(aggregate),
          aggregate,
          event: event?.name ?? null,
          errors: capability.verbClass === 'create' || capability.verbClass === 'read' ? [] : [notFoundName(aggregate)],
        }),
      });
    }
  }
  return workflows;
}

export function capabilitiesOf(state: ArchitectState, context: BoundedContextPlan): Capability[] {
  return state.explore.capabilities.filter((capability) => context.capabilities.includes(capability.id));
}
