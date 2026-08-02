/**
 * The editor grammar has to agree with the parser.
 *
 * A TextMate grammar is a second, independent description of the same language,
 * and the usual fate of such a thing is to drift: a keyword is added to the
 * parser, the highlighting quietly stops recognising it, and nobody notices
 * because nothing fails. These tests fail instead.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultDeclarationRegistry } from '../src/module-parser.js';
import { RESERVED_WORDS } from '../src/tokens.js';

const grammar = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../editors/vscode/syntaxes/ail.tmLanguage.json', import.meta.url)), 'utf8'),
) as {
  repository: Record<string, { match?: string; patterns?: Array<{ match?: string }> }>;
};

const rule = (name: string): RegExp => new RegExp(grammar.repository[name]?.match ?? '(?!)');

/** Words the grammar treats as language, whichever rule claims them. */
function highlightsWord(word: string): boolean {
  const alternatives = [rule('operator'), rule('constant'), rule('clause'), rule('statement')];
  return alternatives.some((pattern) => pattern.test(` ${word} `));
}

describe('the editor grammar', () => {
  it('compiles every pattern it declares', () => {
    const broken: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if ((key === 'match' || key === 'begin' || key === 'end') && typeof value === 'string') {
          try {
            new RegExp(value);
          } catch {
            broken.push(value);
          }
        } else walk(value);
      }
    };
    walk(grammar);
    expect(broken).toEqual([]);
  });

  it('resolves every rule it includes', () => {
    const known = new Set(Object.keys(grammar.repository));
    const dangling: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'include' && typeof value === 'string' && value.startsWith('#')) {
          if (!known.has(value.slice(1))) dangling.push(value);
        } else walk(value);
      }
    };
    walk(grammar);
    expect(dangling).toEqual([]);
  });

  it('highlights every declaration the parser accepts', () => {
    const declaration = rule('declaration');
    const keywords = [...defaultDeclarationRegistry().keywords(), 'infrastructure', 'infra', 'glossary'];
    const unhighlighted = keywords.filter((keyword) => !declaration.test(`## ${keyword} Something`));
    expect(unhighlighted).toEqual([]);
  });

  it('highlights every word the lexer reserves', () => {
    // `divided` only ever appears as `divided by`, which the operator rule spells out.
    const unhighlighted = [...RESERVED_WORDS].filter((word) => word !== 'divided' && !highlightsWord(word));
    expect(unhighlighted).toEqual([]);
  });
});
