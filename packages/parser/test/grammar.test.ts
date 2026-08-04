/**
 * The editor grammar has to agree with the parser.
 *
 * A TextMate grammar is a second, independent description of the same language,
 * and the usual fate of such a thing is to drift: a keyword is added to the
 * parser, the highlighting quietly stops recognising it, and nobody notices
 * because nothing fails. These tests fail instead.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultDeclarationRegistry } from '../src/module-parser.js';
import { RESERVED_WORDS } from '../src/tokens.js';

const grammar = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../editors/vscode/syntaxes/hadl.tmLanguage.json', import.meta.url)), 'utf8'),
) as {
  repository: Record<string, { match?: string; patterns?: Array<{ match?: string }> }>;
};

const rule = (name: string): RegExp => new RegExp(grammar.repository[name]?.match ?? '(?!)');

/** Words the grammar treats as language, whichever rule claims them. */
function highlightsWord(word: string): boolean {
  const alternatives = [rule('operator'), rule('constant'), rule('clause'), rule('statement')];
  return alternatives.some((pattern) => pattern.test(` ${word} `));
}

describe('the editor manifest', () => {
  // A rename that moves a file but not the reference to it leaves an extension
  // that installs and silently does nothing. That is how snippets/hadl.json
  // came to point at a file called snippets/ail.json.
  it('references only files that exist', () => {
    const root = new URL('../../../editors/vscode/', import.meta.url);
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('package.json', root)), 'utf8')) as {
      main?: string;
      contributes: {
        languages?: Array<{ configuration?: string }>;
        grammars?: Array<{ path: string }>;
        snippets?: Array<{ path: string }>;
      };
    };

    const referenced = [
      // `main` is the language-server client. A manifest that points at a file
      // which is not there activates into nothing, in silence.
      manifest.main,
      ...(manifest.contributes.languages ?? []).map((l) => l.configuration),
      ...(manifest.contributes.grammars ?? []).map((g) => g.path),
      ...(manifest.contributes.snippets ?? []).map((s) => s.path),
    ].filter((path): path is string => typeof path === 'string');

    expect(referenced.length).toBeGreaterThan(0);
    const missing = referenced.filter((path) => !existsSync(fileURLToPath(new URL(path, root))));
    expect(missing).toEqual([]);
  });
});

describe('the editor client', () => {
  const root = new URL('../../../editors/vscode/', import.meta.url);

  it('reads only settings the manifest declares', () => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('package.json', root)), 'utf8')) as {
      contributes: { configuration?: { properties: Record<string, unknown> } };
    };
    const client = readFileSync(fileURLToPath(new URL('client.js', root)), 'utf8');
    const declared = Object.keys(manifest.contributes.configuration?.properties ?? {});

    // `getConfiguration('hadl').get('server.command')` reads `hadl.server.command`.
    const read = [...client.matchAll(/getConfiguration\('([\w.]+)'\)\.get\('([\w.]+)'\)/g)].map(
      (match) => `${match[1]}.${match[2]}`,
    );
    expect(read.length).toBeGreaterThan(0);
    expect(read.filter((setting) => !declared.includes(setting))).toEqual([]);
  });

  it('launches the compiler rather than a copy of it', () => {
    const client = readFileSync(fileURLToPath(new URL('client.js', root)), 'utf8');
    expect(client).toContain("args: ['lsp']");
  });
});

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
