/**
 * Phase 4 - model.
 *
 * Reads the domain model out of the requirements, and only out of the
 * requirements: an aggregate exists because a capability acts on it, an entity
 * exists because a sentence says something contains it, a field exists because a
 * sentence names it. Rules that cannot be expressed inside one aggregate become
 * open questions rather than invented structure.
 */
import type { DiagnosticBag, PrimitiveType } from '@haic/core';
import type { Statement } from '../document.js';
import { fieldName, firstSentence, mentions, singular, typeName } from '../language.js';
import {
  DEFAULT_FIELD_TYPE,
  IDENTITY_MARKERS,
  TYPE_RULES,
  VALUE_MARKERS,
  matchMarker,
} from '../lexicon.js';
import { modelDiagram } from '../mermaid.js';
import {
  aggregateName,
  collectionField,
  commandName,
  identityField,
  notFoundName,
} from '../naming.js';
import type { Phase } from '../phase.js';
import { QUESTION_CODES, ask } from '../questions.js';
import type {
  AggregatePlan,
  ArchitectState,
  Capability,
  CommandPlan,
  EntityPlan,
  ErrorPlan,
  EventShape,
  FieldPlan,
  InvariantPlan,
  ValueObjectPlan,
} from '../types.js';
import { capabilitiesOf } from './design.js';

const CONTAINMENT = /\b(?:has|have|contains?|owns?|is made of|consists of)\s+(?:many|several|multiple|one or more)\s+([a-z][a-z]*)\b/i;
const ATTRIBUTE = /\b(must have|must carry|must record|must include|may have|can have|has|have|carries|records)\s+(?:a|an|the)?\s*([a-z][a-z ]*?)\s*(?:[.,;:]|$)/i;
const SINGLE_REFERENCE = /\b(?:exactly\s+one|a single|one)\s+([a-z][a-z]*)\b/gi;
const MANDATORY = /^must/i;

interface Containment {
  owner: string;
  contained: string;
  line: number;
  text: string;
}

interface Attribute {
  subject: string;
  phrase: string;
  mandatory: boolean;
  optional: boolean;
  line: number;
  text: string;
}

interface Reference {
  subject: string;
  target: string;
  line: number;
  text: string;
}

export const modelPhase: Phase = {
  id: 'model',
  title: 'Domain model',

  run(state: ArchitectState, diagnostics: DiagnosticBag): void {
    const statements = state.document.statements();
    const aggregateNouns = new Map<string, string>(); // noun -> context name
    for (const context of state.architecture.contexts) {
      for (const capability of capabilitiesOf(state, context)) {
        aggregateNouns.set(singular(capability.aggregate), context.name);
      }
    }

    const containments = readContainments(statements, [...aggregateNouns.keys()]);
    const entityNouns = new Map<string, Containment>();
    for (const containment of containments) {
      if (aggregateNouns.has(containment.contained) || entityNouns.has(containment.contained)) continue;
      entityNouns.set(containment.contained, containment);
    }

    const known = [...aggregateNouns.keys(), ...entityNouns.keys(), ...state.explore.vocabulary];
    const attributes = readAttributes(statements, known, containments);
    const references = readReferences(statements, known);
    const valueObjects = readValueObjects(state, aggregateNouns, entityNouns);

    const entities: EntityPlan[] = [];
    for (const [noun, containment] of entityNouns) {
      const context = aggregateNouns.get(containment.owner)!;
      entities.push({
        context,
        name: aggregateName(noun),
        noun,
        aggregate: aggregateName(containment.owner),
        description: `Part of ${aggregateName(containment.owner)}; the requirements introduce it on line ${containment.line}.`,
        fields: fieldsFor(noun, containments, attributes, references, valueObjects, aggregateNouns, entityNouns),
        invariants: invariantsFor(state, noun, attributes),
        line: containment.line,
      });
    }

    const aggregates: AggregatePlan[] = [];
    for (const [noun, context] of aggregateNouns) {
      const capabilities = state.explore.capabilities.filter((capability) => singular(capability.aggregate) === noun);
      aggregates.push({
        context,
        name: aggregateName(noun),
        noun,
        description: `Consistency boundary for ${capabilities.map((capability) => `"${capability.name}"`).join(', ')}.`,
        fields: fieldsFor(noun, containments, attributes, references, valueObjects, aggregateNouns, entityNouns),
        invariants: invariantsFor(state, noun, attributes),
        entities: entities.filter((entity) => entity.aggregate === aggregateName(noun)).map((entity) => entity.name),
        emits: state.design.events.filter((event) => event.source === aggregateName(noun)).map((event) => event.name),
        line: capabilities[0]?.line ?? 1,
      });
    }

    const used = usedValueObjects(valueObjects, aggregates, entities);
    const commands = buildCommands(state, aggregates);
    const events = buildEvents(state, commands);
    const errors = buildErrors(state, aggregates);

    state.model = {
      aggregates,
      entities,
      valueObjects: used,
      commands,
      events,
      errors,
      diagram: modelDiagram(aggregates, entities, used),
    };

    reportReferences(state, diagnostics, references, entityNouns);
    reportRules(state, diagnostics, containments, references, attributes, aggregateNouns, entityNouns);
  },
};

