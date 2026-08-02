/**
 * Deterministic English helpers.
 *
 * No dictionary, no model: only rules that can be read, argued with, and
 * replayed. Every function here is pure and total, so the same requirements
 * document always produces the same names.
 */
import { pascalCase, pluralize } from '@ai-lang/core';

/** Words that never carry domain meaning, so they never become nouns or names. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'our', 'their', 'its', 'his', 'her',
  'and', 'or', 'but', 'so', 'because', 'if', 'when', 'while', 'until', 'after', 'before', 'then',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'has', 'have', 'had', 'do', 'does', 'did', 'can', 'cannot', 'could', 'may', 'might', 'must',
  'shall', 'should', 'will', 'would', 'want', 'wants', 'wanted', 'need', 'needs', 'needed',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'without', 'into', 'over', 'under',
  'as', 'it', 'i', 'we', 'they', 'he', 'she', 'you', 'me', 'us', 'them', 'who', 'which', 'what',
  'not', 'no', 'never', 'always', 'again', 'more', 'most', 'less', 'least', 'than', 'same', 'other',
  'one', 'two', 'three', 'four', 'five', 'many', 'several', 'multiple', 'each', 'every', 'all',
  'only', 'also', 'still', 'already', 'per', 'via', 'about', 'up', 'down', 'out', 'off', 'too',
  'library', 'system', 'service', 'application', 'platform', 'user', 'users', 'team', 'business',
]);

/** Verbs that read as plural nouns; they must never be mistaken for a noun. */
const NOT_NOUNS: ReadonlySet<string> = new Set([
  'borrows', 'returns', 'needs', 'wants', 'gets', 'takes', 'makes', 'holds', 'owes', 'says',
  'means', 'keeps', 'gives', 'links', 'incurs', 'notices', 'costs', 'runs', 'lends',
]);

const IRREGULAR_PAST: Readonly<Record<string, string>> = {
  send: 'sent',
  lend: 'lent',
  buy: 'bought',
  pay: 'paid',
  make: 'made',
  find: 'found',
  take: 'taken',
  give: 'given',
  hold: 'held',
  keep: 'kept',
  lose: 'lost',
  put: 'put',
  read: 'read',
  set: 'set',
  build: 'built',
  leave: 'left',
  win: 'won',
  begin: 'begun',
  choose: 'chosen',
  write: 'written',
  draw: 'drawn',
  withdraw: 'withdrawn',
  see: 'seen',
  show: 'shown',
  run: 'run',
  get: 'got',
};

const IRREGULAR_SINGULAR: Readonly<Record<string, string>> = {
  people: 'person',
  children: 'child',
  men: 'man',
  women: 'woman',
  data: 'data',
  status: 'status',
  address: 'address',
  series: 'series',
};

/** Lower-cased alphanumeric words of a text. */
export function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? [];
}

export function contentWords(text: string): string[] {
  return words(text).filter((word) => !STOP_WORDS.has(word));
}

/** `copies` -> `copy`, `books` -> `book`, `status` -> `status`. */
export function singular(word: string): string {
  const lower = word.toLowerCase();
  const irregular = IRREGULAR_SINGULAR[lower];
  if (irregular) return irregular;
  if (/[^aeiou]ies$/.test(lower)) return `${lower.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(lower)) return lower;
  if (/(ch|sh|x|z|s)es$/.test(lower)) return lower.slice(0, -2);
  if (/s$/.test(lower)) return lower.slice(0, -1);
  return lower;
}

export function plural(word: string): string {
  return pluralize(singular(word));
}

/** `borrow` -> `borrowed`, `send` -> `sent`, `charge` -> `charged`. */
export function pastParticiple(verb: string): string {
  const lower = verb.toLowerCase();
  const irregular = IRREGULAR_PAST[lower];
  if (irregular) return irregular;
  if (lower.endsWith('e')) return `${lower}d`;
  if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ied`;
  return `${lower}ed`;
}

/** `true` when the word can stand for a thing rather than an action. */
export function isNounCandidate(word: string): boolean {
  return word.length > 2 && !STOP_WORDS.has(word) && !NOT_NOUNS.has(word);
}

/**
 * The noun a phrase is about. English compounds are head-final, so the head is
 * the last content word of the first noun phrase: "a shelf mark" is a mark, and
 * "a notification when a loan is overdue" is a notification.
 */
export function headNoun(phrase: string): string | null {
  const candidates = words(nounPhrase(phrase)).filter(isNounCandidate);
  const head = candidates[candidates.length - 1];
  return head ? singular(head) : null;
}

const PREPOSITION = /\b(to|of|from|for|in|on|with|at|by|into|about|until|per|over|under|after|before)\b/i;

/** The first noun phrase of a clause: everything before the first preposition. */
export function nounPhrase(phrase: string): string {
  const clause = mainClause(phrase);
  const match = PREPOSITION.exec(clause);
  return match ? clause.slice(0, match.index) : clause;
}

/** Drops everything from the first subordinating conjunction onwards. */
export function mainClause(phrase: string): string {
  const match = /\b(when|while|after|before|so that|so|if|that|which|until|unless)\b/i.exec(phrase);
  return match ? phrase.slice(0, match.index) : phrase;
}

/** The `when ...` clause of a phrase, without the conjunction. */
export function whenClause(phrase: string): string | null {
  const match = /\b(?:when|whenever|as soon as)\s+(.+)$/i.exec(phrase);
  if (!match) return null;
  return mainClause(match[1]!).trim().replace(/[.,;]$/, '') || null;
}

/** `true` when `text` mentions `noun` in singular or plural form. */
export function mentions(text: string, noun: string): boolean {
  const forms = new Set([singular(noun), plural(noun)]);
  return words(text).some((word) => forms.has(word) || forms.has(singular(word)));
}

/** Occurrences of a noun (either number) in a text. */
export function countMentions(text: string, noun: string): number {
  const forms = new Set([singular(noun), plural(noun)]);
  return words(text).filter((word) => forms.has(word) || forms.has(singular(word))).length;
}

/** Declaration-safe name: `shelf mark` -> `ShelfMark`. */
export function typeName(phrase: string): string {
  const name = pascalCase(phrase);
  return /^[A-Za-z]/.test(name) ? name : `T${name}`;
}

/** Field-safe name: `due date` -> `dueDate`. */
export function fieldName(phrase: string): string {
  const name = typeName(phrase);
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/** Route segment: `Book` -> `books`. */
export function routeName(noun: string): string {
  return plural(noun).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

export function kebab(phrase: string): string {
  return words(phrase).join('-');
}

/** First sentence of a text, used for one-line descriptions. */
export function firstSentence(text: string): string {
  const match = /^(.*?[.!?])(\s|$)/.exec(text.trim());
  return (match ? match[1]! : text.trim()).replace(/\s+/g, ' ');
}

/** Quotes a description for use inside an `invariant "..."` header. */
export function quoted(text: string): string {
  return `"${text.replace(/["\\]/g, '').replace(/\s+/g, ' ').trim()}"`;
}
