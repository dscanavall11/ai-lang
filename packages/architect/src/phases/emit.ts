/**
 * Phase 6 — artifacts.
 *
 * Writes the reviewable spec and a first draft of the sources. The draft is
 * deliberately conservative: one aggregate per noun the requirements actually
 * name, one use case per capability, and nothing else. A thin draft that
 * compiles is a better starting point than a thick one that has to be pruned.
 */
import { CodeWriter, file, type DiagnosticBag, type GeneratedFile } from '@haic/core';
import type { Phase } from '../phase.js';
import { fieldName, quoted } from '../language.js';
import { identityField, notFoundName, repositoryName, serviceName, tableName } from '../naming.js';
import type {
  AggregatePlan,
  ArchitectState,
  BoundedContextPlan,
  EntityPlan,
  FieldPlan,
  ValueObjectPlan,
} from '../types.js';

export const emitPhase: Phase = {
  id: 'emit',
  title: 'Artifacts',

  run(state: ArchitectState, diagnostics: DiagnosticBag): void {
    const files: GeneratedFile[] = [
      requirementsDoc(state),
      architectureDoc(state),
      designDoc(state),
      modelDoc(state),
      planDoc(state),
      questionsDoc(state),
      file('.ai-spec/architecture.json', `${JSON.stringify(machineReadable(state), null, 2)}\n`),
    ];

    for (const context of state.architecture.contexts) {
      const source = renderModule(state, context);
      if (source === null) {
        diagnostics.info(
          'architect',
          'HADL3091',
          `bounded context ${context.name} has no aggregate, so no module was drafted`,
          { file: state.input.path, start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } },
          { hint: 'name the thing this context owns, and what happens to it' },
        );
        continue;
      }
      files.push(file(`src/${context.module}.hadl`, source));
    }

    state.emit = { files };
  },
};

// ---------------------------------------------------------------------------
// The draft module
// ---------------------------------------------------------------------------

