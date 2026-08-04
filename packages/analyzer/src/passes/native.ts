/**
 * What the compiler still owns when an operation is written in another language.
 *
 * A native block is a hole cut in the abstraction on purpose, and a hole is only
 * safe while everyone can see where its edges are. The rules here draw those
 * edges: an operation that only exists in one language cannot be run by
 * `haic test`, cannot be compiled for the other targets, and cannot be the place
 * where the design quietly moves out of the design file.
 *
 * None of this inspects the code inside the fence. The compiler does not parse
 * it, does not type it, and does not pretend to; it reports what it can know
 * from the outside, which is who has a body and who does not.
 */
import { nativeFor, type CodegenTarget, type IRDeclaration, type IROperation, type SourceSpan } from '@haic/core';
import type { AnalysisContext, SemanticPass } from '../context.js';

export const nativePass: SemanticPass = {
  id: 'native',
  stage: 'codegen',
  run(context) {
    const declared = context.module.target ?? context.project.defaultTarget;

    for (const declaration of context.module.declarations) {
      for (const operation of operationsOf(declaration)) {
        if (operation.native.length === 0) continue;
        const where = `${declaration.name}.${operation.phrase}`;
        const span = operation.span ?? declaration.span ?? fallbackSpan(context);

        reportEmptyBlocks(context, where, operation);
        reportUntestable(context, where, operation, span);
        reportUncoveredTarget(context, where, operation, declared, span);
        if (declaration.kind === 'aggregate') reportIoInTheDomain(context, where, operation, span);
      }
    }
  },
};

/**
 * `HADL2213` — no I/O in the domain — is enforced by reading the statements of
 * an aggregate operation. A fenced block has no statements to read, so the rule
 * the language is most serious about would be silently unenforceable exactly
 * where the code gets interesting.
 *
 * The compiler will not parse the block, so this asks the only question it can
 * answer from outside: does the code name a port this module declares? That is
 * a guess, which is why it is a warning and why the message says what it saw
 * rather than what it concluded. A guess with the reasoning shown beats a rule
 * that quietly stops applying.
 */
function reportIoInTheDomain(context: AnalysisContext, where: string, operation: IROperation, span: SourceSpan): void {
  // A port called `OrderRepository` is `orderRepository` in TypeScript and
  // `order_repository` in Python and Rust. Comparing the names as written would
  // catch the one spelling nobody uses in code.
  const ports = new Map(context.index.ports.map((port) => [flatten(port.name), port.name]));
  if (ports.size === 0) return;

  for (const block of operation.native) {
    const mentioned = [...new Set([...wordsIn(block.code)].map(flatten).map((word) => ports.get(word)))].filter(
      (name): name is string => name !== undefined,
    );
    if (mentioned.length === 0) continue;
    context.diagnostics.warn(
      'ddd',
      'HADL2604',
      `the ${block.dialect} block in ${where} names the port ${mentioned.join(', ')}`,
      block.span ?? span,
      {
        hint: 'an aggregate decides and a service fetches: pass what the block needs in as a parameter, or move the operation to the service that already holds the port',
      },
    );
  }
}

/** `OrderRepository`, `orderRepository` and `order_repository` are one name. */
function flatten(word: string): string {
  return word.replace(/_/g, '').toLowerCase();
}

function wordsIn(code: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const line of code) for (const word of line.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) found.add(word);
  return found;
}

/** A fence with nothing between it deletes the operation for that target. */
function reportEmptyBlocks(context: AnalysisContext, where: string, operation: IROperation): void {
  for (const block of operation.native) {
    if (block.code.length > 0) continue;
    context.diagnostics.warn(
      'codegen',
      'HADL2601',
      `the ${block.dialect} block in ${where} is empty`,
      block.span ?? operation.span!,
      { hint: 'write the body, or remove the fence so the HADL statements are used instead' },
    );
  }
}

/**
 * Statements beside a block are what `haic test` can run. Without them the
 * operation is only covered by tests written in the target language, which is a
 * choice worth making on purpose rather than by omission.
 */
function reportUntestable(context: AnalysisContext, where: string, operation: IROperation, span: SourceSpan): void {
  if (operation.body.length > 0) return;
  const languages = operation.native.map((n) => n.dialect).join(', ');
  context.diagnostics.warn(
    'codegen',
    'HADL2602',
    `no scenario can exercise ${where}: its only body is ${languages}`,
    span,
    {
      hint: 'write the HADL statements too — they stay the reference implementation, and the block still wins for its own target',
    },
  );
}

/** A design that compiles to Java needs a body a Java backend can emit. */
function reportUncoveredTarget(
  context: AnalysisContext,
  where: string,
  operation: IROperation,
  target: CodegenTarget,
  span: SourceSpan,
): void {
  if (operation.body.length > 0 || nativeFor(operation, target)) return;
  const written = [...new Set(operation.native.map((n) => n.target))].join(', ');
  context.diagnostics.warn(
    'codegen',
    'HADL2603',
    `${where} has no body for ${target}, which this module targets`,
    span,
    {
      hint: `it is written for ${written}; add a ${target} block, add HADL statements, or build with "--language ${written.split(', ')[0]}"`,
    },
  );
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

function fallbackSpan(context: AnalysisContext): SourceSpan {
  const file = context.module.source?.file ?? '<unknown>';
  return { file, start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } };
}
