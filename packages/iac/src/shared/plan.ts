/**
 * The deployment plan: the single view of the IR every platform generator reads.
 *
 * Generators never walk `IRProject` by hand. They ask the plan for the bounded
 * contexts that requested their deploy target and get exactly the resources
 * those contexts declared — nothing is invented on the way through.
 */
import {
  indexModule,
  kebabCase,
  screamingSnakeCase,
  unknownSpan,
  type CodegenTarget,
  type DeployTarget,
  type IRBoundedContext,
  type IREndpointDecl,
  type IREventDecl,
  type IRHandlerDecl,
  type IRInfrastructure,
  type IRModule,
  type IRProject,
  type ModuleIndex,
  type SourceSpan,
} from '@haic/core';

export type IRDatabase = IRInfrastructure['databases'][number];
export type IRBroker = IRInfrastructure['brokers'][number];
export type IRCache = IRInfrastructure['caches'][number];
export type IRObjectStore = IRInfrastructure['objectStores'][number];
export type IRScaling = IRInfrastructure['scaling'];
export type IRObservability = IRInfrastructure['observability'];

export type DatabaseEngine = IRDatabase['engine'];
export type BrokerEngine = IRBroker['engine'];
export type CacheEngine = IRCache['engine'];
export type ObjectStoreEngine = IRObjectStore['engine'];

const DEFAULT_PORT = 8080;
const DEFAULT_SCALING: IRScaling = { min: 1, max: 3, targetCpuPercent: 70 };
const DEFAULT_OBSERVABILITY: IRObservability = { metrics: true, tracing: true, logLevel: 'info' };

/** A declared resource plus where it came from, so diagnostics can point at it. */
export interface Declared<T> {
  readonly spec: T;
  readonly module: string;
  readonly context: string;
  readonly span: SourceSpan;
}

export interface EndpointPlan {
  readonly endpoint: IREndpointDecl;
  readonly module: IRModule;
}

export interface HandlerPlan {
  readonly handler: IRHandlerDecl;
  readonly module: IRModule;
  /** Event the handler reacts to, when it is declared in the same module. */
  readonly event: IREventDecl | undefined;
}

/** One deployable unit: a bounded context and everything it asked for. */
export interface ContextPlan {
  readonly context: IRBoundedContext;
  /** Kebab-case name used for images, charts, services and directories. */
  readonly serviceName: string;
  readonly imageName: string;
  readonly language: CodegenTarget;
  readonly port: number;
  readonly modules: readonly IRModule[];
  readonly indexes: readonly ModuleIndex[];
  readonly databases: readonly Declared<IRDatabase>[];
  readonly brokers: readonly Declared<IRBroker>[];
  readonly caches: readonly Declared<IRCache>[];
  readonly objectStores: readonly Declared<IRObjectStore>[];
  readonly secrets: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly scaling: IRScaling;
  readonly observability: IRObservability;
  readonly deploy: readonly DeployTarget[];
  readonly endpoints: readonly EndpointPlan[];
  readonly handlers: readonly HandlerPlan[];
  readonly span: SourceSpan;
}

export class InfrastructurePlan {
  constructor(
    readonly project: IRProject,
    readonly contexts: readonly ContextPlan[],
  ) {}

  /** Kebab-case project name, used as a prefix for every generated resource. */
  get name(): string {
    return kebabCase(this.project.name);
  }

  /** Bounded contexts whose `deploy to` list names this target. */
  targeting(target: DeployTarget): ContextPlan[] {
    return this.contexts.filter((plan) => plan.deploy.includes(target));
  }
}

export function buildPlan(project: IRProject): InfrastructurePlan {
  const declared = new Map(project.contexts.map((context) => [context.name, context]));
  const grouped = new Map<string, IRModule[]>();
  for (const module of project.modules) {
    grouped.set(module.context, [...(grouped.get(module.context) ?? []), module]);
  }

  const contexts = [...grouped.entries()].map(([name, modules]) =>
    planContext(project, declared.get(name) ?? { name, kind: 'supporting', modules: modules.map((m) => m.name) }, modules),
  );
  return new InfrastructurePlan(project, contexts);
}

function planContext(project: IRProject, context: IRBoundedContext, modules: readonly IRModule[]): ContextPlan {
  const withInfrastructure = modules.filter((module) => module.infrastructure !== undefined);
  const primary = withInfrastructure[0];
  const infrastructure = primary?.infrastructure;
  const indexes = modules.map(indexModule);
  const serviceName = kebabCase(context.name);

  const collect = <T>(pick: (declaration: IRInfrastructure) => readonly T[]): Declared<T>[] =>
    withInfrastructure.flatMap((module) =>
      pick(module.infrastructure as IRInfrastructure).map((spec) => ({
        spec,
        module: module.name,
        context: context.name,
        span: spanOf(module),
      })),
    );

  return {
    context,
    serviceName,
    imageName: `${kebabCase(project.name)}/${serviceName}`,
    language: context.target ?? modules.find((module) => module.target)?.target ?? project.defaultTarget,
    port: infrastructure?.port ?? DEFAULT_PORT,
    modules,
    indexes,
    databases: dedupe(collect((i) => i.databases)),
    brokers: dedupe(collect((i) => i.brokers)),
    caches: dedupe(collect((i) => i.caches)),
    objectStores: dedupe(collect((i) => i.objectStores)),
    secrets: unique(withInfrastructure.flatMap((module) => module.infrastructure!.secrets)),
    environment: Object.assign({}, ...withInfrastructure.map((module) => module.infrastructure!.environment)) as Record<
      string,
      string
    >,
    scaling: infrastructure?.scaling ?? DEFAULT_SCALING,
    observability: infrastructure?.observability ?? DEFAULT_OBSERVABILITY,
    deploy: unique(withInfrastructure.flatMap((module) => module.infrastructure!.deploy)),
    endpoints: indexes.flatMap((index) => index.endpoints.map((endpoint) => ({ endpoint, module: index.module }))),
    handlers: indexes.flatMap((index) =>
      index.handlers.map((handler) => ({ handler, module: index.module, event: index.typed(handler.on, 'event') })),
    ),
    span: spanOf(primary ?? modules[0]),
  };
}

/** Environment variables the service needs before any platform-specific wiring. */
export function baseEnvironment(plan: ContextPlan): Record<string, string> {
  return { PORT: String(plan.port), LOG_LEVEL: plan.observability.logLevel, ...plan.environment };
}

/** `ordersdb` -> `ORDERSDB_URL`. Same convention the code generators use in `.env`. */
export function connectionVariable(name: string): string {
  return `${screamingSnakeCase(name)}_URL`;
}

/** Name of the variable holding a resource credential. Values never live in the source. */
export function credentialVariable(name: string, kind: string): string {
  return `${screamingSnakeCase(name)}_${kind}`;
}

/** `${ORDERSDB_PASSWORD}`: a reference the deployment substitutes, never a value. */
export function credentialReference(name: string, kind: string): string {
  return `\${${credentialVariable(name, kind)}}`;
}

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Two modules in one context may declare the same resource; it is still one resource. */
export function dedupe<T extends { name: string }>(items: readonly Declared<T>[]): Declared<T>[] {
  const seen = new Map<string, Declared<T>>();
  for (const item of items) if (!seen.has(item.spec.name)) seen.set(item.spec.name, item);
  return [...seen.values()];
}

function spanOf(module: IRModule | undefined): SourceSpan {
  return unknownSpan(module?.source?.file ?? '<project>');
}
