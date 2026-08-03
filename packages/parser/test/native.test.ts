import { describe, expect, it } from 'vitest';
import { indexModule, type IRAggregateDecl } from '@haic/core';
import { moduleHeader, parseErrors, parseOk } from './helpers.js';

/** An aggregate whose one operation carries whatever body the case is about. */
function withBody(body: string): string {
  return moduleHeader(
    `## aggregate Basket
identified by id

- id: uuid, required
- lines: list of decimal, required

invariant "a basket holds something":
  lines is not empty

operation score () -> decimal:
${body}
`,
  );
}

function operation(source: string) {
  const { module } = parseOk(source);
  return (indexModule(module).aggregates[0] as IRAggregateDecl).operations[0]!;
}

describe('fenced native blocks', () => {
  it('carries the code across verbatim, indentation and all', () => {
    const parsed = operation(
      withBody(`  \`\`\`typescript
  const sorted = [...this.lines].sort();
  if (sorted.length > 0) {
    return sorted[0]!;
  }
  return 0;
  \`\`\``),
    );

    expect(parsed.native).toHaveLength(1);
    expect(parsed.native[0]!.target).toBe('typescript');
    expect(parsed.native[0]!.code).toEqual([
      'const sorted = [...this.lines].sort();',
      'if (sorted.length > 0) {',
      '  return sorted[0]!;',
      '}',
      'return 0;',
    ]);
  });

  it('resolves the name on the fence to a backend', () => {
    const parsed = operation(withBody('  ```js\n  return 0;\n  ```'));
    expect(parsed.native[0]!.target).toBe('typescript');
    // The word as written survives, so a diagnostic can quote the source.
    expect(parsed.native[0]!.dialect).toBe('js');
  });

  it('accepts one block per target', () => {
    const parsed = operation(withBody('  ```ts\n  return 0;\n  ```\n\n  ```python\n  return 0\n  ```'));
    expect(parsed.native.map((n) => n.target)).toEqual(['typescript', 'python']);
  });

  it('keeps statements written beside a block', () => {
    const parsed = operation(withBody('  ```ts\n  return 0;\n  ```\n\n  return 1'));
    expect(parsed.native).toHaveLength(1);
    expect(parsed.body).toHaveLength(1);
  });

  it('accepts a tilde fence, as Markdown does', () => {
    const parsed = operation(withBody('  ~~~typescript\n  return 0;\n  ~~~'));
    expect(parsed.native[0]!.code).toEqual(['return 0;']);
  });

  it('refuses a fence that names no language', () => {
    expect(parseErrors(withBody('  ```\n  return 0;\n  ```'))).toContain('HADL1420');
  });

  it('refuses a language no backend can emit', () => {
    expect(parseErrors(withBody('  ```cobol\n  RETURN 0.\n  ```'))).toContain('HADL1421');
  });

  it('refuses an unterminated fence', () => {
    expect(parseErrors(withBody('  ```typescript\n  return 0;'))).toContain('HADL1422');
  });

  it('refuses two blocks that compile to the same backend', () => {
    expect(parseErrors(withBody('  ```ts\n  return 0;\n  ```\n\n  ```javascript\n  return 1;\n  ```'))).toContain('HADL1423');
  });

  it('says where a fence is allowed when one appears somewhere else', () => {
    const source = moduleHeader(
      `## event Woken
- id: uuid, required

## port Bell (outbound)
- ring (id: uuid) -> nothing

## handler WakeUp on Woken
uses Bell

do:
  \`\`\`typescript
  console.log('ring');
  \`\`\`
`,
    );
    expect(parseErrors(source)).toContain('HADL1424');
  });
});
