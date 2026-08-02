/**
 * The architect's heuristics, as data.
 *
 * Every judgement the architect makes comes from one of these tables. They are
 * exported so the generated `02-architecture.md` can print the exact rule that
 * fired, and so adding a rule never means editing a phase.
 */
import type { CodegenTarget, DeployTarget, PrimitiveType } from '@ai-lang/core';
import type { VerbClass } from './types.js';

export interface VerbGroup {
  readonly class: VerbClass;
  readonly verbs: readonly string[];
}

/** First match wins, so `register` is a creation even though it reads like an update. */
export const VERB_GROUPS: readonly VerbGroup[] = [
  { class: 'read', verbs: ['search', 'list', 'find', 'view', 'see', 'browse', 'get', 'read', 'query', 'inspect', 'consult'] },
  { class: 'create', verbs: ['add', 'create', 'register', 'catalogue', 'catalog', 'record', 'open', 'issue', 'submit', 'send', 'charge', 'raise', 'place'] },
  { class: 'update', verbs: ['update', 'change', 'edit', 'renew', 'extend', 'modify', 'correct', 'adjust'] },
  { class: 'delete', verbs: ['delete', 'remove', 'cancel', 'close', 'archive', 'withdraw'] },
];

export function classifyVerb(verb: string): VerbClass {
  const lower = verb.toLowerCase();
  for (const group of VERB_GROUPS) {
    if (group.verbs.includes(lower)) return group.class;
  }
  return 'action';
}

export interface GenericFamily {
  readonly name: string;
  /** Noun the family's aggregate is named after. */
  readonly noun: string;
  readonly markers: readonly string[];
}

/**
 * Capabilities matching one of these families are generic subdomains: they are
 * the same in every business, so they are bought or copied, not designed.
 * The requirements can override this by calling them a differentiator.
 */
export const GENERIC_FAMILIES: readonly GenericFamily[] = [
  { name: 'Access', noun: 'credential', markers: ['authenticat', 'authoris', 'authoriz', 'login', 'log in', 'sign in', 'password', 'permission'] },
  { name: 'Notifications', noun: 'notification', markers: ['notif', 'alert', 'reminder', 'email message', 'sms'] },
  { name: 'Billing', noun: 'invoice', markers: ['billing', 'invoice', 'subscription', 'checkout', 'payment method'] },
  { name: 'Auditing', noun: 'auditEntry', markers: ['audit'] },
  { name: 'Reporting', noun: 'report', markers: ['report', 'dashboard', 'analytic', 'statistic'] },
];

/** Language that marks a capability as the thing the business competes on. */
export const DIFFERENTIATOR_MARKERS: readonly string[] = [
  'unique',
  'competitive',
  'differentiat',
  'off the shelf',
  'cannot be bought',
  'our advantage',
  'proprietary',
  'core to',
  'what we compete on',
];

export interface StackRule {
  readonly target: CodegenTarget;
  readonly markers: readonly string[];
  readonly rationale: string;
}

/** Ordered: the first rule whose marker appears in the text wins. */
export const STACK_RULES: readonly StackRule[] = [
  {
    target: 'python',
    markers: ['machine learning', 'data pipeline', 'data science', 'model training', 'recommendation', 'analytics pipeline', 'statistical model'],
    rationale: 'the requirements describe data or model work, where the python ecosystem is the shortest path',
  },
  {
    target: 'rust',
    markers: ['memory safe', 'memory safety', 'systems programming', 'embedded', 'no garbage collection', 'zero cost'],
    rationale: 'the requirements demand systems-level control without a garbage collector',
  },
  {
    target: 'go',
    markers: ['sub-millisecond', 'sub millisecond', 'high throughput', 'low latency', 'real time', 'real-time', 'requests per second', 'concurrent connections'],
    rationale: 'the requirements state a latency or throughput budget that a compiled, concurrent runtime meets predictably',
  },
  {
    target: 'java',
    markers: ['enterprise', 'existing java', 'java estate', 'jvm', 'spring boot', 'legacy java'],
    rationale: 'the requirements place this service inside an existing JVM estate',
  },
];

