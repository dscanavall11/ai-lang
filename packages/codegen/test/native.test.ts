/**
 * What every backend must do with a body it did not write.
 *
 * Two properties matter and both are easy to lose: the code has to arrive
 * unchanged, and a backend the block was not written for has to say so instead
 * of emitting a method that silently does nothing.
 */
import { describe, expect, it } from 'vitest';
import { DiagnosticBag, type IRProject } from '@haic/core';
import { analyze } from '@haic/analyzer';
import { parseModule } from '@haic/parser';
import { codeGenerators, generateProject, missingImplementations } from '../src/index.js';

const SOURCE = `---
module: pricing
context: Pricing
target: typescript
---

# Pricing

## aggregate Quote
identified by id

- id: uuid, required
- lines: list of decimal, required

invariant "a quote prices something":
  lines is not empty

operation median () -> decimal:
  \`\`\`typescript
  const sorted = [...this.lines].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
  \`\`\`

  \`\`\`python
  ordered = sorted(self.lines)
  return ordered[len(ordered) // 2]
  \`\`\`

operation widest () -> decimal:
  return max of lines by 1
`;

function projectOf(text: string): IRProject {
  const bag = new DiagnosticBag();
  const { module } = parseModule('pricing.hadl', text, bag);
  expect(bag.errors).toEqual([]);
  return analyze([module!], { projectName: 'pricing' }).project;
}

const project = projectOf(SOURCE);

function generate(target: string) {
  return generateProject(codeGenerators.require(target), { project, outputDir: `out/${target}`, options: {} });
}

describe('a fenced body', () => {
  it('reaches the backend it names, unchanged', () => {
    const emitted = generate('typescript').files.map((f) => f.contents).join('\n');
    expect(emitted).toContain('const sorted = [...this.lines].sort((a, b) => a - b);');
    expect(emitted).toContain('// Written in typescript in the .hadl source, copied verbatim.');
  });

  it('reaches a second backend from the second block, in that language', () => {
    const emitted = generate('python').files.map((f) => f.contents).join('\n');
    expect(emitted).toContain('ordered = sorted(self.lines)');
    // A Python comment, not the `//` the shared emitter would default to.
    expect(emitted).toContain('# Written in python in the .hadl source, copied verbatim.');
  });

  it('does not leak into a backend it was not written for', () => {
    const emitted = generate('go').files.map((f) => f.contents).join('\n');
    expect(emitted).not.toContain('Math.floor');
    expect(emitted).not.toContain('ordered = sorted');
  });

  it('stops the build for a target with no body at all', () => {
    for (const target of ['java', 'go', 'rust']) {
      const errors = generate(target).diagnostics.filter((d) => d.severity === 'error');
      expect(errors.map((d) => d.code)).toEqual(['HADL3060']);
      expect(errors[0]!.message).toContain('Quote.median');
    }
  });

  it('leaves the operations it does not cover alone', () => {
    // `widest` is ordinary HADL, so every backend still lowers it.
    expect(missingImplementations(project.modules, 'go').map((d) => d.message)).toEqual([
      'Quote.median has no body for go',
    ]);
  });

  it('is not reported for the targets it was written for', () => {
    expect(missingImplementations(project.modules, 'typescript')).toEqual([]);
    expect(missingImplementations(project.modules, 'python')).toEqual([]);
  });
});

/**
 * An adapter is where a block is most obviously useful: it is the one place the
 * compiler already admits it cannot generate the body. Java and Python honoured
 * a block there and the other three dropped it in silence — the generated method
 * threw "no generated implementation" while the implementation sat in the source.
 */
