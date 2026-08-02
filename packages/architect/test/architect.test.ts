import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DiagnosticBag, formatDiagnostics } from '@ai-lang/core';
import { analyze } from '@ai-lang/analyzer';
import { parseModule } from '@ai-lang/parser';
import { runArchitect } from '../src/index.js';

const path = 'examples/requirements/library.md';
const requirements = readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');
const result = runArchitect({ requirements, path, projectName: 'library' });

function drafts(): Array<{ path: string; contents: string }> {
  return result.files.filter((f) => f.path.endsWith('.ail'));
}

describe('the architect', () => {
  it('reads the actors and capabilities out of the stories', () => {
    expect(result.state.explore.capabilities.length).toBeGreaterThan(4);
    expect(result.state.explore.actors.map((a) => a.name)).toContain('member');
    expect(result.state.explore.glossary.map((g) => g.term)).toContain('Loan');
  });

  it('groups capabilities into bounded contexts', () => {
    expect(result.state.architecture.contexts.length).toBeGreaterThan(0);
    for (const context of result.state.architecture.contexts) {
      expect(context.module).toMatch(/^[a-z][a-z0-9]*$/);
      expect(context.kind).toMatch(/^(core|supporting|generic)$/);
    }
  });

  it('justifies its technology choice per context', () => {
    for (const stack of result.state.design.stacks) {
      expect(['java', 'typescript', 'python', 'go', 'rust']).toContain(stack.target);
      expect(stack.reason.length).toBeGreaterThan(0);
    }
  });

  it('writes the full spec directory', () => {
    const paths = result.files.map((f) => f.path);
    for (const name of [
      '.ai-spec/01-requirements.md',
      '.ai-spec/02-architecture.md',
      '.ai-spec/03-design.md',
      '.ai-spec/04-model.md',
      '.ai-spec/05-plan.md',
      '.ai-spec/06-open-questions.md',
      '.ai-spec/architecture.json',
    ]) {
      expect(paths).toContain(name);
    }
  });

  it('drafts at least one .ail module', () => {
    expect(drafts().length).toBeGreaterThan(0);
  });

  it('drafts sources that parse and analyse without errors', () => {
    const bag = new DiagnosticBag();
    const sources = new Map<string, string>();
    const modules = [];

    for (const draft of drafts()) {
      sources.set(draft.path, draft.contents);
      const { module } = parseModule(draft.path, draft.contents, bag);
      if (module) modules.push(module);
    }
    expect(formatDiagnostics(bag.errors, sources)).toBe('');

    const analysis = analyze(modules, { projectName: 'library' });
    expect(formatDiagnostics(analysis.diagnostics.filter((d) => d.severity === 'error'), sources)).toBe('');
  });

  it('produces a task plan ordered by layer', () => {
    const tasks = result.state.plan.tasks;
    expect(tasks.length).toBeGreaterThan(0);
    const known = new Set(tasks.map((t) => t.id));
    for (const task of tasks) {
      for (const dependency of task.dependsOn) expect(known.has(dependency)).toBe(true);
    }
  });

  it('records every assumption as an answerable question', () => {
    for (const question of result.openQuestions) {
      expect(question.question.length).toBeGreaterThan(0);
      expect(question.assumption.length).toBeGreaterThan(0);
      expect(question.line).toBeGreaterThan(0);
    }
  });

  it('is deterministic', () => {
    const again = runArchitect({ requirements, path, projectName: 'library' });
    expect(again.files).toEqual(result.files);
  });
});
