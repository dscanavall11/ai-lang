import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DiagnosticBag, formatDiagnostics, type IRModule } from '@ai-lang/core';
import { parseModule } from '@ai-lang/parser';
import { analyze } from '../src/index.js';

const FILES = ['examples/orders/orders.ail', 'examples/orders/catalog.ail'];

const sources = new Map(
  FILES.map((path) => [path, readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8')]),
);

function analyzeExample() {
  const bag = new DiagnosticBag();
  const modules: IRModule[] = [];
  for (const [path, text] of sources) {
    const { module } = parseModule(path, text, bag);
    if (module) modules.push(module);
  }
  expect(formatDiagnostics(bag.errors, sources)).toBe('');
  return analyze(modules, { projectName: 'orders' });
}

describe('analyzing the orders example', () => {
  const result = analyzeExample();

  it('reports no errors', () => {
    expect(formatDiagnostics(result.diagnostics.filter((d) => d.severity === 'error'), sources)).toBe('');
    expect(result.ok).toBe(true);
  });

  it('derives the bounded contexts from the modules', () => {
    expect(result.project.contexts).toEqual([
      { name: 'Sales', kind: 'core', modules: ['orders'], target: 'java' },
      { name: 'Catalogue', kind: 'core', modules: ['catalog'], target: 'python' },
    ]);
  });

  it('derives the context map from the imports', () => {
    expect(result.project.contextMap).toEqual([
      { upstream: 'Catalogue', downstream: 'Sales', relationship: 'anti-corruption-layer' },
    ]);
  });

  it('produces IR that round-trips through JSON', () => {
    expect(JSON.parse(JSON.stringify(result.project))).toEqual(result.project);
  });
});
