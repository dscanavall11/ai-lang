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
    expect(emitted).not.toContain('has no generated implementation');
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
