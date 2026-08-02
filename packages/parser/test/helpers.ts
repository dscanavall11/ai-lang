import { DiagnosticBag, formatDiagnostics, type IRModule } from '@ai-lang/core';
import { parseModule } from '../src/index.js';

export interface ParsedFixture {
  module: IRModule;
  diagnostics: DiagnosticBag;
  text: string;
}

/** Parses `source` and fails loudly if the parser reported an error. */
export function parseOk(source: string, path = 'test.ail'): ParsedFixture {
  const diagnostics = new DiagnosticBag();
  const { module } = parseModule(path, source, diagnostics);
  if (diagnostics.hasErrors || module === null) {
    throw new Error(`unexpected parse errors:\n${formatDiagnostics(diagnostics.items, new Map([[path, source]]))}`);
  }
  return { module, diagnostics, text: source };
}

/** Parses `source` expecting at least one error, and returns the codes reported. */
export function parseErrors(source: string, path = 'test.ail'): string[] {
  const diagnostics = new DiagnosticBag();
  parseModule(path, source, diagnostics);
  return diagnostics.errors.map((d) => d.code);
}

export function moduleHeader(body: string, extra = ''): string {
  return `---\nmodule: test\ncontext: Test\n${extra}---\n\n${body}\n`;
}
