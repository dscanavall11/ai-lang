/**
 * Identifier casing. Every generator renames AI-Lang identifiers into its own
 * idiom, so the rules live here once instead of in five backends.
 */

/** Splits `orderItemId`, `order-item-id`, `Order Item ID` into `["order","item","id"]`. */
export function words(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function pascalCase(input: string): string {
  return words(input)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

export function camelCase(input: string): string {
  const pascal = pascalCase(input);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

export function snakeCase(input: string): string {
  return words(input).join('_');
}

export function kebabCase(input: string): string {
  return words(input).join('-');
}

export function screamingSnakeCase(input: string): string {
  return words(input).join('_').toUpperCase();
}

export function titleCase(input: string): string {
  return words(input)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Naive but predictable pluralisation; used for table and route names. */
export function pluralize(input: string): string {
  if (/(s|x|z|ch|sh)$/i.test(input)) return `${input}es`;
  if (/[^aeiou]y$/i.test(input)) return `${input.slice(0, -1)}ies`;
  if (/(f)$/i.test(input)) return `${input.slice(0, -1)}ves`;
  if (/(fe)$/i.test(input)) return `${input.slice(0, -2)}ves`;
  return `${input}s`;
}

export function tableName(entityName: string): string {
  return pluralize(snakeCase(entityName));
}

export function routeSegment(entityName: string): string {
  return pluralize(kebabCase(entityName));
}

/** Turns an operation phrase such as "find order by id" into a method name. */
export function phraseToMethod(phrase: string): string {
  return camelCase(phrase);
}

const RESERVED: Record<string, ReadonlySet<string>> = {
  java: new Set(['abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public', 'record', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'var', 'yield']),
  typescript: new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'as', 'implements', 'interface', 'let', 'package', 'private', 'protected', 'public', 'static', 'yield', 'any', 'boolean', 'number', 'string', 'symbol', 'type', 'from', 'of']),
  python: new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'id', 'type', 'list', 'dict', 'set', 'str', 'int', 'float', 'bytes']),
  go: new Set(['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var']),
  rust: new Set(['as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while', 'abstract', 'become', 'box', 'do', 'final', 'macro', 'override', 'priv', 'typeof', 'unsized', 'virtual', 'yield']),
};

/** Appends a language-appropriate suffix when `name` collides with a keyword. */
export function escapeReserved(name: string, language: keyof typeof RESERVED | string): string {
  const reserved = RESERVED[language];
  if (!reserved?.has(name)) return name;
  return language === 'rust' ? `r#${name}` : `${name}_`;
}
