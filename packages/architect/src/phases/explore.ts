/**
 * Phase 1 - explore.
 *
 * Turns the Markdown requirements into structured business capabilities. Every
 * item keeps the line it came from, so the whole model can be traced back to
 * the sentence a human wrote.
 */
import type { DiagnosticBag } from '@ai-lang/core';
import type { DocumentLine, RequirementsDocument } from '../document.js';
import { contentWords, headNoun, mainClause, mentions, singular, whenClause } from '../language.js';
import { classifyVerb } from '../lexicon.js';
import type { Phase } from '../phase.js';
import { QUESTION_CODES, ask, spanOf } from '../questions.js';
import type {
  AcceptanceCriterion,
  Actor,
  ArchitectState,
  Capability,
  GlossaryEntry,
  TriggerRecord,
  UserStory,
} from '../types.js';

const GLOSSARY_SECTION = /glossar|ubiquitous|definition|\bterms?\b/;
const ACTOR_SECTION = /actor|role|persona|stakeholder/;
const STORY_SECTION = /user stor|stor(y|ies)|capabilit|feature|scope|use case|what .* wants?/;
const CRITERIA_SECTION = /rule|criteri|constraint|acceptance|polic|invariant|behaviou?r/;
const TRIGGER_SECTION = /trigger|event|schedule/;

const STORY = /^as an?\s+([^,]+?)\s*,?\s+i\s+(?:want|would like|need)\s+(?:to\s+)?(.+?)(?:\s+so\s+that\s+(.+?))?\s*[.]?$/i;
const LOOSE_STORY = /^([a-z][a-z]*)\s+(.+?)\s*[.]?$/i;
const MODAL = /\b(must|cannot|can not|may not|never|always|shall|should not|is required to|is not allowed)\b/i;

export const explorePhase: Phase = {
  id: 'explore',
  title: 'Requirements',

  run(state: ArchitectState, diagnostics: DiagnosticBag): void {
    const document = state.document;
    const glossary = readGlossary(document);
    const stories = readStories(document);
    const capabilities = buildCapabilities(stories);
    const vocabulary = buildVocabulary(glossary, capabilities);

    for (const capability of capabilities) {
      capability.nouns = vocabulary.filter((noun) => mentions(capability.name, noun) || mentions(capability.object, noun));
    }

    const criteria = readCriteria(document, vocabulary, capabilities);
    for (const criterion of criteria) {
      for (const id of criterion.capabilities) {
        capabilities.find((c) => c.id === id)?.criteria.push(criterion.id);
      }
    }

    const actors = readActors(document, stories);
    const triggers = readTriggers(document, capabilities);

    state.explore = { actors, glossary, stories, capabilities, criteria, triggers, vocabulary };
    report(state, diagnostics);
  },
};

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function readGlossary(document: RequirementsDocument): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  for (const section of document.sectionsMatching(GLOSSARY_SECTION)) {
    for (const bullet of document.bullets(section)) {
      const separator = bullet.text.indexOf(':');
      if (separator < 0) continue;
      const term = bullet.text.slice(0, separator).trim();
      const definition = bullet.text.slice(separator + 1).trim();
      if (term.length === 0 || definition.length === 0) continue;
      entries.push({ term, definition, line: bullet.number });
    }
  }
  return entries;
}

function readStories(document: RequirementsDocument): UserStory[] {
  const stories: UserStory[] = [];
  const seen = new Set<number>();

  for (const bullet of document.bullets()) {
    const match = STORY.exec(bullet.text);
    if (!match) continue;
    seen.add(bullet.number);
    stories.push({
      actor: match[1]!.trim(),
      want: match[2]!.trim(),
      benefit: match[3] ? match[3].trim() : null,
      text: bullet.text,
      line: bullet.number,
    });
  }

  // Sections that promise capabilities may list them as bare verb phrases.
  for (const section of document.sectionsMatching(STORY_SECTION)) {
    for (const bullet of document.bullets(section)) {
      if (seen.has(bullet.number) || bullet.text.includes(':')) continue;
      const match = LOOSE_STORY.exec(bullet.text);
      if (!match || classifyVerb(match[1]!) === 'action') continue;
      seen.add(bullet.number);
      stories.push({ actor: null, want: bullet.text, benefit: null, text: bullet.text, line: bullet.number });
    }
  }

  return stories.sort((a, b) => a.line - b.line);
}

function buildCapabilities(stories: readonly UserStory[]): Capability[] {
  const capabilities: Capability[] = [];
  const used = new Set<string>();

  for (const story of stories) {
    const [verb = '', ...rest] = story.want.split(/\s+/);
    const object = rest.join(' ');
    const head = headNoun(object);
    if (verb.length === 0 || !head) continue;

    const base = `${verb.toLowerCase()}-${head}`;
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
    used.add(id);

    capabilities.push({
      id,
      name: `${verb.toLowerCase()} ${mainClause(object).trim()}`.trim(),
      verb: verb.toLowerCase(),
      verbClass: classifyVerb(verb),
      object,
      head,
      aggregate: head,
      actor: story.actor,
      benefit: story.benefit,
      trigger: whenClause(story.want),
      nouns: [],
      criteria: [],
      line: story.line,
    });
  }
  return capabilities;
}

/** The nouns the document itself treats as domain terms. */
function buildVocabulary(glossary: readonly GlossaryEntry[], capabilities: readonly Capability[]): string[] {
  const nouns: string[] = [];
  const add = (noun: string | null): void => {
    if (noun && !nouns.includes(noun)) nouns.push(noun);
  };
  for (const entry of glossary) add(headNoun(entry.term));
  for (const capability of capabilities) add(capability.head);
  return nouns;
}

