/**
 * Names derived from the requirements.
 *
 * Three phases need the same names for the same thing, so the rules live here
 * once. Every name is a pure function of words the requirements already used.
 */
import { pascalCase } from '@haic/core';
import { fieldName, kebab, pastParticiple, plural, routeName, singular, typeName } from './language.js';
import type { Capability } from './types.js';

export function aggregateName(noun: string): string {
  return typeName(singular(noun));
}

export function serviceName(aggregate: string): string {
  return `${aggregate}Service`;
}

export function repositoryName(aggregate: string): string {
  return `${aggregate}Repository`;
}

export function adapterName(aggregate: string): string {
  return `Sql${aggregate}Repository`;
}

export function notFoundName(aggregate: string): string {
  return `${aggregate}NotFound`;
}

export function commandName(capability: Capability): string {
  return `${pascalCase(capability.verb)}${aggregateName(capability.aggregate)}`;
}

export function eventName(capability: Capability): string {
  return `${aggregateName(capability.aggregate)}${pascalCase(pastParticiple(capability.verb))}`;
}

export function topicName(event: string): string {
  return kebab(event);
}

/** Operation phrase: lower-case words only, plural for queries. */
export function operationPhrase(capability: Capability): string {
  const noun = capability.verbClass === 'read' ? plural(capability.aggregate) : singular(capability.aggregate);
  return `${capability.verb} ${noun}`;
}

export function identityField(noun: string): string {
  return fieldName(`${singular(noun)} id`);
}

export function collectionField(noun: string): string {
  return fieldName(plural(noun));
}

export function routeFor(capability: Capability): string {
  const base = `/${routeName(capability.aggregate)}`;
  return capability.verbClass === 'create' || capability.verbClass === 'read' ? base : `${base}/${kebab(capability.verb)}`;
}

export function methodFor(capability: Capability): 'GET' | 'POST' | 'PUT' | 'DELETE' {
  switch (capability.verbClass) {
    case 'read':
      return 'GET';
    case 'update':
      return 'PUT';
    case 'delete':
      return 'DELETE';
    default:
      return 'POST';
  }
}

export function tableName(aggregate: string): string {
  return plural(kebab(aggregate).replace(/-/g, '_'));
}
