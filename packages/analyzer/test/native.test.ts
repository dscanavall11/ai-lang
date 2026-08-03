import { describe, expect, it } from 'vitest';
import { DiagnosticBag, indexModule } from '@haic/core';
import { parseModule } from '@haic/parser';
import { analyze, runScenarios } from '../src/index.js';
import { check, codes } from './helpers.js';

/** An aggregate whose one operation carries whatever body the case is about. */
function basket(body: string, extra = ''): string {
  return `## aggregate Basket
identified by id

- id: uuid, required
- lines: list of decimal, required

invariant "a basket holds something":
  lines is not empty

operation score () -> decimal:
${body}
${extra}`;
}

const NATIVE = '  ```typescript\n  return this.lines[0]!;\n  ```';

describe('operations written in another language', () => {
  it('says which operations no scenario can reach', () => {
    const reported = check(basket(NATIVE));
    expect(codes(reported)).toContain('HADL2602');
    expect(reported.find((d) => d.code === 'HADL2602')?.message).toContain('Basket.score');
  });

  it('stays quiet when statements are written beside the block', () => {
    expect(codes(check(basket(`${NATIVE}\n\n  return 0`)))).not.toContain('HADL2602');
  });

  it('reports a fence with nothing inside it', () => {
    expect(codes(check(basket('  ```typescript\n  ```')))).toContain('HADL2601');
  });

  it('warns when the module targets a language the operation was not written for', () => {
    const source = `---\nmodule: test\ncontext: Test\ntarget: go\n---\n\n${basket(NATIVE)}`;
    const bag = new DiagnosticBag();
    const { module } = parseModule('test.hadl', source, bag);
    expect(bag.errors).toEqual([]);
    expect(codes(analyze([module!], { projectName: 'test' }).diagnostics)).toContain('HADL2603');
  });

  it('counts a name used only inside a block as used', () => {
    // `lines` is read by the block and by nothing else. The compiler cannot
    // parse the block, so it takes the word appearing there as a mention.
    expect(codes(check(basket(NATIVE)))).not.toContain('HADL2505');
  });

  it('promotes its warnings to errors under --strict', () => {
    const strict = check(basket(NATIVE), { strict: true });
    expect(strict.some((d) => d.code === 'HADL2602' && d.severity === 'error')).toBe(true);
  });
});

describe('scenarios over an operation with no HADL body', () => {
  const source = `---
module: test
context: Test
---

${basket(NATIVE)}

## scenario scoring a basket

given basket be Basket with id = "b-1", lines = [2]
when score with basket = basket
then result is 2
`;

  it('is inconclusive, never a pass', () => {
    const bag = new DiagnosticBag();
    const { module } = parseModule('test.hadl', source, bag);
    expect(bag.errors).toEqual([]);
    const report = runScenarios([module!]);

    expect(report.ok).toBe(false);
    expect(report.inconclusive).toBe(1);
    expect(report.results[0]!.problems[0]).toContain('typescript');
    expect(indexModule(module!).aggregates[0]!.operations[0]!.native).toHaveLength(1);
  });
});
