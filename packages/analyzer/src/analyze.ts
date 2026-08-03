/** The analysis pipeline: raw modules in, validated IR project out. */
import {
  DiagnosticBag,
  IR_VERSION,
  ModuleSchema,
  ProjectSchema,
  indexModule,
  type CodegenTarget,
  type Diagnostic,
  type IRBoundedContext,
  type IRModule,
  type IRProject,
  type ModuleIndex,
} from '@haic/core';
import type { AnalysisContext, SemanticPass } from './context.js';
import { architecturePass } from './passes/architecture.js';
import { dddPass } from './passes/ddd.js';
import { errorFlowPass } from './passes/error-flow.js';
import { simplicityPass } from './passes/simplicity.js';
import { symbolPass } from './passes/symbols.js';
import { typePass } from './passes/types.js';

/**
 * Order matters: later passes assume earlier ones have reported their problems,
 * so an unresolved name is never re-reported as a type error.
 */
export const defaultPasses: readonly SemanticPass[] = [
  symbolPass,
  architecturePass,
  typePass,
  errorFlowPass,
  dddPass,
  simplicityPass,
];

export interface AnalyzeOptions {
  projectName?: string;
  defaultTarget?: CodegenTarget;
  passes?: readonly SemanticPass[];
  /** Promotes warnings to errors. Used by `haic check --strict`. */
  strict?: boolean;
}

export interface AnalysisResult {
  project: IRProject;
  diagnostics: Diagnostic[];
  ok: boolean;
}

export function analyze(modules: readonly IRModule[], options: AnalyzeOptions = {}): AnalysisResult {
  const diagnostics = new DiagnosticBag();
  const project: IRProject = {
    irVersion: IR_VERSION,
    name: options.projectName ?? 'hadl-project',
    contexts: buildContexts(modules, options.defaultTarget),
    contextMap: buildContextMap(modules),
    modules: [...modules],
    defaultTarget: options.defaultTarget ?? 'typescript',
  };

  const indexes = new Map<string, ModuleIndex>();
  for (const module of modules) indexes.set(module.name, indexModule(module));

  reportDuplicateModules(modules, diagnostics);

  const passes = options.passes ?? defaultPasses;
  for (const module of modules) {
    const index = indexes.get(module.name)!;
    const siblings = new Map(indexes);
    siblings.delete(module.name);

    const context: AnalysisContext = {
      project,
      module,
      index,
      diagnostics,
      siblings,
      raisedErrors: new Map(),
    };
    for (const pass of passes) pass.run(context);
  }

  validateAgainstSchema(project, diagnostics);

  const items = options.strict ? diagnostics.items.map(promote) : diagnostics.items;
  return { project, diagnostics: items, ok: !items.some((d) => d.severity === 'error') };
}

function promote(diagnostic: Diagnostic): Diagnostic {
  return diagnostic.severity === 'warning' ? { ...diagnostic, severity: 'error' } : diagnostic;
}

function reportDuplicateModules(modules: readonly IRModule[], diagnostics: DiagnosticBag): void {
  const seen = new Map<string, IRModule>();
  for (const module of modules) {
    const previous = seen.get(module.name);
    if (previous) {
      diagnostics.error(
        'resolve',
        'HADL2010',
        `two files declare the module "${module.name}"`,
        spanOf(module),
        {
          hint: 'module names are unique across a project; rename one or merge the files',
          related: [{ message: `also declared in ${previous.source?.file ?? 'another file'}`, span: spanOf(previous) }],
        },
      );
    }
    seen.set(module.name, module);
  }
}

/** One bounded context per distinct `context:` value, classified by its content. */
function buildContexts(modules: readonly IRModule[], defaultTarget: CodegenTarget | undefined): IRBoundedContext[] {
  const byContext = new Map<string, IRModule[]>();
  for (const module of modules) {
    byContext.set(module.context, [...(byContext.get(module.context) ?? []), module]);
  }

  return [...byContext.entries()].map(([name, contextModules]) => {
    const index = contextModules.map(indexModule);
    const hasDomainRules = index.some((i) => i.aggregates.some((a) => a.invariants.length > 0 || a.operations.length > 0));
    const onlyCrud = index.every((i) => i.aggregates.every((a) => a.invariants.length === 0 && a.operations.length === 0));

    const context: IRBoundedContext = {
      name,
      kind: hasDomainRules ? 'core' : onlyCrud ? 'generic' : 'supporting',
      modules: contextModules.map((m) => m.name),
    };
    const target = contextModules.find((m) => m.target)?.target ?? defaultTarget;
    if (target) context.target = target;
    return context;
  });
}

/** Import declarations are the context map: each import is a downstream edge. */
function buildContextMap(modules: readonly IRModule[]): IRProject['contextMap'] {
  const contextOf = new Map(modules.map((m) => [m.name, m.context]));
  const edges: IRProject['contextMap'] = [];
  const seen = new Set<string>();

  for (const module of modules) {
    for (const entry of module.imports) {
      const upstream = contextOf.get(entry.module);
      if (!upstream || upstream === module.context) continue;
      const key = `${upstream}->${module.context}:${entry.via}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        upstream,
        downstream: module.context,
        relationship:
          entry.via === 'shared-kernel'
            ? 'shared-kernel'
            : entry.via === 'conformist'
              ? 'conformist'
              : entry.via === 'open-host'
                ? 'open-host-service'
                : 'anti-corruption-layer',
      });
    }
  }
  return edges;
}

/** The IR is a published artifact; a shape violation here is a compiler bug. */
function validateAgainstSchema(project: IRProject, diagnostics: DiagnosticBag): void {
  for (const module of project.modules) {
    const result = ModuleSchema.safeParse(module);
    if (result.success) continue;
    for (const issue of result.error.issues) {
      diagnostics.error('ir', 'HADL2900', `invalid IR at ${issue.path.join('.')}: ${issue.message}`, spanOf(module), {
        hint: 'this is a compiler bug; please report the source that produced it',
      });
    }
  }
  const result = ProjectSchema.safeParse(project);
  if (!result.success) {
    for (const issue of result.error.issues) {
      diagnostics.error(
        'ir',
        'HADL2901',
        `invalid project IR at ${issue.path.join('.')}: ${issue.message}`,
        { file: '<project>', start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } },
      );
    }
  }
}

function spanOf(module: IRModule): Diagnostic['span'] {
  const file = module.source?.file ?? '<unknown>';
  return { file, start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } };
}