// ---------------------------------------------------------------------------
// Sentence reading
// ---------------------------------------------------------------------------

/** The first noun of `known` that the sentence uses before `limit`. */
function subjectOf(text: string, known: readonly string[], limit: number): string | null {
  const prefix = text.slice(0, limit);
  let best: { noun: string; index: number } | null = null;
  for (const noun of known) {
    const index = indexOfNoun(prefix, noun);
    if (index < 0) continue;
    if (!best || index < best.index) best = { noun: singular(noun), index };
  }
  return best?.noun ?? null;
}

function indexOfNoun(text: string, noun: string): number {
  const pattern = new RegExp(`\\b${singular(noun)}(s|es)?\\b`, 'i');
  const match = pattern.exec(text);
  return match ? match.index : -1;
}

function readContainments(statements: readonly Statement[], aggregateNouns: readonly string[]): Containment[] {
  const out: Containment[] = [];
  for (const statement of statements) {
    const match = CONTAINMENT.exec(statement.text);
    if (!match) continue;
    const owner = subjectOf(statement.text, aggregateNouns, match.index);
    if (!owner) continue;
    out.push({ owner, contained: singular(match[1]!), line: statement.line, text: statement.text });
  }
  return out;
}

function readAttributes(
  statements: readonly Statement[],
  known: readonly string[],
  containments: readonly Containment[],
): Attribute[] {
  const consumed = new Set(containments.map((containment) => containment.line));
  const out: Attribute[] = [];

  for (const statement of statements) {
    if (consumed.has(statement.line)) continue;
    const match = ATTRIBUTE.exec(statement.text);
    if (!match) continue;
    const subject = subjectOf(statement.text, known, match.index);
    const phrase = match[2]!.trim();
    if (!subject || phrase.length === 0) continue;
    out.push({
      subject,
      phrase,
      mandatory: MANDATORY.test(match[1]!),
      optional: /^(may|can)/i.test(match[1]!),
      line: statement.line,
      text: statement.text,
    });
  }
  return out;
}

function readReferences(statements: readonly Statement[], known: readonly string[]): Reference[] {
  const out: Reference[] = [];
  for (const statement of statements) {
    const targets = [...statement.text.matchAll(SINGLE_REFERENCE)].map((match) => singular(match[1]!));
    const relevant = targets.filter((target) => known.some((noun) => singular(noun) === target));
    if (relevant.length === 0) continue;
    const subject = subjectOf(statement.text, known, statement.text.length);
    if (!subject) continue;
    for (const target of relevant) {
      if (target === subject) continue;
      out.push({ subject, target, line: statement.line, text: statement.text });
    }
  }
  return out;
}

/**
 * A glossary term describes a value when its definition speaks of an amount, a
 * code or an address and never of identity. Terms that a capability acts on are
 * aggregates, and terms something contains are entities, so they win first.
 */
function readValueObjects(
  state: ArchitectState,
  aggregateNouns: ReadonlyMap<string, string>,
  entityNouns: ReadonlyMap<string, Containment>,
): ValueObjectPlan[] {
  const out: ValueObjectPlan[] = [];
  for (const entry of state.explore.glossary) {
    const noun = singular(entry.term.split(/\s+/).pop() ?? entry.term);
    if (aggregateNouns.has(noun) || entityNouns.has(noun)) continue;
    const name = typeName(entry.term);
    if (out.some((value) => value.name === name)) continue;

    const marker = matchMarker(entry.definition, VALUE_MARKERS);
    if (!marker || matchMarker(entry.definition, IDENTITY_MARKERS)) continue;

    out.push({
      context: '',
      name,
      noun,
      description: firstSentence(entry.definition),
      fields: [{ name: 'value', type: primitiveFor(marker), required: true, identity: false, line: entry.line, note: `"${marker}" in the glossary definition` }],
      line: entry.line,
    });
  }
  return out;
}

function primitiveFor(marker: string): PrimitiveType {
  if (/amount|money|price|percentage/.test(marker)) return 'decimal';
  if (/quantity/.test(marker)) return 'integer';
  if (/range/.test(marker)) return 'duration';
  return 'text';
}

// ---------------------------------------------------------------------------
// Fields and invariants
// ---------------------------------------------------------------------------

