/**
 * Checked and unchecked error flow.
 *
 * A checked error is part of an operation's contract: it must be declared by
 * every operation that can raise it, and handled by every endpoint that exposes
 * it. An unchecked error is a bug — it must never appear in a contract, because
 * declaring it invites callers to "handle" something they cannot fix.
 */
import type { SourceSpan } from '@ai-lang/core';
import type { AnalysisContext, SemanticPass } from '../context.js';

export const errorFlowPass: SemanticPass = {
  id: 'error-flow',
  stage: 'error-flow',
  run(context) {
    checkUncheckedNotDeclared(context);
    checkRaisedErrorsAreDeclared(context);
    checkDeclaredErrorsAreReachable(context);
    checkEndpointsHandleCheckedErrors(context);
    checkCheckedErrorsHaveStatus(context);
    checkUnusedErrors(context);
  },
};

/** `-> T or SomeUncheckedError` is always a mistake. */
function checkUncheckedNotDeclared(context: AnalysisContext): void {
  for (const { owner, phrase, throws, span } of signatures(context)) {
    for (const name of throws) {
      const declaration = context.index.get(name);
      if (declaration?.kind !== 'error') {
        error(context, 'AIL2301', `${owner}.${phrase} declares "${name}", which is not a declared error`, span);
        continue;
      }
      if (!declaration.checked) {
        error(
          context,
          'AIL2302',
          `${owner}.${phrase} declares the unchecked error ${name}`,
          span,
          'unchecked errors signal bugs and propagate on their own; either drop it from the contract or mark it "(checked)"',
        );
      }
    }
  }
}

/** Every checked error a body can raise must appear in its contract. */
function checkRaisedErrorsAreDeclared(context: AnalysisContext): void {
  for (const { owner, phrase, throws, span } of signatures(context)) {
    const raised = context.raisedErrors.get(`${owner}.${phrase}`) ?? new Set<string>();
    for (const name of raised) {
      const declaration = context.index.get(name);
      if (declaration?.kind !== 'error' || !declaration.checked) continue;
      if (throws.includes(name)) continue;
      error(
        context,
        'AIL2303',
        `${owner}.${phrase} can raise ${name} but does not declare it`,
        span,
        `add it to the return type: "-> ... or ${[...throws, name].join(', ')}"`,
      );
    }
  }
}

/** A contract that promises errors it can never raise misleads every caller. */
function checkDeclaredErrorsAreReachable(context: AnalysisContext): void {
  for (const { owner, phrase, throws, span, hasBody } of signatures(context)) {
    if (!hasBody) continue;
    const raised = context.raisedErrors.get(`${owner}.${phrase}`) ?? new Set<string>();
    for (const name of throws) {
      if (raised.has(name)) continue;
      warn(
        context,
        'AIL2304',
        `${owner}.${phrase} declares ${name} but never raises it`,
        span,
        'remove it from the contract; callers are writing handling code that can never run',
      );
    }
  }
}

/** Endpoints translate the whole contract, so no checked error escapes untyped. */
function checkEndpointsHandleCheckedErrors(context: AnalysisContext): void {
  for (const endpoint of context.index.endpoints) {
    const service = context.index.typed(endpoint.handler.service, 'service');
    if (!service) continue;
    const operation = service.operations.find((o) => o.phrase.toLowerCase() === endpoint.handler.operation.toLowerCase());
    if (!operation) continue;

    const mapped = new Set(endpoint.responses.filter((r) => r.when).map((r) => r.when!));
    for (const name of operation.throws) {
      if (mapped.has(name)) continue;
      const declaration = context.index.typed(name, 'error');
      const status = declaration?.status ?? 400;
      error(
        context,
        'AIL2305',
        `${endpoint.method} ${endpoint.path} does not say what happens when ${name} is raised`,
        endpoint.span,
        `add "responds ${status} when ${name}"`,
      );
    }
    for (const response of endpoint.responses) {
      if (!response.when) continue;
      if (operation.throws.includes(response.when)) continue;
      warn(
        context,
        'AIL2306',
        `${endpoint.method} ${endpoint.path} maps ${response.when}, which ${service.name}.${operation.phrase} never raises`,
        endpoint.span,
      );
    }
  }
}

/** Checked errors reachable from HTTP need a status, or the mapping is guesswork. */
function checkCheckedErrorsHaveStatus(context: AnalysisContext): void {
  const exposed = new Set<string>();
  for (const endpoint of context.index.endpoints) {
    const service = context.index.typed(endpoint.handler.service, 'service');
    const operation = service?.operations.find((o) => o.phrase.toLowerCase() === endpoint.handler.operation.toLowerCase());
    for (const name of operation?.throws ?? []) exposed.add(name);
  }
  for (const name of exposed) {
    const declaration = context.index.typed(name, 'error');
    if (!declaration || declaration.status !== undefined) continue;
    warn(
      context,
      'AIL2307',
      `checked error ${name} reaches an endpoint but has no status`,
      declaration.span,
      `write "## error ${name} (checked, status 409)"`,
    );
  }
}

function checkUnusedErrors(context: AnalysisContext): void {
  const used = new Set<string>();
  for (const set of context.raisedErrors.values()) for (const name of set) used.add(name);
  for (const { throws } of signatures(context)) for (const name of throws) used.add(name);

  for (const declaration of context.index.errors) {
    if (used.has(declaration.name)) continue;
    warn(
      context,
      'AIL2308',
      `error ${declaration.name} is declared but never raised`,
      declaration.span,
      'delete it; an error nobody raises is code nobody can test',
    );
  }
}

interface SignatureInfo {
  owner: string;
  phrase: string;
  throws: string[];
  span: SourceSpan | undefined;
  hasBody: boolean;
}

function* signatures(context: AnalysisContext): Generator<SignatureInfo> {
  for (const declaration of context.module.declarations) {
    if (declaration.kind === 'port') {
      for (const operation of declaration.operations) {
        yield { owner: declaration.name, phrase: operation.phrase, throws: operation.throws, span: operation.span, hasBody: false };
      }
    }
    if (declaration.kind === 'service' || declaration.kind === 'aggregate' || declaration.kind === 'adapter') {
      for (const operation of declaration.operations) {
        yield {
          owner: declaration.name,
          phrase: operation.phrase,
          throws: operation.throws,
          span: operation.span,
          hasBody: operation.body.length > 0,
        };
      }
    }
  }
}

function error(context: AnalysisContext, code: string, message: string, span: SourceSpan | undefined, hint?: string): void {
  context.diagnostics.error('error-flow', code, message, span ?? fallback(context), hint ? { hint } : {});
}

function warn(context: AnalysisContext, code: string, message: string, span: SourceSpan | undefined, hint?: string): void {
  context.diagnostics.warn('error-flow', code, message, span ?? fallback(context), hint ? { hint } : {});
}

function fallback(context: AnalysisContext): SourceSpan {
  const file = context.module.source?.file ?? '<unknown>';
  return { file, start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } };
}
