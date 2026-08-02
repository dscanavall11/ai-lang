import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { DiagnosticBag, formatDiagnostics, type GeneratedFile, type IRModule, type IRProject } from '@ai-lang/core';
import { parseModule } from '@ai-lang/parser';
import { analyze } from '@ai-lang/analyzer';

const EXAMPLES = ['examples/orders/orders.ail', 'examples/orders/catalog.ail'];

/** The orders example, parsed and analysed. Shared by every backend test. */
export function ordersProject(): IRProject {
  const bag = new DiagnosticBag();
  const sources = new Map<string, string>();
  const modules: IRModule[] = [];

  for (const path of EXAMPLES) {
    const text = readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');
    sources.set(path, text);
    const { module } = parseModule(path, text, bag);
    if (module) modules.push(module);
  }
  expect(formatDiagnostics(bag.errors, sources)).toBe('');

  const result = analyze(modules, { projectName: 'orders' });
  expect(formatDiagnostics(result.diagnostics.filter((d) => d.severity === 'error'), sources)).toBe('');
  return result.project;
}

export function fileNamed(files: readonly GeneratedFile[], path: string): GeneratedFile {
  const found = files.find((f) => f.path === path);
  if (!found) throw new Error(`no generated file at ${path}. Got:\n  ${files.map((f) => f.path).join('\n  ')}`);
  return found;
}

/** Every relative import in a generated file must resolve to another generated file. */
export function assertImportsResolve(files: readonly GeneratedFile[], extension: string): void {
  const known = new Set(files.map((f) => f.path));
  const unresolved: string[] = [];

  for (const generated of files) {
    if (!generated.path.endsWith(extension)) continue;
    for (const match of generated.contents.matchAll(/from '(\.[^']+)'/g)) {
      const specifier = match[1]!;
      const resolved = resolveRelative(generated.path, specifier).replace(/\.js$/, extension);
      if (!known.has(resolved)) unresolved.push(`${generated.path} -> ${specifier} (${resolved})`);
    }
  }
  expect(unresolved).toEqual([]);
}

function resolveRelative(from: string, specifier: string): string {
  const parts = from.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}
