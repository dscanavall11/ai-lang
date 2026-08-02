/**
 * Symbol resolution.
 *
 * Every name used in a type position must resolve to a declaration in this
 * module, an imported module, or a built-in. Duplicates are reported once at the
 * second declaration so the first stays the anchor.
 */
import { referencedNames, type IRDeclaration, type SourceSpan } from '@ai-lang/core';
import type { AnalysisContext, SemanticPass } from '../context.js';
import { withSuggestion } from '../context.js';
import { typesReferencedBy } from '../walk.js';

export const symbolPass: SemanticPass = {
  id: 'symbols',
  stage: 'resolve',
  run(context) {
    reportDuplicates(context);
    reportUnresolvedTypes(context);
    reportImportsOfUnknownModules(context);
  },
};

function reportDuplicates(context: AnalysisContext): void {
  const seen = new Map<string, IRDeclaration>();
  for (const declaration of context.module.declarations) {
    const previous = seen.get(declaration.name);
    if (previous) {
      context.diagnostics.error(
        'resolve',
        'AIL2001',
        `"${declaration.name}" is declared twice in module ${context.module.name}`,
        declaration.span ?? spanOf(context),
        {
          hint: 'every declaration in a module needs a unique name',
          related: previous.span ? [{ message: `first declared as ${previous.kind}`, span: previous.span }] : [],
        },
      );
      continue;
    }
    seen.set(declaration.name, declaration);
  }
}

function reportUnresolvedTypes(context: AnalysisContext): void {
  const known = knownNames(context);
  for (const { type, span, where } of typesReferencedBy(context.module)) {
    for (const name of referencedNames(type)) {
      if (known.has(name)) continue;
      context.diagnostics.error('resolve', 'AIL2002', `unknown type "${name}" in ${where}`, span ?? spanOf(context), {
        hint:
          withSuggestion('', name, [...known]) ??
          'declare it in this module, or import the module that owns it in the frontmatter',
      });
    }
  }
}

function reportImportsOfUnknownModules(context: AnalysisContext): void {
  for (const entry of context.module.imports) {
    if (entry.module === context.module.name) {
      context.diagnostics.error('resolve', 'AIL2003', `module ${context.module.name} imports itself`, spanOf(context));
      continue;
    }
    const sibling = context.siblings.get(entry.module);
    if (!sibling) {
      context.diagnostics.error('resolve', 'AIL2004', `imported module "${entry.module}" was not found`, spanOf(context), {
        hint:
          withSuggestion('', entry.module, [...context.siblings.keys()]) ??
          'imports name other .ail modules compiled in the same project',
      });
      continue;
    }
    for (const name of entry.names) {
      if (!sibling.has(name)) {
        context.diagnostics.error(
          'resolve',
          'AIL2005',
          `module "${entry.module}" does not declare "${name}"`,
          spanOf(context),
          { hint: withSuggestion('', name, sibling.module.declarations.map((d) => d.name)) },
        );
      }
    }
  }
}

/** Declaration names visible from this module, including explicit imports. */
export function knownNames(context: AnalysisContext): Set<string> {
  const names = new Set<string>(context.module.declarations.map((d) => d.name));
  for (const entry of context.module.imports) {
    const sibling = context.siblings.get(entry.module);
    if (!sibling) continue;
    // An unqualified import exposes only the listed names; an empty list exposes
    // everything, which is only sensible through a shared kernel.
    const exposed = entry.names.length > 0 ? entry.names : sibling.module.declarations.map((d) => d.name);
    for (const name of exposed) names.add(name);
  }
  return names;
}

function spanOf(context: AnalysisContext): SourceSpan {
  const file = context.module.source?.file ?? '<unknown>';
  return { file, start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } };
}
