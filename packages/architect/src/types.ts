/**
 * Everything the architect phases accumulate.
 *
 * The state is one plain, JSON-serialisable object: `.ai-spec/architecture.json`
 * is literally this structure, so a reviewer reads exactly what the phases saw.
 */
import type { CodegenTarget, Diagnostic, GeneratedFile } from '@ai-lang/core';
import type { RequirementsDocument } from './document.js';

export interface ArchitectInput {
  /** Raw Markdown requirements document. */
  requirements: string;
  /** Path the requirements came from, used in diagnostics. */
  path: string;
  projectName: string;
}

export interface ArchitectResult {
  files: GeneratedFile[];
  diagnostics: Diagnostic[];
  openQuestions: OpenQuestion[];
  state: ArchitectState;
}

/** Every extracted item carries the line it came from, so nothing is unsourced. */
export interface Traced {
  /** 1-based line in the requirements document. */
  line: number;
}

export interface OpenQuestion extends Traced {
  id: string;
  /** Stable diagnostic code, e.g. `AIL3010`. */
  code: string;
  phase: string;
  /** What the requirements left open. */
  ambiguity: string;
  /** The question a human has to answer. */
  question: string;
  /** What the architect did in the meantime. */
  assumption: string;
  /** Verbatim source text the question came from. */
  evidence: string;
}

// ---------------------------------------------------------------------------
// Phase 1 - explore
// ---------------------------------------------------------------------------

export interface Actor extends Traced {
  name: string;
}

export interface GlossaryEntry extends Traced {
  term: string;
  definition: string;
}

export interface UserStory extends Traced {
  actor: string | null;
  want: string;
  benefit: string | null;
  text: string;
}

export type VerbClass = 'create' | 'read' | 'update' | 'delete' | 'action';

export interface Capability extends Traced {
  id: string;
  /** Human label, e.g. "borrow a book". */
  name: string;
  verb: string;
  verbClass: VerbClass;
  /** Noun phrase the verb acts on. */
  object: string;
  /** Singular head noun of `object`, lower case. */
  head: string;
  /** Noun of the aggregate this capability acts on. Assigned by the architecture phase. */
  aggregate: string;
  actor: string | null;
  benefit: string | null;
  /** `when ...` clause found on the story, if any. */
  trigger: string | null;
  /** Domain nouns mentioned by the capability itself. */
  nouns: string[];
  /** Ids of the acceptance criteria that constrain it. */
  criteria: string[];
}

export interface AcceptanceCriterion extends Traced {
  id: string;
  text: string;
  nouns: string[];
  capabilities: string[];
}

export interface TriggerRecord extends Traced {
  text: string;
  capability: string | null;
}

export interface ExploreResult {
  actors: Actor[];
  glossary: GlossaryEntry[];
  stories: UserStory[];
  capabilities: Capability[];
  criteria: AcceptanceCriterion[];
  triggers: TriggerRecord[];
  /** Nouns the document actually uses as domain terms. */
  vocabulary: string[];
}

// ---------------------------------------------------------------------------
// Phase 2 - architecture
// ---------------------------------------------------------------------------

export type SubdomainKind = 'core' | 'supporting' | 'generic';

export interface Subdomain {
  name: string;
  kind: SubdomainKind;
  /** Noun the subdomain is named after. */
  root: string;
  nouns: string[];
  capabilities: string[];
  /** Heuristic that produced this grouping and classification. */
  reason: string;
}

export interface BoundedContextPlan {
  name: string;
  /** `.ail` module name, snake_case of `name`. */
  module: string;
  kind: SubdomainKind;
  subdomains: string[];
  capabilities: string[];
  root: string;
  nouns: string[];
  description: string;
}

export interface ContextEdge {
  upstream: string;
  downstream: string;
  relationship: string;
  note: string;
}

export interface ArchitectureResult {
  subdomains: Subdomain[];
  contexts: BoundedContextPlan[];
  contextMap: ContextEdge[];
  diagram: string;
}

// ---------------------------------------------------------------------------
// Phase 3 - design
// ---------------------------------------------------------------------------

export interface StackChoice {
  context: string;
  target: CodegenTarget;
  /** Requirement phrase that justified the choice, or null when defaulted. */
  signal: string | null;
  reason: string;
}

export interface EndpointPlan {
  context: string;
  capability: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  /** Aggregate the route is about. */
  resource: string;
  auth: 'none' | 'bearer';
}

export interface EventPlan {
  context: string;
  capability: string;
  name: string;
  /** Aggregate that emits it. */
  source: string;
  topic: string;
}

export interface WorkflowDiagram {
  context: string;
  capability: string;
  title: string;
  diagram: string;
}

export interface DesignResult {
  stacks: StackChoice[];
  endpoints: EndpointPlan[];
  events: EventPlan[];
  workflows: WorkflowDiagram[];
}

// ---------------------------------------------------------------------------
// Phase 4 - model
// ---------------------------------------------------------------------------

export interface FieldPlan {
  name: string;
  /** AI-Lang type expression, e.g. `list of Copy`. */
  type: string;
  required: boolean;
  identity: boolean;
  /** Requirement line the field came from, or null for the identity field. */
  line: number | null;
  note: string;
}

export interface InvariantPlan {
  description: string;
  /** AI-Lang boolean expression. */
  condition: string;
  line: number;
}

export interface AggregatePlan {
  context: string;
  name: string;
  noun: string;
  description: string;
  fields: FieldPlan[];
  invariants: InvariantPlan[];
  entities: string[];
  emits: string[];
  line: number;
}

export interface EntityPlan {
  context: string;
  name: string;
  noun: string;
  aggregate: string;
  description: string;
  fields: FieldPlan[];
  invariants: InvariantPlan[];
  line: number;
}

export interface ValueObjectPlan {
  context: string;
  name: string;
  noun: string;
  description: string;
  fields: FieldPlan[];
  line: number;
}

export interface CommandPlan {
  context: string;
  capability: string;
  name: string;
  target: string;
  fields: FieldPlan[];
}

export interface EventShape {
  context: string;
  name: string;
  source: string;
  topic: string;
  fields: FieldPlan[];
}

export interface ErrorPlan {
  context: string;
  name: string;
  aggregate: string;
  status: number;
  message: string;
  fields: FieldPlan[];
}

export interface ModelResult {
  aggregates: AggregatePlan[];
  entities: EntityPlan[];
  valueObjects: ValueObjectPlan[];
  commands: CommandPlan[];
  events: EventShape[];
  errors: ErrorPlan[];
  diagram: string;
}

// ---------------------------------------------------------------------------
// Phase 5 - plan
// ---------------------------------------------------------------------------

export type DddLayer = 'domain' | 'application' | 'infrastructure' | 'interface';

export interface TaskPlan {
  id: string;
  context: string;
  layer: DddLayer;
  title: string;
  /** Task ids that must land first. */
  dependsOn: string[];
  parallel: boolean;
  capability: string | null;
}

export interface PlanResult {
  tasks: TaskPlan[];
}

// ---------------------------------------------------------------------------
// Phase 6 - emit
// ---------------------------------------------------------------------------

export interface EmitResult {
  files: GeneratedFile[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface ArchitectState {
  input: ArchitectInput;
  document: RequirementsDocument;
  explore: ExploreResult;
  architecture: ArchitectureResult;
  design: DesignResult;
  model: ModelResult;
  plan: PlanResult;
  emit: EmitResult;
  openQuestions: OpenQuestion[];
}