function fieldsFor(
  noun: string,
  containments: readonly Containment[],
  attributes: readonly Attribute[],
  references: readonly Reference[],
  valueObjects: readonly ValueObjectPlan[],
  aggregateNouns: ReadonlyMap<string, string>,
  entityNouns: ReadonlyMap<string, Containment>,
): FieldPlan[] {
  const fields: FieldPlan[] = [
    { name: 'id', type: 'uuid', required: true, identity: true, line: null, note: 'every aggregate and entity is identified' },
  ];
  const add = (field: FieldPlan): void => {
    if (fields.some((existing) => existing.name === field.name)) return;
    fields.push(field);
  };

  for (const containment of containments) {
    if (containment.owner !== noun) continue;
    add({
      name: collectionField(containment.contained),
      type: `list of ${aggregateName(containment.contained)}`,
      required: true,
      identity: false,
      line: containment.line,
      note: `"${firstSentence(containment.text)}"`,
    });
  }
  for (const attribute of attributes) {
    if (attribute.subject !== noun) continue;
    add({
      name: fieldName(attribute.phrase),
      type: typeOf(attribute.phrase, valueObjects),
      required: !attribute.optional,
      identity: false,
      line: attribute.line,
      note: `"${firstSentence(attribute.text)}"`,
    });
  }
  for (const reference of references) {
    if (reference.subject !== noun) continue;
    if (!aggregateNouns.has(reference.target) && !entityNouns.has(reference.target)) continue;
    add({
      name: identityField(reference.target),
      type: 'uuid',
      required: true,
      identity: false,
      line: reference.line,
      note: `references ${aggregateName(reference.target)} by identity`,
    });
  }
  return fields;
}

function typeOf(phrase: string, valueObjects: readonly ValueObjectPlan[]): string {
  const candidate = typeName(phrase);
  if (valueObjects.some((value) => value.name === candidate)) return candidate;
  const name = fieldName(phrase);
  for (const rule of TYPE_RULES) {
    if (rule.pattern.test(name)) return rule.type;
  }
  return DEFAULT_FIELD_TYPE;
}

/**
 * One invariant per "must have" rule: the field the rule names has to be there.
 * Anything richer would be the architect inventing semantics it cannot check.
 */
function invariantsFor(state: ArchitectState, noun: string, attributes: readonly Attribute[]): InvariantPlan[] {
  const invariants: InvariantPlan[] = [];
  for (const criterion of state.explore.criteria) {
    const attribute = attributes.find((a) => a.line === criterion.line && a.subject === noun && a.mandatory);
    if (!attribute) continue;
    const field = fieldName(attribute.phrase);
    if (invariants.some((invariant) => invariant.condition.startsWith(`${field} `))) continue;
    invariants.push({ description: criterion.text.replace(/[.]$/, ''), condition: `${field} is present`, line: criterion.line });
  }
  return invariants;
}