function renderModule(state: ArchitectState, context: BoundedContextPlan): string | null {
  const aggregates = state.model.aggregates.filter((a) => a.context === context.name);
  if (aggregates.length === 0) return null;

  const entities = state.model.entities.filter((e) => e.context === context.name);
  const valueObjects = state.model.valueObjects.filter((v) => v.context === context.name);
  const events = state.model.events.filter((e) => e.context === context.name);
  const stack = state.design.stacks.find((s) => s.context === context.name);
  // Anything not declared here is reached by identity, so it never appears as a type.
  const localTypes = new Set<string>([
    ...valueObjects.map((v) => v.name),
    ...entities.map((e) => e.name),
    ...events.map((e) => e.name),
  ]);

  const writer = new CodeWriter();
  writer.line('---');
  writer.line(`module: ${context.module}`);
  writer.line(`context: ${sanitiseIdentifier(context.name)}`);
  if (stack) writer.line(`target: ${stack.target}`);
  writer.line('---');
  writer.blank();
  writer.line(`# ${context.name}`);
  writer.blank();
  writer.line(context.description);
  writer.blank();

  const glossary = state.explore.glossary.filter((entry) => context.nouns.includes(entry.term.toLowerCase()));
  if (glossary.length > 0) {
    writer.line('## glossary');
    for (const entry of glossary) writer.line(`- ${entry.term}: ${entry.definition}`);
    writer.blank();
  }

  for (const valueObject of valueObjects) {
    writer.line(`## value object ${valueObject.name}`);
    if (valueObject.description) writer.blank().line(valueObject.description).blank();
    writeFields(writer, valueObject.fields, localTypes, valueObject);
    writer.blank();
  }

  for (const entity of entities) {
    writer.line(`## entity ${entity.name}`);
    writer.line(`identified by ${identityOf(entity)}`);
    writer.line(`belongs to ${entity.aggregate}`);
    writer.blank();
    writeFields(writer, entity.fields, localTypes, entity);
    writer.blank();
  }

  for (const aggregate of aggregates) {
    const owned = entities.filter((e) => e.aggregate === aggregate.name);
    writer.line(`## aggregate ${aggregate.name}`);
    writer.line(`identified by ${identityOf(aggregate)}`);
    for (const entity of owned) writer.line(`contains ${entity.name}`);
    for (const emitted of aggregate.emits) writer.line(`emits ${emitted}`);
    if (aggregate.description) writer.blank().line(aggregate.description);
    writer.blank();
    writeFields(writer, aggregate.fields, localTypes, aggregate);
    writer.blank();

    // Every aggregate needs at least one rule; the identity is the fallback.
    const invariants =
      aggregate.invariants.length > 0
        ? aggregate.invariants
        : [{ description: `a ${aggregate.noun} always has an identity`, condition: `${identityOf(aggregate)} is not empty`, line: aggregate.line }];
    for (const invariant of invariants) {
      writer.line(`invariant ${quoted(invariant.description)}:`);
      writer.line(`  ${invariant.condition}`);
      writer.blank();
    }
  }

  for (const event of events) {
    writer.line(`## event ${event.name} from ${event.source}`);
    writer.line(`topic ${event.topic}`);
    writer.blank();
    for (const field of event.fields) writer.line(renderField(field, localTypes));
    writer.blank();
  }

  for (const aggregate of aggregates) {
    const error = notFoundName(aggregate.name);
    const key = identityField(aggregate.noun);
    writer.line(`## error ${error} (checked, status 404)`);
    writer.line(`message: "no ${aggregate.noun} exists with id {${key}}"`);
    writer.blank();
    writer.line(`- ${key}: uuid, required`);
    writer.blank();
  }

  for (const aggregate of aggregates) {
    const repository = repositoryName(aggregate.name);
    const error = notFoundName(aggregate.name);
    writer.line(`## port ${repository} (outbound)`);
    writer.blank();
    writer.line(`- find ${aggregate.noun} by id (id: uuid) -> ${aggregate.name} or ${error}`);
    writer.line(`- save ${aggregate.noun} (${fieldName(aggregate.noun)}: ${aggregate.name}) -> nothing`);
    writer.blank();

    writer.line(`## port ${aggregate.name}UseCase (inbound)`);
    writer.blank();
    writer.line(`- read ${aggregate.noun} (id: uuid) -> ${aggregate.name} or ${error}`);
    writer.blank();

    writer.line(`## adapter Postgres${repository} implements ${repository} using sql`);
    writer.line('config:');
    writer.line(`  table = ${tableName(aggregate.name)}`);
    writer.blank();

    writer.line(`## service ${serviceName(aggregate.name)}`);
    writer.line(`uses ${repository}`);
    writer.line(`implements ${aggregate.name}UseCase`);
    writer.blank();
    writer.line(`Loads a ${aggregate.noun} by its identity. Extend this service with the rules the`);
    writer.line('requirements describe; the compiler will tell you what the contract must say.');
    writer.blank();
    writer.line(`operation read ${aggregate.noun} (id: uuid) -> ${aggregate.name} or ${error}:`);
    writer.line(`  let ${fieldName(aggregate.noun)} be find ${aggregate.noun} by id with id = id`);
    writer.line(`  return ${fieldName(aggregate.noun)}`);
    writer.blank();

    writer.line(`## endpoint GET /${plural(aggregate.noun)}/{id}`);
    writer.line(`handled by ${serviceName(aggregate.name)}.read ${aggregate.noun}`);
    writer.line(`responds 200 with ${aggregate.name}`);
    writer.line(`responds 404 when ${error}`);
    writer.blank();
  }

  writer.line('## infrastructure');
  writer.line('port 8080');
  writer.line(`database ${context.module}db using postgres`);
  if (events.length > 0) {
    writer.line(`broker events using kafka topics ${events.map((e) => e.topic).join(', ')}`);
  }
  writer.line('deploy to docker, kubernetes');

  return writer.toString();
}

function writeFields(
  writer: CodeWriter,
  fields: readonly FieldPlan[],
  localTypes: ReadonlySet<string>,
  owner: AggregatePlan | EntityPlan | ValueObjectPlan,
): void {
  if (fields.length === 0) {
    writer.line(`- ${identityField(owner.noun)}: uuid, required`);
    return;
  }
  for (const field of fields) writer.line(renderField(field, localTypes));
}

const PRIMITIVES = new Set([
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
]);

/**
 * A field becomes an identity when it points at another aggregate or at
 * something this module does not declare. Both are the same DDD rule: you cross
 * a boundary by identity, never by holding the thing on the other side.
 */
function renderField(field: FieldPlan, localTypes: ReadonlySet<string>): string {
  const element = field.type.replace(/^list of /, '');
  const isList = field.type.startsWith('list of ');
  const byIdentity = !PRIMITIVES.has(element) && !localTypes.has(element);

  const type = byIdentity ? (isList ? 'list of uuid' : 'uuid') : field.type;
  const name = byIdentity && !field.name.endsWith('Id') ? `${field.name}${isList ? 'Ids' : 'Id'}` : field.name;
  const modifiers = field.required ? ', required' : ', optional';
  const comment = field.note ? `  // ${field.note}` : byIdentity ? `  // ${element} lives outside this boundary` : '';
  return `- ${name}: ${type}${modifiers}${comment}`;
}

