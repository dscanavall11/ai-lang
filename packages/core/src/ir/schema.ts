/**
 * AI-Lang typed IR.
 *
 * The IR is the single source of truth consumed by every code generator and
 * every infrastructure generator. It is JSON-serializable on purpose: it can be
 * diffed in review, committed, and read by external tooling.
 *
 * Zod schemas are the source of truth; TypeScript types are derived from them.
 */
import { z } from 'zod';

/** Bumped whenever the IR shape changes in a non-additive way. */
export const IR_VERSION = '0.1';

const identifier = z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'must be a valid identifier');
const phrase = z.string().min(1);

export const SourcePositionSchema = z.object({
  line: z.number().int().min(1),
  column: z.number().int().min(1),
  offset: z.number().int().min(0),
});

export const SourceSpanSchema = z.object({
  file: z.string(),
  start: SourcePositionSchema,
  end: SourcePositionSchema,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const PRIMITIVE_TYPES = [
  'text',
  'integer',
  'decimal',
  'boolean',
  'uuid',
  'timestamp',
  'date',
  'duration',
  'json',
  'bytes',
  'nothing',
] as const;

export const PrimitiveTypeSchema = z.enum(PRIMITIVE_TYPES);
export type PrimitiveType = z.infer<typeof PrimitiveTypeSchema>;

export type IRType =
  | { kind: 'primitive'; name: PrimitiveType }
  | { kind: 'named'; name: string }
  | { kind: 'list'; of: IRType }
  | { kind: 'set'; of: IRType }
  | { kind: 'map'; key: IRType; value: IRType }
  | { kind: 'optional'; of: IRType }
  | { kind: 'result'; ok: IRType; errors: string[] };

export const IRTypeSchema: z.ZodType<IRType> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('primitive'), name: PrimitiveTypeSchema }),
    z.object({ kind: z.literal('named'), name: identifier }),
    z.object({ kind: z.literal('list'), of: IRTypeSchema }),
    z.object({ kind: z.literal('set'), of: IRTypeSchema }),
    z.object({ kind: z.literal('map'), key: IRTypeSchema, value: IRTypeSchema }),
    z.object({ kind: z.literal('optional'), of: IRTypeSchema }),
    z.object({ kind: z.literal('result'), ok: IRTypeSchema, errors: z.array(identifier) }),
  ]),
);

// ---------------------------------------------------------------------------
// Fields and constraints
// ---------------------------------------------------------------------------

export const ConstraintSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('min'), value: z.number() }),
  z.object({ kind: z.literal('max'), value: z.number() }),
  z.object({ kind: z.literal('min-length'), value: z.number().int().min(0) }),
  z.object({ kind: z.literal('max-length'), value: z.number().int().min(0) }),
  z.object({ kind: z.literal('length'), value: z.number().int().min(0) }),
  z.object({ kind: z.literal('pattern'), value: z.string() }),
  z.object({ kind: z.literal('one-of'), values: z.array(z.union([z.string(), z.number()])) }),
  z.object({ kind: z.literal('unique') }),
  z.object({ kind: z.literal('immutable') }),
  z.object({ kind: z.literal('default'), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
]);
export type IRConstraint = z.infer<typeof ConstraintSchema>;

export const FieldSchema = z.object({
  name: identifier,
  type: IRTypeSchema,
  required: z.boolean().default(true),
  /** Part of the identity of an entity or aggregate root. */
  identity: z.boolean().default(false),
  /** Computed from other fields; generators must not persist it as-is. */
  derived: z.boolean().default(false),
  description: z.string().optional(),
  constraints: z.array(ConstraintSchema).default([]),
  span: SourceSpanSchema.optional(),
});
export type IRField = z.infer<typeof FieldSchema>;

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export const BINARY_OPERATORS = [
  'equals',
  'not-equals',
  'greater-than',
  'greater-or-equal',
  'less-than',
  'less-or-equal',
  'add',
  'subtract',
  'multiply',
  'divide',
  'and',
  'or',
  'contains',
  'starts-with',
  'ends-with',
  'matches',
] as const;
export const BinaryOperatorSchema = z.enum(BINARY_OPERATORS);
export type BinaryOperator = z.infer<typeof BinaryOperatorSchema>;

