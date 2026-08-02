import { expect } from 'vitest';
import { DiagnosticBag, formatDiagnostics, type Diagnostic, type IRModule } from '@ai-lang/core';
import { parseModule } from '@ai-lang/parser';
import { analyze, type AnalyzeOptions } from '../src/index.js';

/** Parses and analyses one module, failing loudly on a parse error. */
export function check(body: string, options: AnalyzeOptions = {}): Diagnostic[] {
  const source = `---\nmodule: test\ncontext: Test\n---\n\n${body}`;
  const bag = new DiagnosticBag();
  const { module } = parseModule('test.ail', source, bag);
  if (bag.hasErrors || !module) {
    throw new Error(`unexpected parse errors:\n${formatDiagnostics(bag.items, new Map([['test.ail', source]]))}`);
  }
  return analyze([module], { projectName: 'test', ...options }).diagnostics;
}

export function checkModules(sources: readonly string[], options: AnalyzeOptions = {}): Diagnostic[] {
  const bag = new DiagnosticBag();
  const modules: IRModule[] = [];
  sources.forEach((source, i) => {
    const { module } = parseModule(`test${i}.ail`, source, bag);
    if (module) modules.push(module);
  });
  expect(bag.errors).toEqual([]);
  return analyze(modules, { projectName: 'test', ...options }).diagnostics;
}

export function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

export function errorCodes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
}

/** A minimal aggregate, so each fixture only has to show the rule under test. */
export const ORDER = `## aggregate Order
identified by id
- id: uuid, required
- label: text, required

invariant "an order always carries a label":
  label is not empty
`;
