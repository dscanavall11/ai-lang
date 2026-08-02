/** Source discovery, parsing and analysis — the front half of every command. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { DiagnosticBag, formatDiagnostics, type Diagnostic, type IRModule, type IRProject } from '@ai-lang/core';
import { parseModule } from '@ai-lang/parser';
import { analyze, type AnalyzeOptions } from '@ai-lang/analyzer';

export const SOURCE_EXTENSION = '.ail';

export interface LoadedProject {
  project: IRProject;
  diagnostics: Diagnostic[];
  sources: Map<string, string>;
  ok: boolean;
}

/** Collects every `.ail` file under the given files or directories. */
export function discoverSources(inputs: readonly string[], cwd: string): string[] {
  const roots = inputs.length > 0 ? inputs : ['.'];
  const found: string[] = [];

  for (const input of roots) {
    const absolute = resolve(cwd, input);
    let info;
    try {
      info = statSync(absolute);
    } catch {
      throw new Error(`no such file or directory: ${input}`);
    }
    if (info.isFile()) {
      found.push(absolute);
      continue;
    }
    walk(absolute, found);
  }
  return [...new Set(found)].sort();
}

function walk(directory: string, into: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walk(full, into);
    else if (entry.name.endsWith(SOURCE_EXTENSION)) into.push(full);
  }
}

export function loadProject(inputs: readonly string[], cwd: string, options: AnalyzeOptions = {}): LoadedProject {
  const files = discoverSources(inputs, cwd);
  if (files.length === 0) {
    throw new Error(`no ${SOURCE_EXTENSION} files found in ${inputs.join(', ') || cwd}`);
  }

  const bag = new DiagnosticBag();
  const sources = new Map<string, string>();
  const modules: IRModule[] = [];

  for (const absolute of files) {
    const display = relative(cwd, absolute).split(sep).join('/');
    const text = readFileSync(absolute, 'utf8');
    sources.set(display, text);
    const { module } = parseModule(display, text, bag);
    if (module) modules.push(module);
  }

  // A parse error leaves the module tree unreliable, so analysis is skipped.
  if (bag.hasErrors) {
    return { project: emptyProject(options), diagnostics: bag.items, sources, ok: false };
  }

  const result = analyze(modules, options);
  return {
    project: result.project,
    diagnostics: [...bag.items, ...result.diagnostics],
    sources,
    ok: result.ok,
  };
}

function emptyProject(options: AnalyzeOptions): IRProject {
  return {
    irVersion: '0.1',
    name: options.projectName ?? 'ai-lang-project',
    contexts: [],
    contextMap: [],
    modules: [],
    defaultTarget: options.defaultTarget ?? 'typescript',
  };
}

export function renderDiagnostics(loaded: LoadedProject): string {
  return formatDiagnostics(loaded.diagnostics, loaded.sources);
}