describe('a block in an adapter', () => {
  const withAdapter = projectOf(`---
module: search
context: Search
---

# Search

## aggregate Doc
identified by id

- id: uuid, required
- title: text, required

invariant "a doc is titled":
  title is not empty

## port DocSearch (outbound)

- search docs (term: text) -> list of Doc

## adapter ElasticDocSearch implements DocSearch using http-client

operation search docs (term: text) -> list of Doc:
  \`\`\`typescript
  const response = await fetch(\`https://search.internal?q=\${term}\`);
  return (await response.json()) as Doc[];
  \`\`\`

  \`\`\`python
  response = await self._client.get("https://search.internal", params={"q": term})
  return [Doc(**row) for row in response.json()]
  \`\`\`

  \`\`\`go
  return searchInternal(ctx, term)
  \`\`\`

  \`\`\`java
  return this.client.search(term);
  \`\`\`

  \`\`\`rust
  Ok(self.client.search(term).await?)
  \`\`\`

## port DocReader (inbound)

- read docs (term: text) -> list of Doc

## service DocService
uses DocSearch
implements DocReader

operation read docs (term: text) -> list of Doc:
  let found be search docs with term = term
  return found

## endpoint GET /docs
handled by DocService.read docs
responds 200 with Doc
`);

  const cases = [
    { target: 'typescript', snippet: 'const response = await fetch(' },
    { target: 'python', snippet: 'response = await self._client.get(' },
    { target: 'go', snippet: 'return searchInternal(ctx, term)' },
    { target: 'java', snippet: 'return this.client.search(term);' },
    { target: 'rust', snippet: 'Ok(self.client.search(term).await?)' },
  ];

  it.each(cases)('reaches the $target backend', ({ target, snippet }) => {
    const emitted = generateProject(codeGenerators.require(target), {
      project: withAdapter,
      outputDir: `out/${target}`,
      options: {},
    })
      .files.map((file) => file.contents)
      .join('\n');

    expect(emitted).toContain(snippet);
    // And the placeholder it replaces must be gone, not sitting beside it.
    expect(emitted).not.toContain('has no generated');
  });

  it.each(cases)('is a filled method to the $target backend, so nothing warns', ({ target }) => {
    const result = generateProject(codeGenerators.require(target), {
      project: withAdapter,
      outputDir: `out/${target}`,
      options: {},
    });
    expect(result.diagnostics.filter((d) => d.code === 'HADL3061')).toEqual([]);
  });
});

describe('an adapter method the build did not fill in', () => {
  const withPlaceholder = projectOf(`---
module: search
context: Search
---

# Search

## aggregate Doc
identified by id

- id: uuid, required
- title: text, required

invariant "a doc is titled":
  title is not empty

## port DocSearch (outbound)

- search docs (term: text) -> list of Doc
- find doc by id (id: uuid) -> Doc

## adapter ElasticDocSearch implements DocSearch using http-client

## port DocReader (inbound)

- read docs (term: text) -> list of Doc

## service DocService
uses DocSearch
implements DocReader

operation read docs (term: text) -> list of Doc:
  let found be search docs with term = term
  return found

## endpoint GET /docs
handled by DocService.read docs
responds 200 with Doc
`);

  it.each(['typescript', 'python', 'go', 'java', 'rust'])('is reported by the %s backend, once per method', (target) => {
    const emitted = generateProject(codeGenerators.require(target), {
      project: withPlaceholder,
      outputDir: `out/${target}`,
      options: {},
    });

    const warnings = emitted.diagnostics.filter((d) => d.code === 'HADL3061');
    // `find doc by id` is a phrase nothing recognises on http-client either:
    // both operations are placeholders, and each gets its own warning.
    expect(warnings).toHaveLength(2);
    expect(warnings.every((d) => d.severity === 'warning')).toBe(true);
    expect(warnings[0]!.message).toContain('ElasticDocSearch.search docs');
    expect(warnings[0]!.message).toContain('http-client');
    expect(warnings[0]!.hint).toContain('## adapter ElasticDocSearch');

    // The warning describes what was actually emitted: the placeholder line
    // carries the same explanation, so a stack trace names the fix too.
    const contents = emitted.files.map((file) => file.contents).join('\n');
    expect(contents).toContain('has no generated http-client implementation');
    expect(contents).toContain('## adapter declaration');
  });

  it.each(['typescript', 'python', 'go', 'java', 'rust'])('is not reported by the %s backend for a recognised phrase', (target) => {
    const stored = projectOf(`---
module: files
context: Files
---

# Files

## aggregate Doc
identified by id

- id: uuid, required
- title: text, required

invariant "a doc is titled":
  title is not empty

## port DocRepository (outbound)

- find doc by id (id: uuid) -> Doc
- save doc (doc: Doc) -> nothing

## adapter InMemoryDocRepository implements DocRepository using in-memory

## port DocReader (inbound)

- read doc (id: uuid) -> Doc

## service DocService
uses DocRepository
implements DocReader

operation read doc (id: uuid) -> Doc:
  let doc be find doc by id with id = id
  return doc

## endpoint GET /docs/{id}
handled by DocService.read doc
responds 200 with Doc
`);

    const emitted = generateProject(codeGenerators.require(target), { project: stored, outputDir: `out/${target}`, options: {} });
    expect(emitted.diagnostics.filter((d) => d.code === 'HADL3061')).toEqual([]);
  });
});

