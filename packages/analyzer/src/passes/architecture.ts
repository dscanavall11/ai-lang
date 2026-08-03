/**
 * Hexagonal architecture and SOLID, checked mechanically.
 *
 * The generated code can only be as clean as the shape it comes from, so the
 * shape is what the compiler polices: services depend on ports, adapters
 * implement exactly one port, and nothing in the domain knows about transport.
 */
import { normalisePhrase, typeToString, typeEquals, type SourceSpan } from '@haic/core';
import type { AnalysisContext, SemanticPass } from '../context.js';
import { withSuggestion } from '../context.js';

/** Above this, a port is doing more than one job and its clients pay for it. */
const PORT_OPERATION_LIMIT = 7;

export const architecturePass: SemanticPass = {
  id: 'architecture',
  stage: 'resolve',
  run(context) {
    checkServiceDependencies(context);
    checkAdapters(context);
    checkPortsAreImplemented(context);
    checkInboundPorts(context);
    checkEndpoints(context);
    checkHandlers(context);
    checkInterfaceSegregation(context);
    checkSingleResponsibility(context);
  },
};

/** Dependency inversion: a service names ports, never concrete adapters. */
function checkServiceDependencies(context: AnalysisContext): void {
  for (const service of context.index.services) {
    for (const name of service.uses) {
      const dependency = context.index.get(name);
      if (!dependency) {
        error(context, 'HADL2401', `service ${service.name} uses "${name}", which is not declared`, service.span, {
          hint: withSuggestion('', name, context.index.ports.map((p) => p.name)),
        });
        continue;
      }
      if (dependency.kind === 'adapter') {
        error(
          context,
          'HADL2402',
          `service ${service.name} depends on the adapter ${name}`,
          service.span,
          { hint: `depend on the port it implements instead: "uses ${dependency.implements}"` },
        );
        continue;
      }
      if (dependency.kind !== 'port') {
        error(
          context,
          'HADL2403',
          `service ${service.name} uses ${dependency.kind} ${name}; services depend on ports only`,
          service.span,
        );
      }
    }
  }
}

function checkAdapters(context: AnalysisContext): void {
  for (const adapter of context.index.adapters) {
    const port = context.index.get(adapter.implements);
    if (!port) {
      error(context, 'HADL2404', `adapter ${adapter.name} implements "${adapter.implements}", which is not declared`, adapter.span, {
        hint: withSuggestion('', adapter.implements, context.index.ports.map((p) => p.name)),
      });
      continue;
    }
    if (port.kind !== 'port') {
      error(context, 'HADL2405', `adapter ${adapter.name} implements ${port.kind} ${port.name}, which is not a port`, adapter.span);
      continue;
    }

    // Any operation the adapter spells out must match the port's contract exactly.
    for (const operation of adapter.operations) {
      const declared = port.operations.find((o) => normalisePhrase(o.phrase) === normalisePhrase(operation.phrase));
      if (!declared) {
        error(
          context,
          'HADL2406',
          `adapter ${adapter.name} defines "${operation.phrase}", which port ${port.name} does not declare`,
          operation.span ?? adapter.span,
          { hint: 'adapters implement the port contract; extra operations are unreachable' },
        );
        continue;
      }
      if (!typeEquals(declared.returns, operation.returns)) {
        error(
          context,
          'HADL2407',
          `adapter ${adapter.name}."${operation.phrase}" returns ${typeToString(operation.returns)} but port ${port.name} promises ${typeToString(declared.returns)}`,
          operation.span ?? adapter.span,
        );
      }
    }
  }
}

/** An outbound port with no adapter cannot run; the wiring would be missing. */
function checkPortsAreImplemented(context: AnalysisContext): void {
  const implemented = new Set(context.index.adapters.map((a) => a.implements));
  for (const port of context.index.ports) {
    if (port.direction !== 'outbound') continue;
    if (!implemented.has(port.name)) {
      error(context, 'HADL2408', `outbound port ${port.name} has no adapter`, port.span, {
        hint: `name a technology on the port itself with "using sql", or add "## adapter <Name> implements ${port.name} using sql"`,
      });
      continue;
    }

    // More than one is legitimate — an in-memory pair for tests is the usual
    // case — but the composition root can only wire one, so say which.
    const candidates = context.index.adapters.filter((a) => a.implements === port.name);
    if (candidates.length > 1) {
      warn(
        context,
        'HADL2423',
        `port ${port.name} has ${candidates.length} adapters: ${candidates.map((a) => a.name).join(', ')}`,
        port.span,
        `the generated composition root wires ${candidates[0]!.name}; delete the others or wire them yourself`,
      );
    }
  }
}

