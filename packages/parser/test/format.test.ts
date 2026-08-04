/**
 * A formatter for a whitespace-sensitive language needs one guarantee above all
 * others: that it did not change the program. Everything cosmetic below is only
 * safe because the last two suites hold.
 */
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DiagnosticBag, formatDiagnostics, type IRModule } from '@haic/core';
import { formatSource, isFormatted, parseModule } from '../src/index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Every `.hadl` file in the repository, which is every one anybody reads. */
const examples = readdirSync(join(repoRoot, 'examples'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) =>
    readdirSync(join(repoRoot, 'examples', entry.name))
      .filter((file) => file.endsWith('.hadl'))
      .map((file) => `examples/${entry.name}/${file}`),
  )
  .sort();

function ir(text: string, path: string): IRModule {
  const bag = new DiagnosticBag();
  const { module } = parseModule(path, text, bag);
  expect(formatDiagnostics(bag.errors, new Map([[path, text]]))).toBe('');
  return module!;
}

/** Spans move when lines do; everything else must be identical. */
function withoutSpans(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSpans);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'span' && key !== 'source')
      .map(([key, inner]) => [key, withoutSpans(inner)]),
  );
}

describe('formatting an example', () => {
  it.each(examples)('does not change what %s means', (path) => {
    const text = readFileSync(join(repoRoot, path), 'utf8');
    expect(withoutSpans(ir(formatSource(text), path))).toEqual(withoutSpans(ir(text, path)));
  });

  it.each(examples)('leaves %s alone, because it is already formatted', (path) => {
    // The examples are what the formatter is documenting. If one of them is not
    // in canonical form, either the example or the formatter is wrong.
    expect(isFormatted(readFileSync(join(repoRoot, path), 'utf8'))).toBe(true);
  });
});

describe('the formatter', () => {
  const messy = `---
module:   probe
context : Probe
imports:
  -   catalog via anti-corruption-layer
---
#    Probe



##   value object   Money
- amount:decimal,required , min 0
- currency :text,required,length 3     // ISO 4217 code
## aggregate Basket
identified by id

- id: uuid, required
- lines: list of decimal, required

invariant "a basket holds something":
      lines is not empty

operation score () -> decimal:
      when lines is empty:
            return 0
      return 1
`;

  const formatted = formatSource(messy);

  it('is idempotent', () => {
    expect(formatSource(formatted)).toBe(formatted);
  });

  it('normalises the frontmatter', () => {
    expect(formatted).toContain('module: probe\ncontext: Probe\nimports:\n  - catalog via anti-corruption-layer\n');
  });

  it('normalises headings and the space around them', () => {
    expect(formatted).toContain('# Probe\n\n## value object Money');
    expect(formatted).toContain('\n\n## aggregate Basket');
  });

  it('normalises a field bullet without touching its inline comment', () => {
    expect(formatted).toContain('- amount: decimal, required, min 0');
    expect(formatted).toContain('- currency: text, required, length 3     // ISO 4217 code');
  });

  it('re-indents a body to two spaces per level, keeping the nesting', () => {
    expect(formatted).toContain('operation score () -> decimal:\n  when lines is empty:\n    return 0\n  return 1\n');
  });

  it('ends with exactly one newline', () => {
    expect(formatted.endsWith('1\n')).toBe(true);
  });

  it('keeps the line endings the file already used', () => {
    const windows = '---\r\nmodule: p\r\n---\r\n\r\n## dto A\r\n- x: text, required\r\n';
    expect(formatSource(windows)).toBe(windows);
    expect(formatSource(windows.replace(/\r\n/g, '\n'))).not.toContain('\r');
  });

  it('leaves an expression alone, even a badly spaced one', () => {
    // Layout is the formatter's business. What an expression says is not.
    const source = '---\nmodule: p\n---\n\n## aggregate A\nidentified by id\n\n- id: uuid, required\n\ninvariant "x":\n  a is    not  b\n';
    expect(formatSource(source)).toContain('  a is    not  b');
  });
});

describe('a fenced block', () => {
  const source = `---
module: probe
---

# Probe

## aggregate Basket
identified by id

- id: uuid, required
- lines: list of decimal, required

invariant "a basket holds something":
  lines is not empty

operation score () -> decimal:
        \`\`\`typescript
        const sorted = [...this.lines].sort();
        if (sorted.length > 0) {
          return sorted[0]!;
        }
        return 0;
        \`\`\`
`;

  it('moves as one piece, keeping its own indentation', () => {
    expect(formatSource(source)).toContain(
      [
        'operation score () -> decimal:',
        '  ```typescript',
        '  const sorted = [...this.lines].sort();',
        '  if (sorted.length > 0) {',
        '    return sorted[0]!;',
        '  }',
        '  return 0;',
        '  ```',
      ].join('\n'),
    );
  });

  it('keeps the code inside byte for byte, once the shift is taken off', () => {
    const before = ir(source, 'probe.hadl');
    const after = ir(formatSource(source), 'probe.hadl');
    const codeOf = (module: IRModule): string[] =>
      module.declarations.flatMap((d) => ('operations' in d ? d.operations.flatMap((o) => o.native.flatMap((n) => n.code)) : []));
    expect(codeOf(after)).toEqual(codeOf(before));
    expect(codeOf(after)).toHaveLength(5);
  });

  it('gives up rather than mangle a block it cannot outdent', () => {
    // The fence sits at four spaces, but a line inside starts at column zero.
    // Shifting the block left would eat that line's first characters.
    const risky = source.replace('        const sorted', 'const sorted');
    expect(formatSource(risky)).toContain('\nconst sorted');
  });
});
