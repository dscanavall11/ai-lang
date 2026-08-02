/**
 * Phase 2 - architecture.
 *
 * Groups capabilities into subdomains, classifies them, and turns each
 * subdomain into a bounded context. Three heuristics decide everything, and all
 * three are printed into `02-architecture.md` next to the decision they made:
 *
 *   1. capabilities that share a domain noun belong to the same subdomain;
 *   2. auth, notifications, billing, auditing and reporting are generic unless
 *      the requirements call them a differentiator;
 *   3. a subdomain the requirements describe as unique or competitive is core,
 *      anything else is supporting.
 */
import { pascalCase, snakeCase, type DiagnosticBag } from '@ai-lang/core';
import { countMentions, mentions, plural, singular } from '../language.js';
import { DIFFERENTIATOR_MARKERS, GENERIC_FAMILIES, matchMarker, type GenericFamily } from '../lexicon.js';
import { contextMapDiagram } from '../mermaid.js';
import type { Phase } from '../phase.js';
import { QUESTION_CODES, ask } from '../questions.js';
import type {
  AcceptanceCriterion,
  ArchitectState,
  BoundedContextPlan,
  Capability,
  ContextEdge,
  Subdomain,
  SubdomainKind,
} from '../types.js';

export const architecturePhase: Phase = {
  id: 'architecture',
  title: 'Architecture',

  run(state: ArchitectState, diagnostics: DiagnosticBag): void {
    const { capabilities, criteria } = state.explore;
    const differentiators = differentiatorStatements(state);

    const subdomains: Subdomain[] = [];
    for (const [family, members] of genericGroups(capabilities)) {
      for (const capability of members) capability.aggregate = family.noun;
      subdomains.push({
        name: family.name,
        kind: 'generic',
        root: family.noun,
        nouns: unique(members.flatMap((capability) => capability.nouns).concat(family.noun)),
        capabilities: members.map((capability) => capability.id),
        reason: `every capability here matches the "${family.markers[0]!}" family, which every business solves the same way`,
      });
    }

    const remaining = capabilities.filter((capability) => !subdomains.some((s) => s.capabilities.includes(capability.id)));
    for (const group of clusterByNouns(remaining, criteria)) {
      const root = dominantNoun(group, state.document.text);
      const kind = classify(group, differentiators);
      subdomains.push({
        name: pascalCase(plural(root)),
        kind,
        root,
        nouns: unique(group.flatMap((capability) => nounsOf(capability, criteria))),
        capabilities: group.map((capability) => capability.id),
        reason: reasonFor(group, root, kind, differentiators),
      });
    }

    // One context per subdomain: the clustering already merged everything that
    // shares vocabulary, so two subdomains never speak the same language.
    const contexts: BoundedContextPlan[] = subdomains.map((subdomain) => ({
      name: subdomain.name,
      module: snakeCase(subdomain.name),
      kind: subdomain.kind,
      subdomains: [subdomain.name],
      capabilities: [...subdomain.capabilities],
      root: subdomain.root,
      nouns: [...subdomain.nouns],
      description: `${subdomain.capabilities.length} capabilit${subdomain.capabilities.length === 1 ? 'y' : 'ies'} about ${subdomain.nouns.join(', ')}.`,
    }));

    const contextMap = buildContextMap(contexts, capabilities, criteria);
    state.architecture = { subdomains, contexts, contextMap, diagram: contextMapDiagram(contexts, contextMap) };

    report(state, diagnostics);
  },
};

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function genericGroups(capabilities: readonly Capability[]): Array<[GenericFamily, Capability[]]> {
  const groups: Array<[GenericFamily, Capability[]]> = [];
  for (const family of GENERIC_FAMILIES) {
    const members = capabilities.filter((capability) => matchMarker(capability.name, family.markers) !== null);
    if (members.length > 0) groups.push([family, members]);
  }
  // A capability can only belong to one family; the first match owns it.
  const claimed = new Set<string>();
  return groups
    .map(([family, members]): [GenericFamily, Capability[]] => {
      const mine = members.filter((capability) => !claimed.has(capability.id));
      for (const capability of mine) claimed.add(capability.id);
      return [family, mine];
    })
    .filter(([, members]) => members.length > 0);
}

/** Union-find over capabilities: two capabilities merge when their nouns overlap. */
function clusterByNouns(capabilities: readonly Capability[], criteria: readonly AcceptanceCriterion[]): Capability[][] {
  const parent = capabilities.map((_, index) => index);
  const find = (index: number): number => {
    let current = index;
    while (parent[current] !== current) current = parent[current]!;
    return current;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
  };

  const nouns = capabilities.map((capability) => new Set(nounsOf(capability, criteria)));
  for (let i = 0; i < capabilities.length; i += 1) {
    for (let j = i + 1; j < capabilities.length; j += 1) {
      if ([...nouns[i]!].some((noun) => nouns[j]!.has(noun))) union(i, j);
    }
  }

  const groups = new Map<number, Capability[]>();
  capabilities.forEach((capability, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), capability]);
  });
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group);
}

/** A capability's vocabulary: its own nouns plus the nouns of the rules about it. */
function nounsOf(capability: Capability, criteria: readonly AcceptanceCriterion[]): string[] {
  const nouns = new Set<string>([capability.head, ...capability.nouns]);
  for (const criterion of criteria) {
    if (!capability.criteria.includes(criterion.id)) continue;
    for (const noun of criterion.nouns) nouns.add(noun);
  }
  return [...nouns];
}

