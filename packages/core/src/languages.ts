/**
 * The language names people actually type.
 *
 * `haic build --language js` has to mean something, and so does a fence opened
 * with ```js. Both resolve through this table, so the surface accepts the word a
 * reader would write while the compiler keeps speaking about exactly five
 * backends. `javascript` resolves to the TypeScript backend on purpose: that
 * backend emits Node.js, and TypeScript is the typed form of the language the
 * code is written in.
 */
import { CODEGEN_TARGETS, type CodegenTarget, type IRNativeBlock, type IROperation } from './ir/schema.js';

/** Every word accepted for a target, first entry being the canonical id. */
export const LANGUAGE_NAMES: Readonly<Record<CodegenTarget, readonly string[]>> = {
  typescript: ['typescript', 'ts', 'javascript', 'js', 'node', 'nodejs'],
  java: ['java', 'jvm'],
  python: ['python', 'py', 'python3'],
  go: ['go', 'golang'],
  rust: ['rust', 'rs'],
};

const BY_NAME = new Map<string, CodegenTarget>(
  CODEGEN_TARGETS.flatMap((target) => LANGUAGE_NAMES[target].map((name) => [name, target] as const)),
);

/** Resolves a written language word to the backend that owns it. */
export function resolveLanguage(word: string): CodegenTarget | null {
  return BY_NAME.get(word.trim().toLowerCase().replace(/^\./, '')) ?? null;
}

export function isLanguageName(word: string): boolean {
  return resolveLanguage(word) !== null;
}

/** Alternative spellings for a target, canonical id excluded. */
export function aliasesOf(target: CodegenTarget): readonly string[] {
  return LANGUAGE_NAMES[target].slice(1);
}

/** Every accepted spelling, sorted — used to list options in diagnostics. */
export function languageNames(): string[] {
  return [...BY_NAME.keys()].sort();
}

/** The block written for `target`, if this operation carries one. */
export function nativeFor(operation: Pick<IROperation, 'native'>, target: CodegenTarget): IRNativeBlock | null {
  return operation.native.find((block) => block.target === target) ?? null;
}

/**
 * What a backend should emit for an operation.
 *
 * `native` wins over `statements` for the target it names, because a block is
 * written precisely when the statements were not going to be good enough.
 * `missing` is the honest third case: an operation implemented only in another
 * language, which no backend can invent a body for.
 */
export type Implementation =
  | { kind: 'native'; block: IRNativeBlock }
  | { kind: 'statements' }
  | { kind: 'missing'; written: readonly CodegenTarget[] };

export function implementationFor(operation: Pick<IROperation, 'native' | 'body'>, target: CodegenTarget): Implementation {
  const block = nativeFor(operation, target);
  if (block) return { kind: 'native', block };
  if (operation.body.length > 0 || operation.native.length === 0) return { kind: 'statements' };
  return { kind: 'missing', written: operation.native.map((n) => n.target) };
}