export const UNARY_OPERATORS = ['not', 'negate', 'is-empty', 'is-not-empty', 'is-present', 'is-absent'] as const;
export const UnaryOperatorSchema = z.enum(UNARY_OPERATORS);
export type UnaryOperator = z.infer<typeof UnaryOperatorSchema>;

export const AGGREGATE_FUNCTIONS = ['sum', 'count', 'min', 'max', 'average'] as const;
export const AggregateFunctionSchema = z.enum(AGGREGATE_FUNCTIONS);
export type AggregateFunction = z.infer<typeof AggregateFunctionSchema>;

export interface IRArgument {
  name: string;
  value: IRExpression;
}

export type IRExpression =
  | { kind: 'literal'; value: string | number | boolean | null; type: IRType; span?: IRSpan }
  | { kind: 'reference'; path: string[]; span?: IRSpan }
  | { kind: 'binary'; operator: BinaryOperator; left: IRExpression; right: IRExpression; span?: IRSpan }
  | { kind: 'unary'; operator: (typeof UNARY_OPERATORS)[number]; operand: IRExpression; span?: IRSpan }
  | { kind: 'call'; receiver: string | null; operation: string; arguments: IRArgument[]; span?: IRSpan }
  /**
   * `source` is the `from <path>` clause. The analyzer resolves it into explicit
   * arguments, so every backend only ever sees a fully spelled-out construction.
   */
  | { kind: 'construct'; type: string; source: string[] | null; arguments: IRArgument[]; span?: IRSpan }
  | { kind: 'aggregate'; fn: AggregateFunction; collection: IRExpression; of: IRExpression | null; span?: IRSpan }
  | { kind: 'now'; span?: IRSpan }
  | { kind: 'new-id'; span?: IRSpan };

export type IRSpan = z.infer<typeof SourceSpanSchema>;

export const ArgumentSchema: z.ZodType<IRArgument> = z.lazy(() =>
  z.object({ name: z.string().min(1), value: IRExpressionSchema }),
);

export const IRExpressionSchema: z.ZodType<IRExpression> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('literal'),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      type: IRTypeSchema,
      span: SourceSpanSchema.optional(),
    }),
    z.object({ kind: z.literal('reference'), path: z.array(z.string().min(1)).min(1), span: SourceSpanSchema.optional() }),
    z.object({
      kind: z.literal('binary'),
      operator: BinaryOperatorSchema,
      left: IRExpressionSchema,
      right: IRExpressionSchema,
      span: SourceSpanSchema.optional(),
    }),
    z.object({
      kind: z.literal('unary'),
      operator: UnaryOperatorSchema,
      operand: IRExpressionSchema,
      span: SourceSpanSchema.optional(),
    }),
    z.object({
      kind: z.literal('call'),
      receiver: z.string().nullable(),
      operation: phrase,
      arguments: z.array(ArgumentSchema),
      span: SourceSpanSchema.optional(),
    }),
    z.object({
      kind: z.literal('construct'),
      type: identifier,
      source: z.array(z.string().min(1)).nullable(),
      arguments: z.array(ArgumentSchema),
      span: SourceSpanSchema.optional(),
    }),
    z.object({
      kind: z.literal('aggregate'),
      fn: AggregateFunctionSchema,
      collection: IRExpressionSchema,
      of: z.union([IRExpressionSchema, z.null()]),
      span: SourceSpanSchema.optional(),
    }),
    z.object({ kind: z.literal('now'), span: SourceSpanSchema.optional() }),
    z.object({ kind: z.literal('new-id'), span: SourceSpanSchema.optional() }),
  ]),
);

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export type IRStatement =
  | { kind: 'let'; name: string; value: IRExpression; span?: IRSpan }
  | { kind: 'set'; target: string[]; value: IRExpression; span?: IRSpan }
  | { kind: 'perform'; value: IRExpression; span?: IRSpan }
  | { kind: 'when'; condition: IRExpression; then: IRStatement[]; otherwise: IRStatement[]; span?: IRSpan }
  | { kind: 'for-each'; item: string; collection: IRExpression; body: IRStatement[]; span?: IRSpan }
  | { kind: 'fail'; error: string; arguments: IRArgument[]; span?: IRSpan }
  | { kind: 'publish'; event: string; arguments: IRArgument[]; span?: IRSpan }
  | { kind: 'append'; collection: string[]; value: IRExpression; span?: IRSpan }
  | { kind: 'remove'; collection: string[]; value: IRExpression; span?: IRSpan }
  | { kind: 'return'; value: IRExpression | null; span?: IRSpan };