describe('what a backend decides from a body it did not write', () => {
  it('gives a Rust block a mutable receiver, having no statements to read', () => {
    const rust = projectOf(
      SOURCE.replace(
        '  return ordered[len(ordered) // 2]\n  ```',
        '  return ordered[len(ordered) // 2]\n  ```\n\n  ```rust\n  self.lines.sort_by(|a, b| a.partial_cmp(b).unwrap());\n  Ok(self.lines[self.lines.len() / 2])\n  ```',
      ),
    );
    const model = generateProject(codeGenerators.require('rust'), { project: rust, outputDir: 'out/rust', options: {} })
      .files.find((file) => file.path.endsWith('model.rs'))!.contents;

    // A block that assigns to a field cannot compile behind a shared borrow.
    expect(model).toContain('pub fn median(&mut self)');
    expect(model).toContain('self.lines.sort_by(');
  });

  it('leaves a Go block to return for itself', () => {
    const go = projectOf(
      SOURCE.replace(
        '  return ordered[len(ordered) // 2]\n  ```',
        '  return ordered[len(ordered) // 2]\n  ```\n\n  ```go\n  sort.Float64s(q.Lines)\n  return q.Lines[len(q.Lines)/2], nil\n  ```',
      ),
    );
    const model = generateProject(codeGenerators.require('go'), { project: go, outputDir: 'out/go', options: {} })
      .files.find((file) => file.path.endsWith('model.go'))!.contents;

    expect(model).toContain('return q.Lines[len(q.Lines)/2], nil');
    // No zero-value return bolted on after code that already returned.
    expect(model).not.toMatch(/return q\.Lines\[len\(q\.Lines\)\/2\], nil\n\s*return 0/);
  });
});

describe('statements written beside a block', () => {
  const fallback = projectOf(
    SOURCE.replace(
      '  return ordered[len(ordered) // 2]\n  ```',
      '  return ordered[len(ordered) // 2]\n  ```\n\n  return max of lines by 1',
    ),
  );

  it('are what a backend with no block of its own emits', () => {
    const result = generateProject(codeGenerators.require('go'), { project: fallback, outputDir: 'out/go', options: {} });
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(missingImplementations(fallback.modules, 'go')).toEqual([]);
  });

  it('still lose to the block on the target that has one', () => {
    const result = generateProject(codeGenerators.require('typescript'), {
      project: fallback,
      outputDir: 'out/typescript',
      options: {},
    });
    const model = result.files.find((f) => f.path.endsWith('model.ts'))!.contents;
    expect(model).toContain('const sorted = [...this.lines].sort((a, b) => a - b);');
  });
});

/**
 * A scenario the interpreter cannot run is the whole reason this exists: the
 * operation it reaches is written in a target language, so the only place it
 * can run is a test in that language.
 */