function readCriteria(
  document: RequirementsDocument,
  vocabulary: readonly string[],
  capabilities: readonly Capability[],
): AcceptanceCriterion[] {
  const sections = new Set(document.sectionsMatching(CRITERIA_SECTION));
  const excluded = new Set([...document.sectionsMatching(GLOSSARY_SECTION), ...document.sectionsMatching(ACTOR_SECTION)]);
  const criteria: AcceptanceCriterion[] = [];
  const storyLines = new Set(capabilities.map((c) => c.line));

  for (const bullet of document.bullets()) {
    if (storyLines.has(bullet.number)) continue;
    const section = document.sectionOf(bullet.number);
    if (section && excluded.has(section)) continue;
    const inCriteriaSection = section !== null && sections.has(section);
    if (!inCriteriaSection && !MODAL.test(bullet.text)) continue;

    const text = bullet.text.replace(/\s+/g, ' ').trim();
    const nouns = vocabulary.filter((noun) => mentions(text, noun));
    criteria.push({
      id: `AC-${String(criteria.length + 1).padStart(3, '0')}`,
      text,
      nouns,
      capabilities: capabilities.filter((c) => mentions(text, c.head)).map((c) => c.id),
      line: bullet.number,
    });
  }
  return criteria;
}

function readActors(document: RequirementsDocument, stories: readonly UserStory[]): Actor[] {
  const actors: Actor[] = [];
  const add = (name: string, line: number): void => {
    const cleaned = name.replace(/\s+/g, ' ').trim();
    if (cleaned.length === 0) return;
    const key = singular(cleaned.toLowerCase());
    if (actors.some((actor) => singular(actor.name.toLowerCase()) === key)) return;
    actors.push({ name: cleaned, line });
  };

  for (const section of document.sectionsMatching(ACTOR_SECTION)) {
    for (const bullet of document.bullets(section)) {
      const separator = bullet.text.search(/[:–—]|\s-\s/);
      add(separator > 0 ? bullet.text.slice(0, separator) : bullet.text, bullet.number);
    }
  }
  for (const story of stories) {
    if (story.actor) add(story.actor, story.line);
  }
  return actors;
}

function readTriggers(document: RequirementsDocument, capabilities: readonly Capability[]): TriggerRecord[] {
  const triggers: TriggerRecord[] = [];
  const seen = new Set<string>();
  const add = (text: string, line: number, capability: string | null): void => {
    const cleaned = text.replace(/\s+/g, ' ').trim().replace(/[.,;]$/, '');
    if (cleaned.length === 0 || seen.has(cleaned.toLowerCase())) return;
    seen.add(cleaned.toLowerCase());
    triggers.push({ text: cleaned, line, capability });
  };

  for (const capability of capabilities) {
    if (capability.trigger) add(capability.trigger, capability.line, capability.id);
  }
  for (const section of document.sectionsMatching(TRIGGER_SECTION)) {
    for (const bullet of document.bullets(section)) {
      const clause = whenClause(bullet.text);
      if (clause) add(clause, bullet.number, matchingCapability(bullet, capabilities));
    }
  }
  return triggers;
}

function matchingCapability(bullet: DocumentLine, capabilities: readonly Capability[]): string | null {
  return capabilities.find((capability) => mentions(bullet.text, capability.head))?.id ?? null;
}

// ---------------------------------------------------------------------------
// Open questions
// ---------------------------------------------------------------------------

function report(state: ArchitectState, diagnostics: DiagnosticBag): void {
  const { stories, capabilities, actors } = state.explore;

  if (capabilities.length === 0) {
    diagnostics.warn('architect', QUESTION_CODES.noCapabilities, 'no user story could be read from the requirements', spanOf(state.input.path, 1), {
      hint: 'write capabilities as "- As a <role>, I want to <do something> so that <outcome>."',
    });
    return;
  }

  for (const story of stories) {
    if (story.benefit) continue;
    ask(state, diagnostics, {
      code: QUESTION_CODES.storyWithoutBenefit,
      phase: 'explore',
      line: story.line,
      ambiguity: 'this story states an action but no outcome.',
      question: `What does "${story.want}" achieve for ${story.actor ?? 'the actor'}?`,
      assumption: 'the capability is kept, with no business outcome recorded against it',
      evidence: story.text,
    });
  }

  for (const capability of capabilities) {
    if (capability.criteria.length > 0) continue;
    ask(state, diagnostics, {
      code: QUESTION_CODES.capabilityWithoutCriteria,
      phase: 'explore',
      line: capability.line,
      ambiguity: `no rule in the requirements constrains "${capability.name}".`,
      question: `Which rules decide when "${capability.name}" succeeds or fails?`,
      assumption: 'the aggregate is generated without an invariant for this capability',
      evidence: capability.name,
    });
  }

  for (const actor of actors) {
    if (capabilities.some((capability) => capability.actor && sameActor(capability.actor, actor.name))) continue;
    ask(state, diagnostics, {
      code: QUESTION_CODES.actorWithoutCapability,
      phase: 'explore',
      line: actor.line,
      ambiguity: `${actor.name} is named as an actor but owns no story.`,
      question: `What does ${actor.name} do with this system?`,
      assumption: 'the actor is documented but drives no capability',
      evidence: actor.name,
    });
  }
}

function sameActor(a: string, b: string): boolean {
  const normalise = (value: string): string => contentWords(value).map(singular).join(' ');
  return normalise(a) === normalise(b);
}
