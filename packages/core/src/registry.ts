/**
 * Generator registry.
 *
 * Adding a new language or a new deployment platform means registering another
 * implementation of these interfaces — no existing file changes. This is the
 * open/closed seam of the whole compiler.
 */
import type { Diagnostic } from './diagnostics.js';
import type { GeneratedFile } from './emit.js';
import type { IRModule, IRProject } from './ir/schema.js';

export interface GenerationContext {
  project: IRProject;
  /** Output root, relative paths in `GeneratedFile` are resolved against it. */
  outputDir: string;
  /** Options forwarded from the CLI, e.g. `{ packageName: "com.acme.orders" }`. */
  options: Readonly<Record<string, string | number | boolean>>;
}

export interface GenerationResult {
  files: GeneratedFile[];
  diagnostics: Diagnostic[];
}

export interface CodeGenerator {
  /** Stable id used on the command line: `haic build --target java`. */
  readonly id: string;
  readonly displayName: string;
  /** Framework the generated project is built on, shown in `haic targets`. */
  readonly framework: string;
  /** Toolchain command used to verify the generated project, if available. */
  readonly verifyCommand?: readonly string[];
  generate(module: IRModule, context: GenerationContext): GenerationResult;
  /** Files emitted once per project rather than per module (build files, entrypoint). */
  generateProject?(context: GenerationContext): GenerationResult;
}

export interface InfrastructureGenerator {
  readonly id: string;
  readonly displayName: string;
  readonly verifyCommand?: readonly string[];
  generate(context: GenerationContext): GenerationResult;
}

export class Registry<T extends { id: string }> {
  private readonly items = new Map<string, T>();

  register(item: T): this {
    if (this.items.has(item.id)) throw new Error(`duplicate registration for "${item.id}"`);
    this.items.set(item.id, item);
    return this;
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  require(id: string): T {
    const item = this.items.get(id);
    if (!item) throw new Error(`unknown target "${id}". Available: ${this.ids().join(', ')}`);
    return item;
  }

  ids(): string[] {
    return [...this.items.keys()].sort();
  }

  all(): T[] {
    return [...this.items.values()];
  }
}

export function emptyResult(): GenerationResult {
  return { files: [], diagnostics: [] };
}

export function mergeResults(...results: GenerationResult[]): GenerationResult {
  return {
    files: results.flatMap((r) => r.files),
    diagnostics: results.flatMap((r) => r.diagnostics),
  };
}
