/**
 * What an adapter wrote for itself.
 *
 * A backend generates real code for the repository phrases it recognises and
 * leaves the rest to the author. The author's answer goes in the source — as
 * HADL statements, or as a fenced block in the target language, which is the
 * whole reason the escape hatch exists. Both arrive here.
 *
 * This is one function shared by five backends on purpose. It used to be an
 * inline lookup that only two of them had, so a block written in a `## adapter`
 * reached Java and Python and was silently dropped by the other three: the
 * generated method threw "no generated implementation" while the implementation
 * sat in the source file, ignored.
 */
import { normalisePhrase, unknownSpan, type Diagnostic, type IRAdapterDecl, type IROperation } from '@haic/core';

export function declaredImplementation(adapter: IRAdapterDecl, phrase: string): IROperation | null {
  const declared = adapter.operations.find((operation) => normalisePhrase(operation.phrase) === normalisePhrase(phrase));
  if (!declared) return null;
  return declared.body.length > 0 || declared.native.length > 0 ? declared : null;
}

/**
 * The line a placeholder throws with, shared so every backend names the way
 * out. The message is for the person reading a stack trace six weeks from now,
 * so it says where the fix goes, not just that one is needed.
 */
export function placeholderMessage(phrase: string, technology: string): string {
  return `${phrase} has no generated ${technology} implementation; write it in the ## adapter declaration, as statements or a fenced block`;
}

/**
 * The build saying what it did not generate.
 *
 * The placeholder itself is correct — failing loudly beats a method that
 * silently does nothing. What was wrong is that the build was silent about it:
 * `✓ 106 files` with three of them time bombs reads as finished. This warning
 * is emitted by the caller that just wrote the placeholder, never predicted in
 * advance, so the report and the emission cannot disagree.
 */
export function placeholderDiagnostic(adapter: IRAdapterDecl, phrase: string, target: string): Diagnostic {
  const escape = `write the operation inside "## adapter ${adapter.name}" — HADL statements or a fenced ${target} block`;
  return {
    severity: 'warning',
    stage: 'codegen',
    code: 'HADL3061',
    message: `${adapter.name}.${phrase} is a placeholder: nothing is generated for that phrase on a ${adapter.technology} adapter, so calling it throws`,
    span: adapter.span ?? unknownSpan(),
    hint:
      adapter.technology === 'in-memory'
        ? `${escape}. In-memory generates only the repository phrases: find … by id, save …, list …, delete …, and declared queries`
        : `${escape} — or keep the technology "in-memory" until the real one matters`,
  };
}
