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

describe('the rule a block could otherwise walk around', () => {
  const withPort = `## port BasketRepository (outbound)
using in-memory

- find basket by id (id: uuid) -> Basket

`;

  it('says so when a block inside an aggregate names a port', () => {
    // HADL2213 reads statements. A block has none, so the rule that keeps I/O
    // out of the domain would simply stop applying where it matters most.
    const reported = check(
      withPort + basket('  ```typescript\n  const found = await basketRepository.findBasketById({ id: this.id });\n  return found.lines[0]!;\n  ```'),
    );
    const io = reported.find((diagnostic) => diagnostic.code === 'HADL2604');
    expect(io?.message).toContain('BasketRepository');
    expect(io?.severity).toBe('warning');
  });

  it('stays quiet when the block only touches the aggregate', () => {
    expect(codes(check(withPort + basket(NATIVE)))).not.toContain('HADL2604');
  });

  it('says nothing about a service, which is where a port belongs', () => {
    const source = `${withPort}## service BasketService
uses BasketRepository

operation total (id: uuid) -> decimal:
  \`\`\`typescript
  const found = await this.basketRepository.findBasketById({ id });
  return found.lines.length;
  \`\`\`
`;
    expect(codes(check(source + basket('  return 0')))).not.toContain('HADL2604');
  });
});

describe('a scenario over an operation with no HADL body', () => {
  const source = `---
module: test
context: Test
---

${basket(NATIVE)}

## scenario scoring a basket

given basket be Basket with id = "11111111-1111-4111-8111-111111111111", lines = [2]
when score with basket = basket
then result is 2
`;

  it('is deferred to the target, and says where it runs', () => {
    const bag = new DiagnosticBag();
    const { module } = parseModule('test.hadl', source, bag);
    expect(bag.errors).toEqual([]);
    const report = runScenarios([module!]);

    // Not a pass — nothing ran here. Not a failure either: `haic build`
    // compiles it into the generated project, where it runs against the block.
    expect(report.passed).toBe(0);
    expect(report.deferred).toBe(1);
    expect(report.results[0]!.outcome).toBe('deferred');
    expect(report.results[0]!.problems[0]).toContain('typescript');
    expect(report.ok).toBe(true);
    expect(indexModule(module!).aggregates[0]!.operations[0]!.native).toHaveLength(1);
  });

  it('stops HADL2602, because something does exercise the operation now', () => {
    // The warning means "nothing runs this". A scenario the backend compiles
    // is something running it, so repeating the warning would be false.
    expect(codes(check(source.split('---\n\n')[1]!))).not.toContain('HADL2602');
  });

  it('keeps warning when the scenario uses a value a generated test would refuse', () => {
    // `"b-1"` is fine for the interpreter and fine in TypeScript, and refused
    // by every backend that models a uuid as a uuid. A scenario the compiler
    // cannot compile faithfully does not count as exercising anything.
    const shortId = source.replace('11111111-1111-4111-8111-111111111111', 'b-1');
    expect(codes(check(shortId.split('---\n\n')[1]!))).toContain('HADL2602');
  });
});
