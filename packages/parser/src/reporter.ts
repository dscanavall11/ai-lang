/** Thin wrapper that stamps every parser diagnostic with the `parse` stage. */
import type { DiagnosticBag, SourceSpan } from '@haic/core';

export class ParseReporter {
  constructor(private readonly bag: DiagnosticBag) {}

  error(code: string, message: string, span: SourceSpan, hint?: string): void {
    this.bag.error('parse', code, message, span, hint ? { hint } : {});
  }

  warn(code: string, message: string, span: SourceSpan, hint?: string): void {
    this.bag.warn('parse', code, message, span, hint ? { hint } : {});
  }

  get hasErrors(): boolean {
    return this.bag.hasErrors;
  }
}
