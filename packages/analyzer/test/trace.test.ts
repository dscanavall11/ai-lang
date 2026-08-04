/**
 * The trace is the debugger. What it has to get right is the sequence: which
 * branch, which value, which port — in the order they happened.
 */
import { describe, expect, it } from 'vitest';
import { DiagnosticBag } from '@haic/core';
import { parseModule } from '@haic/parser';
import { renderTrace, runScenarios } from '../src/index.js';

const SOURCE = `---
module: test
context: Test
---

# Test

## aggregate Counter
identified by id

- id: uuid, required
- hits: integer, required, default 0

invariant "a counter never goes backwards":
  hits is at least 0

operation bump (by: integer) -> integer:
  when by is at most 0:
    return hits
  set hits to hits plus by
  return hits

## scenario bumping a counter

given counter be Counter with id = "11111111-1111-4111-8111-111111111111", hits = 1
when bump with counter = counter, by = 2
then result is 3

## scenario bumping by nothing leaves it alone

given counter be Counter with id = "11111111-1111-4111-8111-111111111111", hits = 1
when bump with counter = counter, by = 0
then result is 1
`;

function run(source = SOURCE, options = {}) {
  const bag = new DiagnosticBag();
  const { module } = parseModule('test.hadl', source, bag);
  expect(bag.errors).toEqual([]);
  return runScenarios([module!], options);
}

describe('the trace', () => {
  it('is kept only when asked for', () => {
    expect(run().results[0]!.trace).toEqual([]);
    expect(run(SOURCE, { trace: true }).results[0]!.trace.length).toBeGreaterThan(0);
  });

  it('records the call, the branch it took and what it returned', () => {
    const steps = run(SOURCE, { trace: true }).results[0]!.trace;
    expect(steps.map((step) => step.kind)).toEqual(['call', 'branch', 'set', 'return']);
    expect(steps[0]!.detail).toBe('bump(counter = Counter with id = "11111111-1111-4111-8111-111111111111", hits = 1, by = 2)');
    expect(steps[1]!.detail).toBe('when: no');
    expect(steps[2]!.detail).toBe('hits = 3');
    expect(steps[3]!.detail).toBe('3');
  });

  it('shows the other branch when the other branch is taken', () => {
    const steps = run(SOURCE, { trace: true }).results[1]!.trace;
    expect(steps.find((step) => step.kind === 'branch')!.detail).toBe('when: yes');
    expect(steps.some((step) => step.kind === 'set')).toBe(false);
  });

  it('is kept for a failing scenario whether or not it was asked for', () => {
    // The step before a failure is the question being asked, so it is never
    // something you have to re-run the command to see.
    const failing = SOURCE.replace('then result is 3', 'then result is 4');
    const result = run(failing).results[0]!;
    expect(result.outcome).toBe('failed');
    expect(result.trace.length).toBeGreaterThan(0);
  });

  it('indents a nested call under the one that made it', () => {
    const rendered = renderTrace([
      { kind: 'call', depth: 0, detail: 'place order()' },
      { kind: 'call', depth: 1, detail: 'compute total()' },
      { kind: 'return', depth: 1, detail: '40' },
    ]);
    expect(rendered[0]).toBe('    → place order()');
    expect(rendered[1]).toBe('      → compute total()');
    expect(rendered[2]).toBe('      ← 40');
  });

  it('shortens a value rather than filling the screen with it', () => {
    const wide = SOURCE.replace('- hits: integer, required, default 0', '- hits: integer, required, default 0\n- label: text, optional');
    const steps = run(wide.replace('hits = 1', 'hits = 1, label = "' + 'x'.repeat(200) + '"'), { trace: true }).results[0]!.trace;
    for (const step of steps) expect(step.detail.length).toBeLessThan(160);
  });
});
