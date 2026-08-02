/**
 * Read-only views over an IR module.
 *
 * Declarations live in one ordered array so that adding a new declaration kind
 * never changes the module shape (open for extension, closed for modification).
 * This index restores fast lookups without duplicating the data.
 */
import type {
  IRAggregateDecl,
  IRAdapterDecl,
  IRCommandDecl,
  IRDeclaration,
  IRDeclarationKind,
  IRDtoDecl,
  IREndpointDecl,
  IREntityDecl,
  IREnumDecl,
  IRErrorDecl,
  IREventDecl,
  IRHandlerDecl,
  IRModule,
  IROperation,
  IROperationSignature,
  IRPortDecl,
  IRQueryDecl,
  IRScenarioDecl,
  IRServiceDecl,
  IRValueObjectDecl,
} from './schema.js';

type DeclarationOfKind<K extends IRDeclarationKind> = Extract<IRDeclaration, { kind: K }>;

export class ModuleIndex {
  private readonly byName = new Map<string, IRDeclaration>();
  private readonly byKind = new Map<IRDeclarationKind, IRDeclaration[]>();
  /** Normalised operation phrase -> owning declaration + signature. */
  private readonly byPhrase = new Map<string, Array<{ owner: IRDeclaration; operation: IROperationSignature }>>();

  constructor(readonly module: IRModule) {
    for (const declaration of module.declarations) {
      this.byName.set(declaration.name, declaration);
      const bucket = this.byKind.get(declaration.kind);
      if (bucket) bucket.push(declaration);
      else this.byKind.set(declaration.kind, [declaration]);

      for (const operation of operationsOf(declaration)) {
        const key = normalisePhrase(operation.phrase);
        const entries = this.byPhrase.get(key) ?? [];
        entries.push({ owner: declaration, operation });
        this.byPhrase.set(key, entries);
      }
    }
  }

  get(name: string): IRDeclaration | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  ofKind<K extends IRDeclarationKind>(kind: K): Array<DeclarationOfKind<K>> {
    return (this.byKind.get(kind) ?? []) as Array<DeclarationOfKind<K>>;
  }

  typed<K extends IRDeclarationKind>(name: string, kind: K): DeclarationOfKind<K> | undefined {
    const declaration = this.byName.get(name);
    return declaration?.kind === kind ? (declaration as DeclarationOfKind<K>) : undefined;
  }

  resolvePhrase(phrase: string): Array<{ owner: IRDeclaration; operation: IROperationSignature }> {
    return this.byPhrase.get(normalisePhrase(phrase)) ?? [];
  }

  get enums(): IREnumDecl[] {
    return this.ofKind('enum');
  }
  get valueObjects(): IRValueObjectDecl[] {
    return this.ofKind('value-object');
  }
  get entities(): IREntityDecl[] {
    return this.ofKind('entity');
  }
  get aggregates(): IRAggregateDecl[] {
    return this.ofKind('aggregate');
  }
  get dtos(): IRDtoDecl[] {
    return this.ofKind('dto');
  }
  get commands(): IRCommandDecl[] {
    return this.ofKind('command');
  }
  get events(): IREventDecl[] {
    return this.ofKind('event');
  }
  get errors(): IRErrorDecl[] {
    return this.ofKind('error');
  }
  get queries(): IRQueryDecl[] {
    return this.ofKind('query');
  }
  get ports(): IRPortDecl[] {
    return this.ofKind('port');
  }
  get adapters(): IRAdapterDecl[] {
    return this.ofKind('adapter');
  }
  get services(): IRServiceDecl[] {
    return this.ofKind('service');
  }
  get endpoints(): IREndpointDecl[] {
    return this.ofKind('endpoint');
  }
  get handlers(): IRHandlerDecl[] {
    return this.ofKind('handler');
  }
  get scenarios(): IRScenarioDecl[] {
    return this.ofKind('scenario');
  }

  /** Declarations that carry fields, i.e. everything a generator turns into a struct. */
  get dataShapes(): Array<
    IRValueObjectDecl | IREntityDecl | IRAggregateDecl | IRDtoDecl | IRCommandDecl | IREventDecl | IRErrorDecl | IRQueryDecl
  > {
    return this.module.declarations.filter(
      (
        d,
      ): d is
        | IRValueObjectDecl
        | IREntityDecl
        | IRAggregateDecl
        | IRDtoDecl
        | IRCommandDecl
        | IREventDecl
        | IRErrorDecl
        | IRQueryDecl =>
        d.kind === 'query' ||
        d.kind === 'value-object' ||
        d.kind === 'entity' ||
        d.kind === 'aggregate' ||
        d.kind === 'dto' ||
        d.kind === 'command' ||
        d.kind === 'event' ||
        d.kind === 'error',
    );
  }

  /** Aggregate that owns the given entity, if any. */
  owningAggregate(entityName: string): IRAggregateDecl | undefined {
    return this.aggregates.find((a) => a.entities.includes(entityName));
  }
}

export function indexModule(module: IRModule): ModuleIndex {
  return new ModuleIndex(module);
}

export function operationsOf(declaration: IRDeclaration): IROperationSignature[] {
  switch (declaration.kind) {
    case 'port':
      return declaration.operations;
    case 'service':
    case 'aggregate':
      return declaration.operations;
    case 'adapter':
      return declaration.operations;
    default:
      return [];
  }
}

export function bodiedOperationsOf(declaration: IRDeclaration): IROperation[] {
  switch (declaration.kind) {
    case 'service':
    case 'aggregate':
    case 'adapter':
      return declaration.operations;
    default:
      return [];
  }
}

/** Phrases are compared case-insensitively with collapsed whitespace. */
export function normalisePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, ' ');
}
