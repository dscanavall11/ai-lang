/**
 * Code generator registry.
 *
 * `ail build --target <id>` looks the backend up here. Registering a new one is
 * the only change needed to support another language.
 */
import { Registry, type CodeGenerator, type GenerationContext, type GenerationResult } from '@ai-lang/core';
import { goGenerator } from './targets/go/index.js';
import { javaGenerator } from './targets/java/index.js';
import { pythonGenerator } from './targets/python/index.js';
import { rustGenerator } from './targets/rust/index.js';
import { typescriptGenerator } from './targets/typescript/index.js';

export const codeGenerators = new Registry<CodeGenerator>()
  .register(typescriptGenerator)
  .register(javaGenerator)
  .register(pythonGenerator)
  .register(goGenerator)
  .register(rustGenerator);

/** Runs a backend over every module plus its project-level files. */
export function generateProject(generator: CodeGenerator, context: GenerationContext): GenerationResult {
  const results: GenerationResult[] = [];
  for (const module of context.project.modules) results.push(generator.generate(module, context));
  if (generator.generateProject) results.push(generator.generateProject(context));
  return {
    files: results.flatMap((r) => r.files),
    diagnostics: results.flatMap((r) => r.diagnostics),
  };
}

export { LanguageEmitter, prefixReferences } from './shared/emitter.js';
export { ProjectLayout, relativeImport, type Layer } from './shared/layout.js';
export { typescriptGenerator } from './targets/typescript/index.js';
export { javaGenerator } from './targets/java/index.js';
export { pythonGenerator } from './targets/python/index.js';
export { goGenerator } from './targets/go/index.js';
export { rustGenerator } from './targets/rust/index.js';
