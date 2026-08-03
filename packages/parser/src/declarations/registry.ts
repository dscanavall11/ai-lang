/**
 * Declaration parser registry.
 *
 * Every declaration keyword is handled by one `DeclarationParser`. Supporting a
 * new keyword means registering another parser — nothing here changes.
 */
import type { IRDeclaration } from '@haic/core';
import type { ParseReporter } from '../reporter.js';
import type { Section } from '../section.js';

export interface DeclarationParser {
  /** Heading keywords this parser claims, lower-cased. */
  readonly keywords: readonly string[];
  /**
   * One heading may expand into several declarations. A port that names its own
   * technology emits the adapter too, so the shorthand costs the rest of the
   * compiler nothing: the IR is explicit either way.
   */
  parse(section: Section, reporter: ParseReporter): IRDeclaration | IRDeclaration[] | null;
}

export class DeclarationRegistry {
  private readonly byKeyword = new Map<string, DeclarationParser>();

  register(parser: DeclarationParser): this {
    for (const keyword of parser.keywords) {
      if (this.byKeyword.has(keyword)) throw new Error(`duplicate declaration keyword "${keyword}"`);
      this.byKeyword.set(keyword, parser);
    }
    return this;
  }

  get(keyword: string): DeclarationParser | undefined {
    return this.byKeyword.get(keyword);
  }

  keywords(): string[] {
    return [...this.byKeyword.keys()].sort();
  }
}