export const DEFAULT_TARGET: CodegenTarget = 'typescript';

export interface TypeRule {
  readonly pattern: RegExp;
  readonly type: PrimitiveType;
}

/** Field type from the camelCase field name. First match wins. */
export const TYPE_RULES: readonly TypeRule[] = [
  { pattern: /(^id|Id)$/, type: 'uuid' },
  { pattern: /(^date|Date|^day|Day)$/, type: 'date' },
  { pattern: /(^time|Time|At|^timestamp|Timestamp|^moment|Moment)$/, type: 'timestamp' },
  { pattern: /(^amount|Amount|^price|Price|^fee|Fee|^total|Total|^balance|Balance|^rate|Rate|^cost|Cost)$/, type: 'decimal' },
  { pattern: /(^count|Count|^quantity|Quantity|^number|Number|^limit|Limit)$/, type: 'integer' },
  { pattern: /^(is|has|can|was)[A-Z]/, type: 'boolean' },
  { pattern: /(^duration|Duration|^period|Period)$/, type: 'duration' },
];

export const DEFAULT_FIELD_TYPE: PrimitiveType = 'text';

/** Words that make a glossary entry describe a value rather than a thing. */
export const VALUE_MARKERS: readonly string[] = [
  'amount',
  'sum of money',
  'money',
  'price',
  'code',
  'identifier',
  'address',
  'percentage',
  'quantity',
  'measure',
  'range',
];

/** Words that make a glossary entry describe something with identity. */
export const IDENTITY_MARKERS: readonly string[] = ['each', 'record', 'person', 'physical', 'unique', 'registered', 'one of'];

export interface EngineRule<T extends string> {
  readonly engine: T;
  readonly markers: readonly string[];
}

export const DATABASE_RULES: readonly EngineRule<'mongodb' | 'dynamodb' | 'mysql' | 'sqlite'>[] = [
  { engine: 'mongodb', markers: ['document store', 'schemaless', 'mongo'] },
  { engine: 'dynamodb', markers: ['dynamodb', 'key value store'] },
  { engine: 'mysql', markers: ['mysql'] },
  { engine: 'sqlite', markers: ['sqlite', 'single file database'] },
];

export const DEFAULT_DATABASE_ENGINE = 'postgres';

export const BROKER_RULES: readonly EngineRule<'kafka' | 'rabbitmq' | 'sqs' | 'nats'>[] = [
  { engine: 'kafka', markers: ['kafka', 'event stream', 'replay events'] },
  { engine: 'rabbitmq', markers: ['rabbitmq', 'amqp'] },
  { engine: 'sqs', markers: ['sqs', 'aws queue'] },
  { engine: 'nats', markers: ['nats'] },
];

export const DEFAULT_BROKER_ENGINE = 'kafka';

export const DEPLOY_RULES: readonly EngineRule<DeployTarget>[] = [
  { engine: 'kubernetes', markers: ['kubernetes', 'k8s', 'cluster', 'autoscal', 'scale out'] },
  { engine: 'terraform', markers: ['terraform', 'aws', 'gcp', 'azure', 'cloud account'] },
  { engine: 'aws-lambda', markers: ['lambda', 'serverless'] },
];

export const DEFAULT_DEPLOY_TARGET: DeployTarget = 'docker';

/** Verbs that state containment: `a book has many copies`. */
export const CONTAINMENT_VERBS: readonly string[] = ['has', 'have', 'contains', 'contain', 'holds', 'hold', 'consists of', 'is made of', 'is made up of'];

/** Determiners that make a relation single-valued, so it becomes an identity field. */
export const SINGLE_CARDINALITY_MARKERS: readonly string[] = ['one', 'exactly one', 'a single', 'its own'];

export function matchMarker(text: string, markers: readonly string[]): string | null {
  const lower = text.toLowerCase();
  for (const marker of markers) {
    if (lower.includes(marker)) return marker;
  }
  return null;
}