function identityOf(owner: AggregatePlan | EntityPlan): string {
  return owner.fields.find((f) => f.identity)?.name ?? 'id';
}

function plural(noun: string): string {
  if (/(s|x|z|ch|sh)$/i.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

function sanitiseIdentifier(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]/g, '');
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `Context${cleaned}`;
}

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

function requirementsDoc(state: ArchitectState): GeneratedFile {
  const w = new CodeWriter();
  w.line('# 1. Requirements');
  w.blank();
  w.line(`Extracted from \`${state.input.path}\`. Every item cites the line it came from.`);
  w.blank();

  section(w, 'Actors', state.explore.actors.map((a) => `- **${a.name}** — line ${a.line}`));
  section(
    w,
    'Capabilities',
    state.explore.capabilities.map((c) => `- \`${c.id}\` **${c.name}** — ${c.actor ?? 'someone'}, line ${c.line}`),
  );
  section(
    w,
    'Acceptance criteria',
    state.explore.criteria.map((c) => `- \`${c.id}\` ${c.text} — line ${c.line}`),
  );
  section(w, 'Triggers', state.explore.triggers.map((t) => `- ${t.text} — line ${t.line}`));
  section(w, 'Glossary', state.explore.glossary.map((g) => `- **${g.term}**: ${g.definition} — line ${g.line}`));
  section(w, 'Vocabulary', [state.explore.vocabulary.map((v) => `\`${v}\``).join(', ')]);
  return file('.ai-spec/01-requirements.md', w.toString());
}

function architectureDoc(state: ArchitectState): GeneratedFile {
  const w = new CodeWriter();
  w.line('# 2. Business architecture');
  w.blank();
  w.line('| Subdomain | Kind | Why |');
  w.line('| --- | --- | --- |');
  for (const subdomain of state.architecture.subdomains) {
    w.line(`| ${subdomain.name} | ${subdomain.kind} | ${subdomain.reason} |`);
  }
  w.blank();
  w.line('## Bounded contexts');
  w.blank();
  for (const context of state.architecture.contexts) {
    w.line(`### ${context.name} (${context.kind})`);
    w.blank();
    w.line(context.description);
    w.blank();
    w.line(`- module: \`${context.module}\``);
    w.line(`- owns: ${context.nouns.join(', ') || '—'}`);
    w.line(`- capabilities: ${context.capabilities.join(', ') || '—'}`);
    w.blank();
  }
  w.line('## Context map');
  w.blank();
  if (state.architecture.contextMap.length === 0) w.line('No cross-context relationships were stated.');
  for (const edge of state.architecture.contextMap) {
    w.line(`- ${edge.upstream} → ${edge.downstream} (${edge.relationship}): ${edge.note}`);
  }
  w.blank();
  w.line('```mermaid');
  w.line(state.architecture.diagram);
  w.line('```');
  return file('.ai-spec/02-architecture.md', w.toString());
}

function designDoc(state: ArchitectState): GeneratedFile {
  const w = new CodeWriter();
  w.line('# 3. Design');
  w.blank();
  w.line('## Technology per context');
  w.blank();
  w.line('| Context | Target | Signal | Why |');
  w.line('| --- | --- | --- | --- |');
  for (const stack of state.design.stacks) {
    w.line(`| ${stack.context} | ${stack.target} | ${stack.signal ? `"${stack.signal}"` : '—'} | ${stack.reason} |`);
  }
  w.blank();
  w.line('## API surface');
  w.blank();
  w.line('| Context | Method | Path | Capability |');
  w.line('| --- | --- | --- | --- |');
  for (const endpoint of state.design.endpoints) {
    w.line(`| ${endpoint.context} | ${endpoint.method} | \`${endpoint.path}\` | ${endpoint.capability} |`);
  }
  w.blank();
  w.line('## Events');
  w.blank();
  if (state.design.events.length === 0) w.line('The requirements describe no cross-context reactions.');
  for (const event of state.design.events) {
    w.line(`- **${event.name}** from ${event.source} on topic \`${event.topic}\` (${event.context})`);
  }
  w.blank();
  for (const workflow of state.design.workflows) {
    w.line(`### ${workflow.title}`);
    w.blank();
    w.line('```mermaid');
    w.line(workflow.diagram);
    w.line('```');
    w.blank();
  }
  return file('.ai-spec/03-design.md', w.toString());
}

