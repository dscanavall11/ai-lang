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
import { normalisePhrase, type IRAdapterDecl, type IROperation } from '@haic/core';

export function declaredImplementation(adapter: IRAdapterDecl, phrase: string): IROperation | null {
  const declared = adapter.operations.find((operation) => normalisePhrase(operation.phrase) === normalisePhrase(phrase));
  if (!declared) return null;
  return declared.body.length > 0 || declared.native.length > 0 ? declared : null;
}