/** A value object nothing holds is speculation, so only referenced ones survive. */
function usedValueObjects(
  valueObjects: readonly ValueObjectPlan[],
  aggregates: readonly AggregatePlan[],
  entities: readonly EntityPlan[],
): ValueObjectPlan[] {
  const out: ValueObjectPlan[] = [];
  for (const valueObject of valueObjects) {
    const owner = [...aggregates, ...entities].find((holder) => holder.fields.some((field) => field.type === valueObject.name));
    if (!owner) continue;
    out.push({ ...valueObject, context: owner.context });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Commands, events, errors
// ---------------------------------------------------------------------------

function buildCommands(state: ArchitectState, aggregates: readonly AggregatePlan[]): CommandPlan[] {
  const commands: CommandPlan[] = [];
  for (const context of state.architecture.contexts) {
    for (const capability of capabilitiesOf(state, context)) {
      if (capability.verbClass === 'read') continue;
      const target = aggregateName(capability.aggregate);
      const aggregate = aggregates.find((candidate) => candidate.name === target);
      if (!aggregate) continue;
      commands.push({
        context: context.name,
        capability: capability.id,
        name: commandName(capability),
        target,
        fields: commandFields(capability, aggregate),
      });
    }
  }
  return commands;
}

/** A creation carries what the new aggregate needs; anything else carries its identity. */
function commandFields(capability: Capability, aggregate: AggregatePlan): FieldPlan[] {
  const identity: FieldPlan = {
    name: identityField(aggregate.noun),
    type: 'uuid',
    required: true,
    identity: false,
    line: capability.line,
    note: `identifies the ${aggregate.name} the command acts on`,
  };
  if (capability.verbClass !== 'create') return [identity];

  const carried = aggregate.fields.filter((field) => !field.identity && !field.type.startsWith('list of'));
  return carried.length > 0 ? carried.map((field) => ({ ...field })) : [identity];
}

function buildEvents(state: ArchitectState, commands: readonly CommandPlan[]): EventShape[] {
  const events: EventShape[] = [];
  for (const planned of state.design.events) {
    const command = commands.find((candidate) => candidate.capability === planned.capability);
    const capability = state.explore.capabilities.find((candidate) => candidate.id === planned.capability)!;
    const identity: FieldPlan = {
      name: identityField(capability.aggregate),
      type: 'uuid',
      required: true,
      identity: false,
      line: capability.line,
      note: `identifies the ${planned.source} the event is about`,
    };
    const carried = (command?.fields ?? []).filter((field) => field.name !== identity.name).map((field) => ({ ...field }));
    events.push({
      context: planned.context,
      name: planned.name,
      source: planned.source,
      topic: planned.topic,
      fields: [
        identity,
        ...carried,
        { name: 'occurredAt', type: 'timestamp', required: true, identity: false, line: capability.line, note: 'when the fact happened' },
      ],
    });
  }
  return events;
}

/** A lookup error exists only where a capability has to find something first. */
function buildErrors(state: ArchitectState, aggregates: readonly AggregatePlan[]): ErrorPlan[] {
  const errors: ErrorPlan[] = [];
  for (const aggregate of aggregates) {
    const needsLookup = state.explore.capabilities.some(
      (capability) =>
        aggregateName(capability.aggregate) === aggregate.name &&
        capability.verbClass !== 'create' &&
        capability.verbClass !== 'read',
    );
    if (!needsLookup) continue;
    const field = identityField(aggregate.noun);
    errors.push({
      context: aggregate.context,
      name: notFoundName(aggregate.name),
      aggregate: aggregate.name,
      status: 404,
      message: `no ${aggregate.noun} exists with id {${field}}`,
      fields: [{ name: field, type: 'uuid', required: true, identity: false, line: aggregate.line, note: 'the identity that was looked up' }],
    });
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Open questions
// ---------------------------------------------------------------------------

function reportReferences(
  state: ArchitectState,
  diagnostics: DiagnosticBag,
  references: readonly Reference[],
  entityNouns: ReadonlyMap<string, Containment>,
): void {
  const seen = new Set<string>();
  for (const reference of references) {
    const containment = entityNouns.get(reference.target);
    if (!containment) continue;
    const key = `${reference.subject}->${reference.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ask(state, diagnostics, {
      code: QUESTION_CODES.entityReference,
      phase: 'model',
      line: reference.line,
      ambiguity: `${aggregateName(reference.subject)} points at ${aggregateName(reference.target)}, which lives inside ${aggregateName(containment.owner)}.`,
      question: `Should ${aggregateName(reference.target)} be an aggregate of its own, or should ${aggregateName(reference.subject)} reference ${aggregateName(containment.owner)} instead?`,
      assumption: `${aggregateName(reference.subject)} stores ${identityField(reference.target)} as a plain identity`,
      evidence: firstSentence(reference.text),
    });
  }
}

function reportRules(
  state: ArchitectState,
  diagnostics: DiagnosticBag,
  containments: readonly Containment[],
  references: readonly Reference[],
  attributes: readonly Attribute[],
  aggregateNouns: ReadonlyMap<string, string>,
  entityNouns: ReadonlyMap<string, Containment>,
): void {
  const modelled = new Set<number>([
    ...containments.map((containment) => containment.line),
    ...references.map((reference) => reference.line),
    ...attributes.filter((attribute) => attribute.mandatory).map((attribute) => attribute.line),
  ]);
  const modelNouns = [...aggregateNouns.keys(), ...entityNouns.keys()];

  for (const criterion of state.explore.criteria) {
    if (modelled.has(criterion.line)) continue;
    const touched = modelNouns.filter((noun) => mentions(criterion.text, noun));

    if (touched.length > 1) {
      ask(state, diagnostics, {
        code: QUESTION_CODES.crossAggregateRule,
        phase: 'model',
        line: criterion.line,
        ambiguity: `this rule spans ${touched.map(aggregateName).join(' and ')}, so no single aggregate can enforce it.`,
        question: `Which aggregate owns "${criterion.text}", or does it need a process that spans both?`,
        assumption: 'the rule is documented but not expressed as an invariant',
        evidence: criterion.text,
      });
      continue;
    }
    ask(state, diagnostics, {
      code: QUESTION_CODES.unmodelledRule,
      phase: 'model',
      line: criterion.line,
      ambiguity: 'this rule does not name a field the model can check.',
      question: `Which fields does "${criterion.text}" compare, and what happens when it is broken?`,
      assumption: 'the rule is carried into the spec as documentation only',
      evidence: criterion.text,
    });
  }
}