export const IRStatementSchema: z.ZodType<IRStatement> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('let'), name: identifier, value: IRExpressionSchema, span: SourceSpanSchema.optional() }),
    z.object({
      kind: z.literal('set'),
      target: z.array(z.string().min(1)).min(1),
      value: IRExpressionSchema,
      span: SourceSpanSchema.optional(),
    }),
    z.object({ kind: z.literal('perform'), value: IRExpressionSchema, span: SourceSpanSchema.optional() }),
    z.object({
      kind: z.literal('when'),
      condition: IRExpressionSchema,
      then: z.array(IRStatementSchema),
      otherwise: z.array(IRStatementSchema),
      span: SourceSpanSchema.optional(),
    }),
    z.object({
      kind: z.literal('for-each'),
      item: identifier,
      collection: IRExpressionSchema,
      body: z.array(IRStatementSchema),
      span: SourceSpanSchema.optional(),
    }),
    z.object({
      kind: z.literal('fail'),
      error: identifier,
      arguments: z.array(ArgumentSchema),
      span: SourceSpanSchema.optional(),
    }),
    z.object({
      kind: z.literal('publish'),
      event: identifier,
      arguments: z.array(ArgumentSchema),
      span: SourceSpanSchema.optional(),
    }),
    z.object({
      kind: z.literal('append'),
      collection: z.array(z.string().min(1)).min(1),
      value: IRExpressionSchema,
      span: SourceSpanSchema.optional(),
    }),
    z.object({
      kind: z.literal('remove'),
      collection: z.array(z.string().min(1)).min(1),
      value: IRExpressionSchema,
      span: SourceSpanSchema.optional(),
    }),
    z.object({
      kind: z.literal('return'),
      value: z.union([IRExpressionSchema, z.null()]),
      span: SourceSpanSchema.optional(),
    }),
  ]),
);

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

export const InvariantSchema = z.object({
  description: z.string().min(1),
  condition: IRExpressionSchema,
  /** Error raised when the invariant is violated. Defaults to a generated one. */
  raises: identifier.optional(),
  span: SourceSpanSchema.optional(),
});
export type IRInvariant = z.infer<typeof InvariantSchema>;

export const ParameterSchema = z.object({
  name: identifier,
  type: IRTypeSchema,
  required: z.boolean().default(true),
  description: z.string().optional(),
});
export type IRParameter = z.infer<typeof ParameterSchema>;

export const OperationSignatureSchema = z.object({
  name: identifier,
  /** Natural-language phrase used to call this operation, e.g. "find order by id". */
  phrase: phrase,
  description: z.string().optional(),
  parameters: z.array(ParameterSchema).default([]),
  returns: IRTypeSchema,
  /** Checked errors this operation may raise. Callers must handle them. */
  throws: z.array(identifier).default([]),
  /** Operation has side effects outside the aggregate (I/O, messaging). */
  effectful: z.boolean().default(false),
  span: SourceSpanSchema.optional(),
});
export type IROperationSignature = z.infer<typeof OperationSignatureSchema>;

export const OperationSchema = OperationSignatureSchema.extend({
  body: z.array(IRStatementSchema).default([]),
});
export type IROperation = z.infer<typeof OperationSchema>;

const declarationBase = {
  name: identifier,
  description: z.string().optional(),
  span: SourceSpanSchema.optional(),
};

export const EnumDeclSchema = z.object({
  kind: z.literal('enum'),
  ...declarationBase,
  values: z.array(z.object({ name: identifier, description: z.string().optional() })).min(1),
});

export const ValueObjectDeclSchema = z.object({
  kind: z.literal('value-object'),
  ...declarationBase,
  fields: z.array(FieldSchema).min(1),
  invariants: z.array(InvariantSchema).default([]),
});

