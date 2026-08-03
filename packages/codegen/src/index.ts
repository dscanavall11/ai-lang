/**
 * Code generator registry.
 *
 * `haic build --language <name>` looks the backend up here, through the name
 * table in core. Registering a new generator is the only change needed to
 * support another language.
 */
import {
  implementationFor,
  unknownSpan,
  type CodeGenerator,
  type CodegenTarget,
  type Diagnostic,
  type GenerationContext,
  type GenerationResult,
  type IRDeclaration,
  type IRModule,
  type IROperation,
  Registry,
} from '@haic/core';
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
    diagnostics: [...missingImplementations(context.project.modules, generator.id as CodegenTarget), ...results.flatMap((r) => r.diagnostics)],
  };
}

/**
 * Operations this backend has no body for.
 *
 * An operation written only as a `python` block cannot be compiled to Go, and
 * the honest moment to say so is before any file is written — a generated
 * project with a hole in it looks finished until it is run.
 */
export function missingImplementations(modules: readonly IRModule[], target: CodegenTarget): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const module of modules) {
    for (const declaration of module.declarations) {
      for (const operation of operationsOf(declaration)) {
        const chosen = implementationFor(operation, target);
        if (chosen.kind !== 'missing') continue;
        diagnostics.push({
          severity: 'error',
          stage: 'codegen',
          code: 'HADL3060',
          message: `${declaration.name}.${operation.phrase} has no body for ${target}`,
          span: operation.span ?? declaration.span ?? unknownSpan(module.source?.file),
          hint: `it is written for ${chosen.written.join(', ')}; add a ${target} block, add HADL statements, or build with "--language ${chosen.written[0]}"`,
        });
      }
    }
  }
  return diagnostics;
}

function operationsOf(declaration: IRDeclaration): readonly IROperation[] {
  switch (declaration.kind) {
    case 'aggregate':
    case 'service':
    case 'adapter':
      return declaration.operations;
    default:
      return [];
  }
}

export { LanguageEmitter, prefixReferences } from './shared/emitter.js';
export { ProjectLayout, relativeImport, type Layer } from './shared/layout.js';
export { typescriptGenerator } from './targets/typescript/index.js';
export { javaGenerator } from './targets/java/index.js';
export { pythonGenerator } from './targets/python/index.js';
export { goGenerator } from './targets/go/index.js';
export { rustGenerator } from './targets/rust/index.js';
