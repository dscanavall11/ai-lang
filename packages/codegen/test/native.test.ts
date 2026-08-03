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
