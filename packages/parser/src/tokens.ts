/**
 * Inline tokenizer.
 *
 * Splits the text of a single line into words, literals and punctuation. HADL
 * has no operator symbols apart from `=`, `.`, `,` and parentheses: everything
 * else is a word, which is what makes the surface syntax read as prose.
 */
import type { SourceSpan } from '@haic/core';
import type { Line, SourceFile } from './source.js';

export type TokenKind = 'word' | 'number' | 'string' | 'punct';

export interface Token {
  kind: TokenKind;
  /** Lower-cased for `word`; raw text otherwise. */
  value: string;
  /** Original text before case folding. */
  raw: string;
  /** Column offset within the line's trimmed text. */
  start: number;
  end: number;
}

const PUNCTUATION = new Set(['(', ')', ',', '.', '=', '{', '}', ':', '[', ']', '<', '>', '/', '*', '-', '+']);

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i += 1;
      let value = '';
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\' && i + 1 < text.length) {
          value += unescape(text[i + 1]!);
          i += 2;
          continue;
        }
        value += text[i];
        i += 1;
      }
      i += 1; // closing quote
      tokens.push({ kind: 'string', value, raw: text.slice(start, i), start, end: i });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const start = i;
      if (ch === '-') i += 1;
      while (i < text.length && /[0-9_]/.test(text[i]!)) i += 1;
      if (text[i] === '.' && /[0-9]/.test(text[i + 1] ?? '')) {
        i += 1;
        while (i < text.length && /[0-9_]/.test(text[i]!)) i += 1;
      }
      const raw = text.slice(start, i);
      tokens.push({ kind: 'number', value: raw.replace(/_/g, ''), raw, start, end: i });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i]!)) i += 1;
      const raw = text.slice(start, i);
      tokens.push({ kind: 'word', value: raw.toLowerCase(), raw, start, end: i });
      continue;
    }
    if (PUNCTUATION.has(ch)) {
      tokens.push({ kind: 'punct', value: ch, raw: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    // Unknown character: emit as punctuation so the parser can report it.
    tokens.push({ kind: 'punct', value: ch, raw: ch, start: i, end: i + 1 });
    i += 1;
  }
  return tokens;
}

function unescape(ch: string): string {
  switch (ch) {
    case 'n':
      return '\n';
    case 't':
      return '\t';
    case 'r':
      return '\r';
    default:
      return ch;
  }
}

/**
 * Words that always belong to the grammar, so they can never be swallowed into
 * an operation phrase. `by`, `of`, `to`, `from`, `for` and `in` are deliberately
 * absent: they read naturally inside phrases such as "find order by id".
 */
export const RESERVED_WORDS = new Set([
  'is',
  'are',
  'was',
  'not',
  'and',
  'or',
  'plus',
  'minus',
  'times',
  'divided',
  'equals',
  'contains',
  'starts',
  'ends',
  'matches',
  'with',
  'be',
  'then',
  'otherwise',
  'else',
  'true',
  'false',
  'yes',
  'no',
  'nothing',
  'null',
  'none',
  'now',
  'using',
  'carrying',
]);

/** Random-access cursor over the tokens of one line, with span reporting. */
export class TokenCursor {
  private position = 0;
  /**
   * Words the enclosing construct has claimed. `add item to items` pushes `to`
   * so that the value expression stops before the destination.
   */
  private readonly stopStack: Array<ReadonlySet<string>> = [];

  constructor(
    readonly tokens: Token[],
    readonly line: Line,
    readonly file: SourceFile,
  ) {}

  /** Runs `body` with `words` treated as terminators for phrase scanning. */
  withStops<T>(words: readonly string[], body: () => T): T {
    this.stopStack.push(new Set(words));
    try {
      return body();
    } finally {
      this.stopStack.pop();
    }
  }

  isStopWord(value: string): boolean {
    return this.stopStack.some((set) => set.has(value));
  }

  /** `true` when the token cannot continue an operation phrase. */
  breaksPhrase(token: Token | undefined): boolean {
    if (!token || token.kind !== 'word') return true;
    return RESERVED_WORDS.has(token.value) || this.isStopWord(token.value);
  }

  static forLine(file: SourceFile, line: Line): TokenCursor {
    return new TokenCursor(tokenize(line.text), line, file);
  }

  get atEnd(): boolean {
    return this.position >= this.tokens.length;
  }

  get index(): number {
    return this.position;
  }

  reset(index: number): void {
    this.position = index;
  }

  peek(lookahead = 0): Token | undefined {
    return this.tokens[this.position + lookahead];
  }

  next(): Token | undefined {
    return this.tokens[this.position++];
  }

  /** Consumes the next token when it is the given word (case-insensitive). */
  eatWord(...words: string[]): Token | null {
    const token = this.peek();
    if (token?.kind === 'word' && words.includes(token.value)) {
      this.position += 1;
      return token;
    }
    return null;
  }

  /** Consumes a whole word sequence, e.g. `eatPhrase('divided','by')`. */
  eatPhrase(...words: string[]): boolean {
    for (let i = 0; i < words.length; i += 1) {
      const token = this.peek(i);
      if (token?.kind !== 'word' || token.value !== words[i]) return false;
    }
    this.position += words.length;
    return true;
  }

  eatPunct(...values: string[]): Token | null {
    const token = this.peek();
    if (token?.kind === 'punct' && values.includes(token.value)) {
      this.position += 1;
      return token;
    }
    return null;
  }

  atWord(...words: string[]): boolean {
    const token = this.peek();
    return token?.kind === 'word' && words.includes(token.value);
  }

  atPunct(...values: string[]): boolean {
    const token = this.peek();
    return token?.kind === 'punct' && values.includes(token.value);
  }

  /** `true` when a bare word `value` occurs at or after the current position. */
  containsWordAhead(value: string): boolean {
    for (let i = this.position; i < this.tokens.length; i += 1) {
      if (this.tokens[i]!.kind === 'word' && this.tokens[i]!.value === value) return true;
    }
    return false;
  }

  spanOf(token: Token | undefined): SourceSpan {
    if (!token) return this.file.span(this.line, this.line.text.length, this.line.text.length);
    return this.file.span(this.line, token.start, token.end);
  }

  currentSpan(): SourceSpan {
    return this.spanOf(this.peek() ?? this.tokens[this.tokens.length - 1]);
  }

  /** Text from token `from` up to (excluding) the current position. */
  textBetween(from: number): string {
    const slice = this.tokens.slice(from, this.position);
    return slice.map((t) => t.raw).join(' ');
  }
}

export function isTypeName(token: Token | undefined): boolean {
  return token?.kind === 'word' && /^[A-Z]/.test(token.raw);
}

export function isIdentifier(token: Token | undefined): boolean {
  return token?.kind === 'word' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.raw);
}