/** An inbound port describes a use case, so a service must fulfil it. */
function checkInboundPorts(context: AnalysisContext): void {
  for (const port of context.index.ports) {
    if (port.direction !== 'inbound') continue;
    const implementations = context.index.services.filter((s) => s.implements === port.name);
    if (implementations.length === 0) {
      error(context, 'HADL2409', `inbound port ${port.name} is not implemented by any service`, port.span, {
        hint: `add "implements ${port.name}" to the service that carries out this use case`,
      });
      continue;
    }
    for (const service of implementations) {
      for (const declared of port.operations) {
        const found = service.operations.find((o) => normalisePhrase(o.phrase) === normalisePhrase(declared.phrase));
        if (!found) {
          error(
            context,
            'HADL2410',
            `service ${service.name} implements ${port.name} but does not define "${declared.phrase}"`,
            service.span,
          );
          continue;
        }
        if (!typeEquals(found.returns, declared.returns)) {
          error(
            context,
            'HADL2411',
            `${service.name}."${declared.phrase}" returns ${typeToString(found.returns)} but ${port.name} promises ${typeToString(declared.returns)}`,
            found.span ?? service.span,
          );
        }
      }
    }
  }
}

function checkEndpoints(context: AnalysisContext): void {
  const seen = new Map<string, string>();

  for (const endpoint of context.index.endpoints) {
    const route = `${endpoint.method} ${endpoint.path}`;
    const previous = seen.get(route);
    if (previous) {
      error(context, 'HADL2412', `${route} is declared twice`, endpoint.span);
    }
    seen.set(route, endpoint.name);

    const service = context.index.get(endpoint.handler.service);
    if (!service) {
      error(context, 'HADL2413', `${route} is handled by "${endpoint.handler.service}", which is not declared`, endpoint.span, {
        hint: withSuggestion('', endpoint.handler.service, context.index.services.map((s) => s.name)),
      });
      continue;
    }
    if (service.kind !== 'service') {
      error(context, 'HADL2414', `${route} is handled by ${service.kind} ${service.name}; endpoints call services`, endpoint.span);
      continue;
    }
    const operation = service.operations.find((o) => normalisePhrase(o.phrase) === normalisePhrase(endpoint.handler.operation));
    if (!operation) {
      error(context, 'HADL2415', `service ${service.name} has no operation "${endpoint.handler.operation}"`, endpoint.span, {
        hint: withSuggestion('', endpoint.handler.operation, service.operations.map((o) => o.phrase)),
      });
      continue;
    }

    // Path parameters must exist in the request body or in the operation's parameters.
    for (const parameter of pathParameters(endpoint.path)) {
      const inRequest = endpoint.request && requestHasField(context, endpoint.request, parameter);
      const inParameters = operation.parameters.some((p) => p.name === parameter);
      if (!inRequest && !inParameters) {
        error(
          context,
          'HADL2416',
          `path parameter "{${parameter}}" of ${route} is not carried by the request`,
          endpoint.span,
          { hint: `add "${parameter}" to the request type, or rename the path segment` },
        );
      }
    }

    const success = endpoint.responses.find((r) => r.status < 400);
    if (!success) {
      error(context, 'HADL2417', `${route} declares no successful response`, endpoint.span, {
        hint: 'add "responds 200 with <Type>" or "responds 204"',
      });
    }
  }
}

function checkHandlers(context: AnalysisContext): void {
  for (const handler of context.index.handlers) {
    if (handler.trigger === 'schedule') continue;
    const trigger = context.index.get(handler.on);
    if (!trigger) {
      error(context, 'HADL2418', `handler ${handler.name} reacts to "${handler.on}", which is not declared`, handler.span, {
        hint: withSuggestion('', handler.on, [...context.index.events, ...context.index.commands].map((d) => d.name)),
      });
      continue;
    }
    if (trigger.kind !== 'event' && trigger.kind !== 'command') {
      error(
        context,
        'HADL2419',
        `handler ${handler.name} reacts to ${trigger.kind} ${trigger.name}; handlers react to events or commands`,
        handler.span,
      );
    }
    for (const name of handler.uses) {
      const dependency = context.index.get(name);
      if (dependency?.kind !== 'port') {
        error(context, 'HADL2420', `handler ${handler.name} uses "${name}", which is not a port`, handler.span);
      }
    }
  }
}