/** The capability noun the requirements repeat most often names the subdomain. */
function dominantNoun(group: readonly Capability[], text: string): string {
  const heads = unique(group.map((capability) => capability.head));
  let best = heads[0]!;
  let bestCount = -1;
  for (const head of heads) {
    const count = countMentions(text, head);
    if (count > bestCount) {
      best = head;
      bestCount = count;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface Differentiator {
  text: string;
  line: number;
  marker: string;
}

function differentiatorStatements(state: ArchitectState): Differentiator[] {
  const out: Differentiator[] = [];
  for (const statement of state.document.statements()) {
    const marker = matchMarker(statement.text, DIFFERENTIATOR_MARKERS);
    if (marker) out.push({ text: statement.text, line: statement.line, marker });
  }
  return out;
}

function classify(group: readonly Capability[], differentiators: readonly Differentiator[]): SubdomainKind {
  return matchingDifferentiator(group, differentiators) ? 'core' : 'supporting';
}

function matchingDifferentiator(
  group: readonly Capability[],
  differentiators: readonly Differentiator[],
): Differentiator | null {
  for (const differentiator of differentiators) {
    if (group.some((capability) => mentions(differentiator.text, capability.head))) return differentiator;
  }
  return null;
}

function reasonFor(
  group: readonly Capability[],
  root: string,
  kind: SubdomainKind,
  differentiators: readonly Differentiator[],
): string {
  const shared = `${group.length} capabilit${group.length === 1 ? 'y' : 'ies'} share the noun "${root}"`;
  if (kind === 'core') {
    const differentiator = matchingDifferentiator(group, differentiators)!;
    return `${shared}; the requirements call this out on line ${differentiator.line} ("${differentiator.marker}"), so it is core`;
  }
  return `${shared}; no requirement calls it a differentiator and it matches no generic family, so it is supporting`;
}

// ---------------------------------------------------------------------------
// Context map
// ---------------------------------------------------------------------------

function buildContextMap(
  contexts: readonly BoundedContextPlan[],
  capabilities: readonly Capability[],
  criteria: readonly AcceptanceCriterion[],
): ContextEdge[] {
  const text = new Map(contexts.map((context) => [context.name, contextText(context, capabilities, criteria)]));
  const edges: ContextEdge[] = [];

  for (let i = 0; i < contexts.length; i += 1) {
    for (let j = i + 1; j < contexts.length; j += 1) {
      const a = contexts[i]!;
      const b = contexts[j]!;
      const aKnowsB = mentions(text.get(a.name)!, b.root);
      const bKnowsA = mentions(text.get(b.name)!, a.root);
      if (!aKnowsB && !bKnowsA) continue;

      const both = aKnowsB && bKnowsA;
      const upstream = both ? a : aKnowsB ? b : a;
      const downstream = both ? b : aKnowsB ? a : b;
      edges.push({
        upstream: upstream.name,
        downstream: downstream.name,
        relationship: relationshipFor(upstream.kind, downstream.kind, both),
        note: both
          ? `${a.name} and ${b.name} name each other's concepts, so neither model can move alone`
          : `${downstream.name} speaks about "${upstream.root}", which ${upstream.name} owns`,
      });
    }
  }
  return edges;
}

/** Team relationships, chosen from the ones the IR knows about. */
function relationshipFor(upstream: SubdomainKind, downstream: SubdomainKind, mutual: boolean): string {
  if (mutual) return 'partnership';
  if (upstream === 'generic') return 'conformist';
  if (upstream === 'core' && downstream === 'core') return 'partnership';
  if (upstream === 'core') return 'customer-supplier';
  return 'anti-corruption-layer';
}

function contextText(
  context: BoundedContextPlan,
  capabilities: readonly Capability[],
  criteria: readonly AcceptanceCriterion[],
): string {
  const mine = capabilities.filter((capability) => context.capabilities.includes(capability.id));
  const rules = criteria.filter((criterion) => criterion.capabilities.some((id) => context.capabilities.includes(id)));
  return [...mine.map((c) => `${c.name} ${c.object}`), ...rules.map((c) => c.text)].join(' ');
}

// ---------------------------------------------------------------------------
// Open questions
// ---------------------------------------------------------------------------

function report(state: ArchitectState, diagnostics: DiagnosticBag): void {
  const { contexts, subdomains } = state.architecture;
  const capabilities = state.explore.capabilities;
  const largest = [...contexts].sort((a, b) => b.capabilities.length - a.capabilities.length)[0];

  for (const subdomain of subdomains) {
    if (subdomain.kind !== 'supporting') continue;
    const first = capabilities.find((capability) => subdomain.capabilities.includes(capability.id))!;
    ask(state, diagnostics, {
      code: QUESTION_CODES.unclassifiedSubdomain,
      phase: 'architecture',
      line: first.line,
      ambiguity: `nothing in the requirements says whether ${subdomain.name} is what this business competes on.`,
      question: `Is ${subdomain.name} core (build it), supporting (build it plainly) or generic (buy it)?`,
      assumption: 'classified as a supporting subdomain',
      evidence: subdomain.reason,
    });
  }

  for (const context of contexts) {
    if (context.capabilities.length > 1 || contexts.length === 1) continue;
    const first = capabilities.find((capability) => context.capabilities.includes(capability.id))!;
    ask(state, diagnostics, {
      code: QUESTION_CODES.thinContext,
      phase: 'architecture',
      line: first.line,
      ambiguity: `${context.name} holds a single capability, so it may not deserve its own model.`,
      question: `Should ${context.name} stay a bounded context of its own, or move inside ${largest && largest.name !== context.name ? largest.name : 'a larger context'}?`,
      assumption: `kept as a separate bounded context and emitted as ${context.module}.ail`,
      evidence: first.name,
    });
  }
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = singular(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