describe('scenarios compiled into tests', () => {
  const source = `---
module: pricing
context: Pricing
---

# Pricing

## aggregate Quote
identified by id

- id: uuid, required
- lines: list of decimal, required

invariant "a quote prices something":
  lines is not empty

operation median () -> decimal:
  \`\`\`typescript
  const sorted = [...this.lines].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
  \`\`\`

  \`\`\`python
  ordered = sorted(self.lines)
  return ordered[len(ordered) // 2]
  \`\`\`

## scenario the median of three prices

given quote be Quote with id = "11111111-1111-4111-8111-111111111111", lines = [3, 1, 2]
when median with quote = quote
then result is 2
`;

  const emitted = (target: string): string => {
    const files = generateProject(codeGenerators.require(target), {
      project: projectOf(source),
      outputDir: `out/${target}`,
      options: {},
    }).files;
    const test = files.find((file) => /scenarios\.test\.ts$|test_scenarios\.py$/.test(file.path));
    return test?.contents ?? '';
  };

  it('builds the given, calls the operation and checks the result, in TypeScript', () => {
    const contents = emitted('typescript');
    expect(contents).toContain("import { test } from 'node:test';");
    expect(contents).toContain('const quote = new Quote({');
    expect(contents).toContain('const result = quote.median();');
    expect(contents).toContain('assert.ok(result === 2');
  });

  it('does the same in Python, with the standard library', () => {
    const contents = emitted('python');
    expect(contents).toContain('import unittest');
    expect(contents).toContain('class ScenarioTests(unittest.TestCase):');
    expect(contents).toContain('result = quote.median()');
    expect(contents).toContain('self.assertTrue(result == 2');
  });

  it('gives a literal the type its field declares, not the type it looks like', () => {
    // `"1111…"` parses as text. Python models a uuid as a uuid, and a bare
    // string there compares equal to nothing — including itself.
    expect(emitted('python')).toContain('uuid.UUID("11111111-1111-4111-8111-111111111111")');
  });

  it('carries a readable id into the test as the uuid it stands for', () => {
    // `"q-1"` is text where a uuid is declared, so the compiler derives one —
    // the same one here, in the interpreter and in every other backend.
    const shortId = source.replace('11111111-1111-4111-8111-111111111111', 'q-1');
    const files = generateProject(codeGenerators.require('typescript'), {
      project: projectOf(shortId),
      outputDir: 'out/typescript',
      options: {},
    }).files;
    const test = files.find((file) => file.path.endsWith('scenarios.test.ts'))!.contents;

    expect(test).toContain('quote.median()');
    expect(test).not.toContain('"q-1"');
    expect(test).toMatch(/id: "[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"/);
  });

  it('names the ones it left behind, when it writes a file at all', () => {
    // The matching example has one of each: a compiled scenario and a service
    // scenario. A reader counting tests should see where the other one went.
    const withService = source.replace(
      '## scenario the median of three prices',
      `## port Quotes (outbound)
using in-memory

- find quote by id (id: uuid) -> Quote

## port Pricing (inbound)

- price it (id: uuid) -> decimal

## service PricingService
uses Quotes
implements Pricing

operation price it (id: uuid) -> decimal:
  let quote be find quote by id with id = id
  return median with quote = quote

## endpoint GET /quotes/{id}
handled by PricingService.price it
responds 200 with Quote

## scenario pricing through the service

given quote be Quote with id = "11111111-1111-4111-8111-111111111111", lines = [3, 1, 2]
when price it with id = "11111111-1111-4111-8111-111111111111"
then result is 2

## scenario the median of three prices`,
    );
    const files = generateProject(codeGenerators.require('typescript'), {
      project: projectOf(withService),
      outputDir: 'out/typescript',
      options: {},
    }).files;
    const test = files.find((file) => file.path.endsWith('scenarios.test.ts'))!.contents;

    expect(test).toContain('quote.median()');
    expect(test).toContain('pricing through the service — run by "haic test"');
  });
});