/** Interface segregation: a port nobody can implement in one sitting is too wide. */
function checkInterfaceSegregation(context: AnalysisContext): void {
  for (const port of context.index.ports) {
    if (port.operations.length <= PORT_OPERATION_LIMIT) continue;
    warn(
      context,
      'HADL2421',
      `port ${port.name} declares ${port.operations.length} operations`,
      port.span,
      `split it: clients that need two operations should not be forced to know about ${port.operations.length}`,
    );
  }
}

/**
 * Single responsibility: if a service's operations use disjoint sets of ports,
 * it is really two services sharing a name.
 */
function checkSingleResponsibility(context: AnalysisContext): void {
  for (const service of context.index.services) {
    if (service.operations.length < 2 || service.uses.length < 2) continue;

    const groups = service.operations.map((operation) => portsUsedBy(context, service.uses, operation.phrase, service.name));
    const clusters = connectedClusters(groups);
    if (clusters.length < 2) continue;
    warn(
      context,
      'HADL2422',
      `service ${service.name} splits into ${clusters.length} groups of operations that share nothing`,
      service.span,
      `consider ${clusters.map((c) => `{${c.join(', ')}}`).join(' and ')} as separate services`,
    );
  }
}

function portsUsedBy(context: AnalysisContext, ports: readonly string[], phrase: string, serviceName: string): { phrase: string; ports: Set<string> } {
  const service = context.index.typed(serviceName, 'service');
  const operation = service?.operations.find((o) => o.phrase === phrase);
  const used = new Set<string>();
  if (!operation) return { phrase, ports: used };

  const byPhrase = new Map<string, string>();
  for (const name of ports) {
    const port = context.index.typed(name, 'port');
    for (const declared of port?.operations ?? []) byPhrase.set(normalisePhrase(declared.phrase), name);
  }
  const visit = (statements: typeof operation.body): void => {
    for (const statement of statements) {
      if (statement.kind === 'when') {
        visit(statement.then);
        visit(statement.otherwise);
      } else if (statement.kind === 'for-each') {
        visit(statement.body);
      }
      const expression = statement.kind === 'let' || statement.kind === 'perform' ? statement.value : null;
      if (expression?.kind === 'call') {
        const port = byPhrase.get(normalisePhrase(expression.operation));
        if (port) used.add(port);
      }
    }
  };
  visit(operation.body);
  return { phrase, ports: used };
}

/** Groups operations that share at least one port, transitively. */
function connectedClusters(groups: Array<{ phrase: string; ports: Set<string> }>): string[][] {
  const relevant = groups.filter((g) => g.ports.size > 0);
  if (relevant.length < 2) return [];

  const clusters: Array<{ phrases: string[]; ports: Set<string> }> = [];
  for (const group of relevant) {
    const overlapping = clusters.filter((c) => [...group.ports].some((p) => c.ports.has(p)));
    if (overlapping.length === 0) {
      clusters.push({ phrases: [group.phrase], ports: new Set(group.ports) });
      continue;
    }
    const merged = overlapping[0]!;
    merged.phrases.push(group.phrase);
    for (const port of group.ports) merged.ports.add(port);
    for (const other of overlapping.slice(1)) {
      merged.phrases.push(...other.phrases);
      for (const port of other.ports) merged.ports.add(port);
      clusters.splice(clusters.indexOf(other), 1);
    }
  }
  return clusters.length > 1 ? clusters.map((c) => c.phrases) : [];
}

function pathParameters(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

function requestHasField(context: AnalysisContext, request: Parameters<typeof typeToString>[0], field: string): boolean {
  if (request.kind !== 'named') return false;
  const declaration = context.index.get(request.name);
  return Boolean(declaration && 'fields' in declaration && declaration.fields.some((f) => f.name === field));
}

function error(context: AnalysisContext, code: string, message: string, span: SourceSpan | undefined, extra: { hint?: string } = {}): void {
  const hint = extra.hint && extra.hint.length > 0 ? { hint: extra.hint } : {};
  context.diagnostics.error('resolve', code, message, span ?? fallback(context), hint);
}

function warn(context: AnalysisContext, code: string, message: string, span: SourceSpan | undefined, hint?: string): void {
  context.diagnostics.warn('resolve', code, message, span ?? fallback(context), hint ? { hint } : {});
}

function fallback(context: AnalysisContext): SourceSpan {
  const file = context.module.source?.file ?? '<unknown>';
  return { file, start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } };
}
