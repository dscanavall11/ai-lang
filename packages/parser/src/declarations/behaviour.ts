/** Parsers for behaviour: port, adapter, service, handler, endpoint. */
import { ADAPTER_TECHNOLOGIES, HTTP_METHODS, pascalCase, type IRDeclaration, type IREndpointDecl } from '@haic/core';
import type { ParseReporter } from '../reporter.js';
import type { Section } from '../section.js';
import { parseStatements } from '../statement-parser.js';
import { parseType } from '../type-parser.js';
import { subCursor } from '../field-parser.js';
import type { DeclarationParser } from './registry.js';
import { listAttribute, modifierWords, operationsOf, parseKeyValues, read, signaturesOf, singleAttribute } from './shared.js';

export const portParser: DeclarationParser = {
  keywords: ['port', 'interface'],
  parse(section, reporter) {
    const parsed = read(section);
    const modifiers = modifierWords(section.modifiers).map((m) => m.toLowerCase());
    const direction = modifiers.includes('inbound') || modifiers.includes('driving') ? 'inbound' : 'outbound';
    if (!modifiers.includes('inbound') && !modifiers.includes('outbound') && !modifiers.includes('driving') && !modifiers.includes('driven')) {
      reporter.warn(
        'HADL1020',
        `port ${section.name} does not declare a direction; assuming outbound`,
        section.span,
        'write "## port OrderRepository (outbound)" for repositories and gateways, "(inbound)" for use cases',
      );
    }

    const operations = signaturesOf(parsed, reporter);
    if (operations.length === 0) {
      reporter.error(
        'HADL1021',
        `port ${section.name} declares no operations`,
        section.span,
        'list operations as "- find order by id (id: uuid) -> Order or OrderNotFound"',
      );
      return null;
    }
    const port = describe({ kind: 'port', name: section.name, direction, operations, span: section.span }, parsed.description);

    // `using sql` on the port itself is the short form: one port, one adapter,
    // no second heading that only restates the technology.
    const inline = inlineAdapter(section, parsed, direction, reporter);
    return inline ? [port, inline] : port;
  },
};

/** Builds the adapter a port declares for itself, if it declares one. */
function inlineAdapter(
  section: Section,
  parsed: ReturnType<typeof read>,
  direction: 'inbound' | 'outbound',
  reporter: ParseReporter,
): IRDeclaration | null {
  const declared = singleAttribute(parsed, /^using\s+/i) ?? matchModifier(section, /using\s+([a-z-]+)/);
  if (!declared) return null;

  if (direction === 'inbound') {
    reporter.error(
      'HADL1031',
      `inbound port ${section.name} cannot name a technology`,
      section.span,
      'an inbound port is fulfilled by a service; only outbound ports need an adapter',
    );
    return null;
  }

  const technologyWord = declared.split(/\s/)[0]!.toLowerCase();
  if (!(ADAPTER_TECHNOLOGIES as readonly string[]).includes(technologyWord)) {
    reporter.error(
      'HADL1032',
      `unknown adapter technology "${technologyWord}"`,
      section.span,
      `supported technologies: ${ADAPTER_TECHNOLOGIES.join(', ')}`,
    );
    return null;
  }

  const configBlock = parsed.blocks.find((b) => /^config\s*:$/i.test(b.header.text));
  return {
    kind: 'adapter',
    name: `${pascalCase(technologyWord)}${section.name}`,
    description: `Declared inline by port ${section.name}.`,
    implements: section.name,
    technology: technologyWord as (typeof ADAPTER_TECHNOLOGIES)[number],
    config: configBlock ? parseKeyValues(section.file, configBlock.body.rest(), reporter) : {},
    operations: [],
    span: section.span,
  };
}