/**
 * A service scenario needs what the interpreter fakes: a store behind each
 * port, and something watching what was published.
 */
describe('a scenario over a service', () => {
  const source = `---
module: billing
context: Billing
---

# Billing

## aggregate Invoice
identified by id

- id: uuid, required
- total: decimal, required, min 0
- settled: boolean, required, default false

invariant "an invoice is worth something":
  total is greater than 0

operation settle () -> nothing:
  set settled to true

## event InvoiceSettled from Invoice
topic invoice-settled

- invoiceId: uuid, required

## error InvoiceNotFound (checked, status 404)
message: "no invoice {invoiceId}"

- invoiceId: uuid, required

## error AlreadySettled (checked, status 409)
message: "invoice {invoiceId} is settled"

- invoiceId: uuid, required

## command SettleInvoice targets Invoice
- invoiceId: uuid, required

## port Invoices (outbound)
using in-memory

- find invoice by id (id: uuid) -> Invoice or InvoiceNotFound
- save invoice (invoice: Invoice) -> nothing

## port Settling (inbound)

- settle invoice (command: SettleInvoice) -> Invoice or InvoiceNotFound, AlreadySettled

## service SettlementService
uses Invoices
implements Settling

operation settle invoice (command: SettleInvoice) -> Invoice or InvoiceNotFound, AlreadySettled:
  let invoice be find invoice by id with id = command.invoiceId
  when invoice.settled:
    fail with AlreadySettled using invoiceId = command.invoiceId
  perform settle with invoice = invoice
  perform save invoice with invoice = invoice
  publish InvoiceSettled with invoiceId = invoice.id
  return invoice

## endpoint POST /invoices/{invoiceId}/settle
handled by SettlementService.settle invoice
request SettleInvoice
responds 200 with Invoice
responds 404 when InvoiceNotFound
responds 409 when AlreadySettled

## scenario settling an invoice announces it

given invoice be Invoice with id = "99999999-9999-4999-8999-999999999991", total = 40
when settle invoice with command = SettleInvoice with invoiceId = "99999999-9999-4999-8999-999999999991"
then result.settled is true
and it publishes InvoiceSettled
`;

  const test = (text: string): string => {
    const files = generateProject(codeGenerators.require('typescript'), {
      project: projectOf(text),
      outputDir: 'out/typescript',
      options: {},
    }).files;
    return files.find((file) => file.path.endsWith('scenarios.test.ts'))?.contents ?? '';
  };

  const emitted = test(source);

  it('stands up an in-memory double for every port the service holds', () => {
    expect(emitted).toContain('class FakeInvoices implements Invoices {');
    expect(emitted).toContain('const invoices = new FakeInvoices();');
  });

  it('seeds the store from `given`, through the port that saves it', () => {
    expect(emitted).toContain('const invoice = new Invoice({');
    expect(emitted).toContain('await invoices.saveInvoice({ invoice: invoice });');
  });

  it('calls the service, not the inbound port it implements', () => {
    // The emitter resolves the phrase to the port inside the service; a test
    // holds the service itself, so the call is spelled out rather than lowered.
    expect(emitted).toContain('const settlementService = new SettlementService(invoices, eventPublisher);');
    expect(emitted).toContain('await settlementService.settleInvoice({ command:');
    expect(emitted).not.toContain('settling.settleInvoice');
  });

  it('watches what was published, because a `then` asked', () => {
    expect(emitted).toContain('class RecordingEventPublisher implements EventPublisher {');
    expect(emitted).toContain("assert.ok(eventPublisher.published.includes(\"InvoiceSettled\")");
  });

  it('leaves the scenario alone when a port asks for something a double cannot answer', () => {
    const exotic = source.replace(
      '- save invoice (invoice: Invoice) -> nothing',
      '- save invoice (invoice: Invoice) -> nothing\n- reconcile with the bank (id: uuid) -> nothing',
    );
    expect(test(exotic)).toBe('');
  });
});
