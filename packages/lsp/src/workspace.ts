/**
 * Everything the server knows about the project on disk and in the editor.
 *
 * A HADL module is small and the whole analysis is a few milliseconds, so this
 * re-parses and re-analyses the world on every keystroke rather than keeping an
 * incremental cache. The cache is the thing that goes stale and starts lying
 * about which names exist; the honest version is fast enough.
 *
 * Every file is analysed together, never one at a time, because the rules that
 * matter most are cross-module: an aggregate embedded from another context, a
 * port with no adapter, an import that crosses a boundary it should not.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DiagnosticBag, type Diagnostic, type IRModule, type IRProject } from '@haic/core';
import { parseModule } from '@haic/parser';
import { analyze } from '@haic/analyzer';

export const SOURCE_EXTENSION = '.hadl';

export interface Snapshot {
  /** Diagnostics for every known file, including the ones with none. */
  diagnostics: Map<string, Diagnostic[]>;
  modules: Map<string, IRModule>;
  project: IRProject;
}

export class Workspace {
  /** Path to text. An open editor buffer always wins over what is on disk. */
  private readonly disk = new Map<string, string>();
  private readonly open = new Map<string, string>();

  /** Reads every `.hadl` file under `directory` into the background set. */
  addRoot(directory: string): void {
    for (const path of discover(directory)) {
      try {
        this.disk.set(path, readFileSync(path, 'utf8'));
      } catch {
        // A file that vanished between listing and reading is not an error
        // worth reporting to an editor; the next change re-reads it anyway.
      }
    }
  }

  openDocument(path: string, text: string): void {
    this.open.set(path, text);
  }

  updateDocument(path: string, text: string): void {
    this.open.set(path, text);
  }

  /** The buffer is gone, so the file on disk is the truth again. */
  closeDocument(path: string): void {
    this.open.delete(path);
    try {
      this.disk.set(path, readFileSync(path, 'utf8'));
    } catch {
      this.disk.delete(path);
    }
  }

  textOf(path: string): string | undefined {
    return this.open.get(path) ?? this.disk.get(path);
  }

  paths(): string[] {
    return [...new Set([...this.disk.keys(), ...this.open.keys()])].sort();
  }

  /** Parses and analyses everything known, and files the results by path. */
  analyse(): Snapshot {
    const bag = new DiagnosticBag();
    const modules = new Map<string, IRModule>();

    for (const path of this.paths()) {
      const text = this.textOf(path);
      if (text === undefined) continue;
      const { module } = parseModule(path, text, bag);
      if (module) modules.set(path, module);
    }

    // Semantic analysis assumes a tree it can trust, so a parse error anywhere
    // stops it — exactly as `haic check` does, and for the same reason.
    const result = bag.hasErrors
      ? { diagnostics: bag.items, project: emptyProject() }
      : (() => {
          const analysed = analyze([...modules.values()], { projectName: 'workspace' });
          return { diagnostics: [...bag.items, ...analysed.diagnostics], project: analysed.project };
        })();

    const diagnostics = new Map<string, Diagnostic[]>();
    for (const path of this.paths()) diagnostics.set(path, []);
    for (const diagnostic of result.diagnostics) {
      const bucket = diagnostics.get(diagnostic.span.file);
      if (bucket) bucket.push(diagnostic);
      else diagnostics.set(diagnostic.span.file, [diagnostic]);
    }

    return { diagnostics, modules, project: result.project };
  }
}

function emptyProject(): IRProject {
  return { irVersion: '0.1', name: 'workspace', contexts: [], contextMap: [], modules: [], defaultTarget: 'typescript' };
}

function discover(directory: string, into: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return into;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(directory, entry.name);
    // `withFileTypes` reports a symlink as neither, so ask when it says neither.
    const directoryEntry = entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(full));
    if (directoryEntry) discover(full, into);
    else if (entry.name.endsWith(SOURCE_EXTENSION)) into.push(full);
  }
  return into;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