export const adapterParser: DeclarationParser = {
  keywords: ['adapter'],
  parse(section, reporter) {
    const parsed = read(section);
    const implemented = singleAttribute(parsed, /^implements\s+/i) ?? matchModifier(section, /implements\s+([A-Z][A-Za-z0-9_]*)/);
    if (!implemented) {
      reporter.error(
        'HADL1022',
        `adapter ${section.name} does not say which port it implements`,
        section.span,
        'write "## adapter PostgresOrderRepository implements OrderRepository using sql"',
      );
      return null;
    }

    const technologyWord = (singleAttribute(parsed, /^using\s+/i) ?? matchModifier(section, /using\s+([a-z-]+)/) ?? 'in-memory').toLowerCase();
    const technology = (ADAPTER_TECHNOLOGIES as readonly string[]).includes(technologyWord)
      ? (technologyWord as (typeof ADAPTER_TECHNOLOGIES)[number])
      : 'in-memory';
    if (technology === 'in-memory' && technologyWord !== 'in-memory') {
      reporter.error(
        'HADL1023',
        `unknown adapter technology "${technologyWord}"`,
        section.span,
        `supported technologies: ${ADAPTER_TECHNOLOGIES.join(', ')}`,
      );
    }

    const configBlock = parsed.blocks.find((b) => /^config\s*:$/i.test(b.header.text));
    const config = configBlock ? parseKeyValues(section.file, configBlock.body.rest(), reporter) : {};

    return describe(
      {
        kind: 'adapter',
        name: section.name,
        implements: implemented.split(/\s/)[0]!,
        technology,
        config,
        operations: operationsOf(parsed, reporter),
        span: section.span,
      },
      parsed.description,
    );
  },
};

export const serviceParser: DeclarationParser = {
  keywords: ['service', 'use case', 'usecase'],
  parse(section, reporter) {
    const parsed = read(section);
    const operations = operationsOf(parsed, reporter);
    if (operations.length === 0) {
      reporter.error(
        'HADL1024',
        `service ${section.name} declares no operations`,
        section.span,
        'write "operation place order (command: PlaceOrder) -> OrderPlaced:" followed by an indented body',
      );
      return null;
    }
    return describe(
      {
        kind: 'service',
        name: section.name,
        uses: listAttribute(parsed, /^uses\s+/i),
        implements: singleAttribute(parsed, /^implements\s+/i),
        operations,
        span: section.span,
      },
      parsed.description,
    );
  },
};

export const handlerParser: DeclarationParser = {
  keywords: ['handler', 'reaction', 'policy'],
  parse(section, reporter) {
    const parsed = read(section);
    const on = singleAttribute(parsed, /^on\s+/i) ?? matchModifier(section, /on\s+([A-Z][A-Za-z0-9_]*)/);
    const schedule = singleAttribute(parsed, /^schedule\s+/i);
    if (!on && !schedule) {
      reporter.error(
        'HADL1025',
        `handler ${section.name} does not say what triggers it`,
        section.span,
        'write "## handler NotifyCustomer on OrderPlaced" or add a "schedule 0 3 * * *" line',
      );
      return null;
    }

    const trigger = schedule ? 'schedule' : /command$/i.test(on ?? '') ? 'command' : 'event';
    const retriesText = singleAttribute(parsed, /^retries\s+/i);
    const deliveryText = (singleAttribute(parsed, /^delivery\s+/i) ?? 'at-least-once').toLowerCase();
    const delivery = (['at-least-once', 'at-most-once', 'exactly-once'] as const).find((d) => d === deliveryText) ?? 'at-least-once';

    const bodyBlock = parsed.blocks.find((b) => /^(do|body|steps)\s*:$/i.test(b.header.text));
    const body = bodyBlock ? parseStatements(bodyBlock.body, reporter) : [];

    const declaration: IRDeclaration = {
      kind: 'handler',
      name: section.name,
      on: (on ?? section.name).split(/\s/)[0]!,
      trigger,
      uses: listAttribute(parsed, /^uses\s+/i),
      body,
      delivery,
      retries: retriesText && /^\d+$/.test(retriesText) ? Number(retriesText) : 3,
      span: section.span,
    };
    if (schedule) declaration.schedule = schedule;
    return describe(declaration, parsed.description);
  },
};

const ENDPOINT_HEADING = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/i;