function modelDoc(state: ArchitectState): GeneratedFile {
  const w = new CodeWriter();
  w.line('# 4. Domain model');
  w.blank();
  for (const aggregate of state.model.aggregates) {
    w.line(`## ${aggregate.name} (${aggregate.context})`);
    w.blank();
    w.line(aggregate.description);
    w.blank();
    w.line('| Field | Type | Required | From |');
    w.line('| --- | --- | --- | --- |');
    for (const field of aggregate.fields) {
      w.line(`| ${field.name} | \`${field.type}\` | ${field.required ? 'yes' : 'no'} | ${field.line ? `line ${field.line}` : '—'} |`);
    }
    w.blank();
    if (aggregate.invariants.length > 0) {
      w.line('Rules:');
      for (const invariant of aggregate.invariants) w.line(`- ${invariant.description} (line ${invariant.line})`);
      w.blank();
    }
  }
  section(w, 'Entities', state.model.entities.map((e) => `- **${e.name}** inside ${e.aggregate} — line ${e.line}`));
  section(w, 'Value objects', state.model.valueObjects.map((v) => `- **${v.name}** — line ${v.line}`));
  section(w, 'Commands', state.model.commands.map((c) => `- **${c.name}** targets ${c.target}`));
  section(w, 'Events', state.model.events.map((e) => `- **${e.name}** from ${e.source}`));
  w.line('```mermaid');
  w.line(state.model.diagram);
  w.line('```');
  return file('.ai-spec/04-model.md', w.toString());
}

function planDoc(state: ArchitectState): GeneratedFile {
  const w = new CodeWriter();
  w.line('# 5. Implementation plan');
  w.blank();
  w.line('Tasks are ordered by the dependency direction of the architecture. A task');
  w.line('marked parallel shares no state with its siblings in the same layer.');
  w.blank();

  for (const context of state.architecture.contexts) {
    const tasks = state.plan.tasks.filter((t) => t.context === context.name);
    if (tasks.length === 0) continue;
    w.line(`## ${context.name}`);
    w.blank();
    for (const layer of ['domain', 'application', 'infrastructure', 'interface'] as const) {
      const inLayer = tasks.filter((t) => t.layer === layer);
      if (inLayer.length === 0) continue;
      w.line(`### ${layer}`);
      w.blank();
      for (const task of inLayer) {
        const dependencies = task.dependsOn.length > 0 ? ` — after ${task.dependsOn.join(', ')}` : '';
        const parallel = task.parallel ? '' : ' *(sequential)*';
        w.line(`- [ ] \`${task.id}\` ${task.title}${dependencies}${parallel}`);
      }
      w.blank();
    }
  }
  return file('.ai-spec/05-plan.md', w.toString());
}

function questionsDoc(state: ArchitectState): GeneratedFile {
  const w = new CodeWriter();
  w.line('# 6. Open questions');
  w.blank();
  if (state.openQuestions.length === 0) {
    w.line('The requirements answered everything the architect needed.');
    return file('.ai-spec/06-open-questions.md', w.toString());
  }
  w.line('Each question names what the requirements left open and what was assumed in');
  w.line('the meantime. Answer them in the requirements and re-run, or edit the draft.');
  w.blank();
  for (const question of state.openQuestions) {
    w.line(`## ${question.id} — ${question.question}`);
    w.blank();
    w.line(`- **phase**: ${question.phase}`);
    w.line(`- **source**: line ${question.line} — ${question.evidence ? `"${question.evidence}"` : 'no direct quote'}`);
    w.line(`- **ambiguity**: ${question.ambiguity}`);
    w.line(`- **assumed**: ${question.assumption}`);
    w.blank();
  }
  return file('.ai-spec/06-open-questions.md', w.toString());
}

function machineReadable(state: ArchitectState): unknown {
  return {
    project: state.input.projectName,
    source: state.input.path,
    explore: state.explore,
    architecture: state.architecture,
    design: state.design,
    model: state.model,
    plan: state.plan,
    openQuestions: state.openQuestions,
  };
}

function section(writer: CodeWriter, title: string, lines: readonly string[]): void {
  writer.line(`## ${title}`);
  writer.blank();
  if (lines.length === 0 || lines.every((l) => l.trim() === '')) writer.line('_none found_');
  else writer.lines_(lines);
  writer.blank();
}