export const EntityDeclSchema = z.object({
  kind: z.literal('entity'),
  ...declarationBase,
  /** Field names that form the identity. Exactly one for v1. */
  identity: z.array(identifier).min(1),
  fields: z.array(FieldSchema).min(1),
  invariants: z.array(InvariantSchema).default([]),
  /** Aggregate this entity belongs to; null means it is standalone (discouraged). */
  aggregate: identifier.nullable().default(null),
});

export const AggregateDeclSchema = z.object({
  kind: z.literal('aggregate'),
  ...declarationBase,
  identity: z.array(identifier).min(1),
  fields: z.array(FieldSchema).min(1),
  invariants: z.array(InvariantSchema).default([]),
  /** Entities contained in this aggregate; only the root is referenceable outside. */
  entities: z.array(identifier).default([]),
  operations: z.array(OperationSchema).default([]),
  /** Events this aggregate can emit. */
  emits: z.array(identifier).default([]),
});

export const DtoDeclSchema = z.object({
  kind: z.literal('dto'),
  ...declarationBase,
  fields: z.array(FieldSchema).default([]),
  /** Aggregate/entity this DTO projects, when it is a projection. */
  projects: identifier.nullable().default(null),
});

export const CommandDeclSchema = z.object({
  kind: z.literal('command'),
  ...declarationBase,
  fields: z.array(FieldSchema).default([]),
  /** Aggregate the command targets. */
  target: identifier.nullable().default(null),
});

export const EventDeclSchema = z.object({
  kind: z.literal('event'),
  ...declarationBase,
  fields: z.array(FieldSchema).default([]),
  /** Aggregate that emits the event. */
  source: identifier.nullable().default(null),
  /** Broker topic / channel. Defaults to the event name in kebab-case. */
  topic: z.string().optional(),
});

export const ErrorDeclSchema = z.object({
  kind: z.literal('error'),
  ...declarationBase,
  /**
   * `true`  -> checked: part of the operation contract, callers must handle it.
   * `false` -> unchecked: a bug or unrecoverable condition, propagates as panic.
   */
  checked: z.boolean(),
  message: z.string().min(1),
  fields: z.array(FieldSchema).default([]),
  /** HTTP status used when this error escapes through an endpoint. */
  status: z.number().int().min(100).max(599).optional(),
});

export const SortDirectionSchema = z.enum(['ascending', 'descending']);

/**
 * A named filter over one aggregate — the Specification pattern, so a repository
 * grows a criterion instead of a method. Deliberately narrow: filter, sort and
 * limit over a single aggregate. No joins and no projections; anything wider is
 * a read model, not a query.
 */
export const QueryDeclSchema = z.object({
  kind: z.literal('query'),
  ...declarationBase,
  /** Aggregate this query selects from. */
  over: identifier,
  /** What the caller supplies. An absent optional drops its criteria. */
  fields: z.array(FieldSchema).default([]),
  criteria: z
    .array(
      z.object({
        condition: IRExpressionSchema,
        /** Parameters this criterion reads; it is skipped when any is absent. */
        guards: z.array(identifier).default([]),
        span: SourceSpanSchema.optional(),
      }),
    )
    .default([]),
  sort: z.array(z.object({ path: z.array(z.string().min(1)).min(1), direction: SortDirectionSchema })).default([]),
  limit: z.number().int().min(1).optional(),
});

export const PortDeclSchema = z.object({
  kind: z.literal('port'),
  ...declarationBase,
  /**
   * `inbound`  -> driven by the outside world (use cases exposed to adapters).
   * `outbound` -> the domain drives the outside world (repositories, gateways).
   */
  direction: z.enum(['inbound', 'outbound']),
  operations: z.array(OperationSignatureSchema).min(1),
});

export const ADAPTER_TECHNOLOGIES = [
  'rest',
  'graphql',
  'grpc',
  'sql',
  'nosql',
  'kafka',
  'rabbitmq',
  'sqs',
  'http-client',
  'in-memory',
  's3',
  'redis',
  'cron',
] as const;

export const AdapterDeclSchema = z.object({
  kind: z.literal('adapter'),
  ...declarationBase,
  implements: identifier,
  technology: z.enum(ADAPTER_TECHNOLOGIES),
  /** Free-form technology configuration passed through to the IaC layer. */
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  operations: z.array(OperationSchema).default([]),
});