export const endpointParser: DeclarationParser = {
  keywords: ['endpoint', 'route'],
  parse(section, reporter) {
    const parsed = read(section);
    // The heading carries the method and path: `## endpoint POST /orders/{id}/place`
    const headingTail = `${section.name} ${section.modifiers}`.trim();
    const match = ENDPOINT_HEADING.exec(headingTail);
    if (!match) {
      reporter.error(
        'HADL1026',
        `endpoint heading must be "<METHOD> <path>", found "${headingTail}"`,
        section.span,
        'write "## endpoint POST /orders/{orderId}/place"',
      );
      return null;
    }
    const method = match[1]!.toUpperCase() as (typeof HTTP_METHODS)[number];
    const path = match[2]!;

    const handledBy = singleAttribute(parsed, /^handled\s+by\s+/i);
    if (!handledBy) {
      reporter.error(
        'HADL1027',
        `endpoint ${method} ${path} does not say which service handles it`,
        section.span,
        'add a line "handled by PlaceOrderService.place order"',
      );
      return null;
    }
    const dot = handledBy.indexOf('.');
    if (dot < 0) {
      reporter.error('HADL1028', `expected "<Service>.<operation>" in "handled by ${handledBy}"`, section.span);
      return null;
    }

    const responses = parseResponses(section, parsed, reporter);
    if (responses.length === 0) {
      reporter.error(
        'HADL1029',
        `endpoint ${method} ${path} declares no responses`,
        section.span,
        'add "responds 200 with OrderPlaced" and one line per checked error',
      );
      return null;
    }

    const requestText = singleAttribute(parsed, /^request\s+/i);
    const authText = (singleAttribute(parsed, /^auth\s+/i) ?? 'none').toLowerCase();
    const auth = (['none', 'bearer', 'api-key', 'basic'] as const).find((a) => a === authText) ?? 'none';

    const declaration: IREndpointDecl = {
      kind: 'endpoint',
      name: endpointName(method, path),
      method,
      path,
      handler: { service: handledBy.slice(0, dot).trim(), operation: handledBy.slice(dot + 1).trim() },
      responses,
      auth,
      idempotent: parsed.attributes.some((l) => /^idempotent\b/i.test(l.text)) || method === 'GET' || method === 'PUT',
      span: section.span,
    };
    if (requestText) {
      const cursor = subCursor(section.file, parsed.attributes.find((l) => /^request\s+/i.test(l.text))!, requestText, 8);
      declaration.request = parseType(cursor, reporter);
    }
    return describe(declaration, parsed.description);
  },
};

function parseResponses(section: Section, parsed: ReturnType<typeof read>, reporter: ParseReporter): IREndpointDecl['responses'] {
  const responses: IREndpointDecl['responses'] = [];
  for (const line of parsed.attributes) {
    const match = /^responds\s+(\d{3})\s*(.*)$/i.exec(line.text);
    if (!match) continue;
    const status = Number(match[1]);
    const tail = match[2]!.trim();

    if (tail.length === 0) {
      responses.push({ status });
      continue;
    }
    const whenMatch = /^when\s+([A-Z][A-Za-z0-9_]*)$/.exec(tail);
    if (whenMatch) {
      responses.push({ status, when: whenMatch[1]! });
      continue;
    }
    const withMatch = /^with\s+(.*)$/i.exec(tail);
    if (withMatch) {
      const cursor = subCursor(section.file, line, withMatch[1]!, line.text.length - withMatch[1]!.length);
      responses.push({ status, body: parseType(cursor, reporter) });
      continue;
    }
    reporter.error(
      'HADL1030',
      `expected "with <type>" or "when <Error>" after "responds ${status}"`,
      section.file.spanOf(line),
    );
  }
  return responses;
}

function endpointName(method: string, path: string): string {
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((s) => s.replace(/[{}]/g, ''))
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  return `${method.charAt(0)}${method.slice(1).toLowerCase()}${segments.join('')}`;
}

function matchModifier(section: Section, pattern: RegExp): string | null {
  const match = pattern.exec(section.modifiers);
  return match ? match[1]! : null;
}

function describe<T extends IRDeclaration>(declaration: T, description: string): T {
  if (description.trim().length > 0) return { ...declaration, description: description.trim() };
  return declaration;
}

export const behaviourParsers: DeclarationParser[] = [portParser, adapterParser, serviceParser, handlerParser, endpointParser];
