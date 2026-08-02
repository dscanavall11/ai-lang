/** Helpers reused by several declaration parsers. */
import type { IRField, IRInvariant, IROperation, IROperationSignature } from '@ai-lang/core';
import { bulletBody, parseFieldLine, parseOperationSignature, splitTopLevel, subCursor } from '../field-parser.js';
import { parseExpression } from '../expression-parser.js';
import type { ParseReporter } from '../reporter.js';
import { readBody, type Section, type SectionBody } from '../section.js';
import { parseStatements } from '../statement-parser.js';
import type { Line } from '../source.js';
import { TokenCursor } from '../tokens.js';

export interface ParsedSection extends SectionBody {
  section: Section;
}

export function read(section: Section): ParsedSection {
  return { section, ...readBody(section) };
}

export function fieldsOf(parsed: ParsedSection, reporter: ParseReporter): IRField[] {
  const fields: IRField[] = [];
  for (const bullet of parsed.bullets) {
    const field = parseFieldLine(parsed.section.file, bullet, reporter);
    if (field) fields.push(field);
  }
  return fields;
}

/** `identified by id` / `identified by tenantId, code` */
export function identityOf(parsed: ParsedSection, fields: IRField[], reporter: ParseReporter): string[] {
  const declared = fields.filter((f) => f.identity).map((f) => f.name);
  const line = parsed.attributes.find((l) => /^identified\s+by\b/i.test(l.text));
  if (line) {
    const names = line.text
      .replace(/^identified\s+by\s*/i, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const name of names) {
      if (!fields.some((f) => f.name === name)) {
        reporter.error(
          'AIL1002',
          `"${name}" is not a field of ${parsed.section.name}`,
          parsed.section.file.spanOf(line),
          'the identity must name fields declared in this block',
        );
      }
    }
    if (names.length > 0) return names;
  }
  if (declared.length > 0) return declared;

  const conventional = fields.find((f) => f.name === 'id');
  if (conventional) return ['id'];

  reporter.error(
    'AIL1003',
    `${parsed.section.keyword} ${parsed.section.name} has no identity`,
    parsed.section.span,
    'add a field named "id", mark one field "identity", or write "identified by <field>"',
  );
  return [];
}

/** Reads a comma-separated attribute such as `contains OrderItem, Discount`. */
export function listAttribute(parsed: ParsedSection, verb: RegExp): string[] {
  const values: string[] = [];
  for (const line of parsed.attributes) {
    const match = verb.exec(line.text);
    if (!match) continue;
    for (const part of line.text.slice(match[0].length).split(',')) {
      const value = part.trim();
      if (value) values.push(value);
    }
  }
  return values;
}

export function singleAttribute(parsed: ParsedSection, verb: RegExp): string | null {
  for (const line of parsed.attributes) {
    const match = verb.exec(line.text);
    if (match) return line.text.slice(match[0].length).trim();
  }
  return null;
}

/** `invariant "description":` followed by an indented boolean expression. */
export function invariantsOf(parsed: ParsedSection, reporter: ParseReporter): IRInvariant[] {
  const invariants: IRInvariant[] = [];
  for (const block of parsed.blocks) {
    if (!/^invariant\b/i.test(block.header.text)) continue;
    const description = extractQuoted(block.header.text) ?? block.header.text.replace(/^invariant\s*/i, '').replace(/:$/, '').trim();

    block.body.skipTrivia();
    const conditionLine = block.body.peek();
    if (!conditionLine) {
      reporter.error('AIL1004', `invariant "${description}" has no condition`, parsed.section.file.spanOf(block.header));
      continue;
    }
    block.body.next();
    const cursor = TokenCursor.forLine(parsed.section.file, conditionLine);
    const condition = parseExpression(cursor, reporter);

    const invariant: IRInvariant = { description, condition, span: parsed.section.file.spanOf(block.header) };
    const raises = /\braises\s+([A-Z][A-Za-z0-9_]*)/.exec(block.header.text);
    if (raises) invariant.raises = raises[1]!;
    invariants.push(invariant);
  }
  return invariants;
}

/** `operation place order (command: PlaceOrder) -> OrderPlaced:` plus its body. */
export function operationsOf(parsed: ParsedSection, reporter: ParseReporter): IROperation[] {
  const operations: IROperation[] = [];
  for (const block of parsed.blocks) {
    if (!/^operation\b/i.test(block.header.text)) continue;
    const header = block.header.text.replace(/^operation\s*/i, '').replace(/:$/, '');
    const signature = parseOperationSignature(parsed.section.file, block.header, header, reporter);
    if (!signature) continue;
    const body = parseStatements(block.body, reporter);
    operations.push({ ...signature, body, effectful: isEffectful(body) });
  }
  return operations;
}

/** Signature-only operations declared as bullets, used by ports. */
export function signaturesOf(parsed: ParsedSection, reporter: ParseReporter): IROperationSignature[] {
  const signatures: IROperationSignature[] = [];
  for (const bullet of parsed.bullets) {
    const signature = parseOperationSignature(parsed.section.file, bullet, bulletBody(bullet), reporter);
    if (signature) signatures.push(signature);
  }
  return signatures;
}

function isEffectful(body: IROperation['body']): boolean {
  return body.some((statement) => {
    switch (statement.kind) {
      case 'publish':
      case 'perform':
        return true;
      case 'let':
        return statement.value.kind === 'call';
      case 'when':
        return isEffectful(statement.then) || isEffectful(statement.otherwise);
      case 'for-each':
        return isEffectful(statement.body);
      default:
        return false;
    }
  });
}

export function extractQuoted(text: string): string | null {
  const match = /"([^"]*)"|'([^']*)'/.exec(text);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

/** Parses `key = value, other = value` from an attribute or config block. */
export function parseKeyValues(
  file: Section['file'],
  lines: Line[],
  reporter: ParseReporter,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const line of lines) {
    for (const part of splitTopLevel(line.text.replace(/^[-*]\s+/, ''), ',')) {
      const separator = part.indexOf('=') >= 0 ? '=' : ':';
      const index = part.indexOf(separator);
      if (index < 0) {
        reporter.error('AIL1005', `expected "key = value", found "${part.trim()}"`, file.spanOf(line));
        continue;
      }
      const key = part.slice(0, index).trim();
      const raw = part.slice(index + 1).trim().replace(/^["']|["']$/g, '');
      out[key] = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    }
  }
  return out;
}

/** Reads a bare word list from a heading modifier string. */
export function modifierWords(modifiers: string): string[] {
  return modifiers
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function cursorForLine(section: Section, line: Line): TokenCursor {
  return subCursor(section.file, line, line.text, 0);
}