export const ServiceDeclSchema = z.object({
  kind: z.literal('service'),
  ...declarationBase,
  /** Port names this service depends on. Injected by the generated composition root. */
  uses: z.array(identifier).default([]),
  operations: z.array(OperationSchema).min(1),
  /** Inbound port implemented by this service, if any. */
  implements: identifier.nullable().default(null),
});

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export const EndpointResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  /** Present when this response maps a checked error. */
  when: identifier.optional(),
  body: IRTypeSchema.optional(),
  description: z.string().optional(),
});

export const EndpointDeclSchema = z.object({
  kind: z.literal('endpoint'),
  ...declarationBase,
  method: z.enum(HTTP_METHODS),
  path: z.string().min(1),
  /** Service + operation phrase this endpoint delegates to. */
  handler: z.object({ service: identifier, operation: phrase }),
  request: IRTypeSchema.optional(),
  responses: z.array(EndpointResponseSchema).min(1),
  auth: z.enum(['none', 'bearer', 'api-key', 'basic']).default('none'),
  idempotent: z.boolean().default(false),
});

export const HandlerDeclSchema = z.object({
  kind: z.literal('handler'),
  ...declarationBase,
  /** Event or command this handler reacts to. */
  on: identifier,
  trigger: z.enum(['event', 'command', 'schedule']),
  /** Cron expression when `trigger` is `schedule`. */
  schedule: z.string().optional(),
  uses: z.array(identifier).default([]),
  body: z.array(IRStatementSchema).default([]),
  /** Delivery guarantee requested from the broker. */
  delivery: z.enum(['at-least-once', 'at-most-once', 'exactly-once']).default('at-least-once'),
  retries: z.number().int().min(0).default(3),
});

export const DeclarationSchema = z.discriminatedUnion('kind', [
  EnumDeclSchema,
  ValueObjectDeclSchema,
  EntityDeclSchema,
  AggregateDeclSchema,
  DtoDeclSchema,
  CommandDeclSchema,
  EventDeclSchema,
  ErrorDeclSchema,
  QueryDeclSchema,
  PortDeclSchema,
  AdapterDeclSchema,
  ServiceDeclSchema,
  EndpointDeclSchema,
  HandlerDeclSchema,
]);
export type IRDeclaration = z.infer<typeof DeclarationSchema>;
export type IRDeclarationKind = IRDeclaration['kind'];

export type IREnumDecl = z.infer<typeof EnumDeclSchema>;
export type IRValueObjectDecl = z.infer<typeof ValueObjectDeclSchema>;
export type IREntityDecl = z.infer<typeof EntityDeclSchema>;
export type IRAggregateDecl = z.infer<typeof AggregateDeclSchema>;
export type IRDtoDecl = z.infer<typeof DtoDeclSchema>;
export type IRCommandDecl = z.infer<typeof CommandDeclSchema>;
export type IREventDecl = z.infer<typeof EventDeclSchema>;
export type IRErrorDecl = z.infer<typeof ErrorDeclSchema>;
export type IRQueryDecl = z.infer<typeof QueryDeclSchema>;
export type IRPortDecl = z.infer<typeof PortDeclSchema>;
export type IRAdapterDecl = z.infer<typeof AdapterDeclSchema>;
export type IRServiceDecl = z.infer<typeof ServiceDeclSchema>;
export type IREndpointDecl = z.infer<typeof EndpointDeclSchema>;
export type IRHandlerDecl = z.infer<typeof HandlerDeclSchema>;

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

export const DatabaseSchema = z.object({
  name: identifier,
  engine: z.enum(['postgres', 'mysql', 'mongodb', 'dynamodb', 'sqlite', 'redis']),
  version: z.string().optional(),
  storageGb: z.number().int().min(1).default(20),
  multiAz: z.boolean().default(false),
});

export const BrokerSchema = z.object({
  name: identifier,
  engine: z.enum(['kafka', 'rabbitmq', 'sqs', 'sns', 'eventbridge', 'nats']),
  topics: z.array(z.string()).default([]),
});

export const CacheSchema = z.object({
  name: identifier,
  engine: z.enum(['redis', 'memcached', 'in-memory']),
});

