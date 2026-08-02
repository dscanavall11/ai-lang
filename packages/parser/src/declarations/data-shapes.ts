/** Parsers for the declarations that carry data: enum, value object, entity, aggregate, dto, command, event, error. */
import type { IRDeclaration } from '@ai-lang/core';
import { bulletBody } from '../field-parser.js';
import type { ParseReporter } from '../reporter.js';
import type { Section } from '../section.js';
import type { DeclarationParser } from './registry.js';
import { fieldsOf, identityOf, invariantsOf, listAttribute, modifierWords, operationsOf, read, singleAttribute } from './shared.js';

export const enumParser: DeclarationParser = {
  keywords: ['enum', 'enumeration'],
  parse(section, reporter) {
    const parsed = read(section);
    const values = parsed.bullets.map((bullet) => {
      const text = bulletBody(bullet);
      const [name = '', ...rest] = text.split(/\s*[-–—]\s+|\s*\/\/\s*/);
      const value: { name: string; description?: string } = { name: name.trim() };
      const description = rest.join(' ').trim();
      if (description) value.description = description;
      return value;
    });
    if (values.length === 0) {
      reporter.error('AIL1010', `enum ${section.name} has no values`, section.span, 'list values as "- Draft"');
      return null;
    }
    return withDescription({ kind: 'enum', name: section.name, values, span: section.span }, parsed.description);
  },
};

export const valueObjectParser: DeclarationParser = {
  keywords: ['value object', 'value-object'],
  parse(section, reporter) {
    const parsed = read(section);
    const fields = fieldsOf(parsed, reporter);
    if (fields.length === 0) {
      reporter.error('AIL1011', `value object ${section.name} has no fields`, section.span);
      return null;
    }
    for (const field of fields) {
      if (field.identity) {
        reporter.error(
          'AIL1012',
          `value object ${section.name} cannot have an identity field`,
          field.span ?? section.span,
          'value objects are compared by their values; use "## entity" when identity matters',
        );
      }
    }
    return withDescription(
      { kind: 'value-object', name: section.name, fields, invariants: invariantsOf(parsed, reporter), span: section.span },
      parsed.description,
    );
  },
};

export const entityParser: DeclarationParser = {
  keywords: ['entity'],
  parse(section, reporter) {
    const parsed = read(section);
    const fields = fieldsOf(parsed, reporter);
    if (fields.length === 0) {
      reporter.error('AIL1013', `entity ${section.name} has no fields`, section.span);
      return null;
    }
    const aggregate = singleAttribute(parsed, /^(belongs\s+to|part\s+of)\s+/i);
    return withDescription(
      {
        kind: 'entity',
        name: section.name,
        identity: identityOf(parsed, fields, reporter),
        fields,
        invariants: invariantsOf(parsed, reporter),
        aggregate,
        span: section.span,
      },
      parsed.description,
    );
  },
};

export const aggregateParser: DeclarationParser = {
  keywords: ['aggregate'],
  parse(section, reporter) {
    const parsed = read(section);
    const fields = fieldsOf(parsed, reporter);
    if (fields.length === 0) {
      reporter.error('AIL1014', `aggregate ${section.name} has no fields`, section.span);
      return null;
    }
    return withDescription(
      {
        kind: 'aggregate',
        name: section.name,
        identity: identityOf(parsed, fields, reporter),
        fields,
        invariants: invariantsOf(parsed, reporter),
        entities: listAttribute(parsed, /^contains\s+/i),
        operations: operationsOf(parsed, reporter),
        emits: listAttribute(parsed, /^emits\s+/i),
        span: section.span,
      },
      parsed.description,
    );
  },
};

export const dtoParser: DeclarationParser = {
  keywords: ['dto', 'view', 'read model'],
  parse(section, reporter) {
    const parsed = read(section);
    return withDescription(
      {
        kind: 'dto',
        name: section.name,
        fields: fieldsOf(parsed, reporter),
        projects: singleAttribute(parsed, /^projects\s+/i),
        span: section.span,
      },
      parsed.description,
    );
  },
};

export const commandParser: DeclarationParser = {
  keywords: ['command'],
  parse(section, reporter) {
    const parsed = read(section);
    return withDescription(
      {
        kind: 'command',
        name: section.name,
        fields: fieldsOf(parsed, reporter),
        target: singleAttribute(parsed, /^targets\s+/i) ?? firstModifierAfter(section, 'targets'),
        span: section.span,
      },
      parsed.description,
    );
  },
};

export const eventParser: DeclarationParser = {
  keywords: ['event', 'domain event'],
  parse(section, reporter) {
    const parsed = read(section);
    const declaration: IRDeclaration = {
      kind: 'event',
      name: section.name,
      fields: fieldsOf(parsed, reporter),
      source: singleAttribute(parsed, /^from\s+/i) ?? firstModifierAfter(section, 'from'),
      span: section.span,
    };
    const topic = singleAttribute(parsed, /^topic\s+/i);
    if (topic) declaration.topic = topic;
    return withDescription(declaration, parsed.description);
  },
};

export const errorParser: DeclarationParser = {
  keywords: ['error', 'failure'],
  parse(section, reporter) {
    const parsed = read(section);
    const modifiers = modifierWords(section.modifiers).map((m) => m.toLowerCase());

    const isChecked = modifiers.includes('checked');
    const isUnchecked = modifiers.includes('unchecked') || modifiers.includes('panic');
    if (!isChecked && !isUnchecked) {
      reporter.error(
        'AIL1015',
        `error ${section.name} must say whether it is checked or unchecked`,
        section.span,
        'write "## error OrderNotFound (checked, status 404)" for errors callers must handle, or "(unchecked)" for bugs',
      );
    }

    const statusModifier = modifiers.map((m) => /^status\s+(\d{3})$/.exec(m)).find(Boolean);
    const statusAttribute = singleAttribute(parsed, /^status\s+/i);
    const status = statusModifier ? Number(statusModifier[1]) : statusAttribute ? Number(statusAttribute) : undefined;

    const message = singleAttribute(parsed, /^message\s*[:=]?\s*/i)?.replace(/^["']|["']$/g, '') ?? parsed.description.split('\n')[0] ?? section.name;

    const declaration: IRDeclaration = {
      kind: 'error',
      name: section.name,
      checked: isChecked,
      message,
      fields: fieldsOf(parsed, reporter),
      span: section.span,
    };
    if (status !== undefined && Number.isFinite(status)) declaration.status = status;
    return withDescription(declaration, parsed.description);
  },
};

function firstModifierAfter(section: Section, verb: string): string | null {
  const match = new RegExp(`\\b${verb}\\s+([A-Z][A-Za-z0-9_]*)`).exec(section.modifiers);
  return match ? match[1]! : null;
}

function withDescription<T extends IRDeclaration>(declaration: T, description: string): T {
  if (description.trim().length > 0) return { ...declaration, description: description.trim() };
  return declaration;
}

export const dataShapeParsers: DeclarationParser[] = [
  enumParser,
  valueObjectParser,
  entityParser,
  aggregateParser,
  dtoParser,
  commandParser,
  eventParser,
  errorParser,
];