export const ObjectStoreSchema = z.object({
  name: identifier,
  engine: z.enum(['s3', 'gcs', 'azure-blob', 'minio']),
  public: z.boolean().default(false),
});

export const ScalingSchema = z.object({
  min: z.number().int().min(0).default(1),
  max: z.number().int().min(1).default(3),
  targetCpuPercent: z.number().int().min(1).max(100).default(70),
});

export const DEPLOY_TARGETS = ['docker', 'kubernetes', 'terraform', 'aws-lambda', 'aws-amplify'] as const;
export const DeployTargetSchema = z.enum(DEPLOY_TARGETS);
export type DeployTarget = z.infer<typeof DeployTargetSchema>;

export const InfrastructureSchema = z.object({
  /** Network port the generated service listens on. */
  port: z.number().int().min(1).max(65535).default(8080),
  databases: z.array(DatabaseSchema).default([]),
  brokers: z.array(BrokerSchema).default([]),
  caches: z.array(CacheSchema).default([]),
  objectStores: z.array(ObjectStoreSchema).default([]),
  /** Names only. Values never live in the source. */
  secrets: z.array(z.string()).default([]),
  environment: z.record(z.string(), z.string()).default({}),
  scaling: ScalingSchema.default({ min: 1, max: 3, targetCpuPercent: 70 }),
  deploy: z.array(DeployTargetSchema).default([]),
  observability: z
    .object({
      metrics: z.boolean().default(true),
      tracing: z.boolean().default(true),
      logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    })
    .default({ metrics: true, tracing: true, logLevel: 'info' }),
});
export type IRInfrastructure = z.infer<typeof InfrastructureSchema>;

// ---------------------------------------------------------------------------
// Module and project
// ---------------------------------------------------------------------------

export const CODEGEN_TARGETS = ['java', 'typescript', 'python', 'go', 'rust'] as const;
export const CodegenTargetSchema = z.enum(CODEGEN_TARGETS);
export type CodegenTarget = z.infer<typeof CodegenTargetSchema>;

export const ModuleSchema = z.object({
  irVersion: z.literal(IR_VERSION),
  name: identifier,
  /** Bounded context this module belongs to. */
  context: identifier,
  description: z.string().optional(),
  /** Ubiquitous-language glossary entries lifted from the prose. */
  glossary: z.array(z.object({ term: z.string(), definition: z.string() })).default([]),
  imports: z
    .array(z.object({ module: identifier, names: z.array(identifier).default([]), via: z.enum(['shared-kernel', 'anti-corruption-layer', 'conformist', 'open-host']).default('anti-corruption-layer') }))
    .default([]),
  declarations: z.array(DeclarationSchema).default([]),
  infrastructure: InfrastructureSchema.optional(),
  /** Preferred code generation target for this module's context. */
  target: CodegenTargetSchema.optional(),
  source: z.object({ file: z.string(), checksum: z.string().optional() }).optional(),
});
export type IRModule = z.infer<typeof ModuleSchema>;

export const CONTEXT_RELATIONSHIPS = [
  'shared-kernel',
  'customer-supplier',
  'conformist',
  'anti-corruption-layer',
  'open-host-service',
  'published-language',
  'separate-ways',
  'partnership',
] as const;

export const ContextMapEntrySchema = z.object({
  upstream: identifier,
  downstream: identifier,
  relationship: z.enum(CONTEXT_RELATIONSHIPS),
  note: z.string().optional(),
});

export const BoundedContextSchema = z.object({
  name: identifier,
  kind: z.enum(['core', 'supporting', 'generic']),
  description: z.string().optional(),
  modules: z.array(identifier).default([]),
  target: CodegenTargetSchema.optional(),
});

export const ProjectSchema = z.object({
  irVersion: z.literal(IR_VERSION),
  name: z.string().min(1),
  description: z.string().optional(),
  contexts: z.array(BoundedContextSchema).default([]),
  contextMap: z.array(ContextMapEntrySchema).default([]),
  modules: z.array(ModuleSchema).default([]),
  defaultTarget: CodegenTargetSchema.default('typescript'),
});
export type IRProject = z.infer<typeof ProjectSchema>;
export type IRBoundedContext = z.infer<typeof BoundedContextSchema>;
export type IRContextMapEntry = z.infer<typeof ContextMapEntrySchema>;
