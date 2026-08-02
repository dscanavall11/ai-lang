/**
 * Go rules the other backends do not have.
 *
 * Go is stricter than the languages it sits beside: a two-value call cannot be
 * rewrapped, and a local nobody reads is a compile error rather than a warning.
 * Both of these reached a public CI run before they were caught, so they are
 * pinned here where the failure is one second rather than one build.
 */
import { describe, expect, it } from 'vitest';
import { codeGenerators, generateProject } from '../src/index.js';
import { projectFrom } from './helpers.js';

const project = projectFrom(['examples/crud/tasks.ail'], 'tasks');
const result = generateProject(codeGenerators.require('go'), { project, outputDir: 'out/go', options: {} });
const source = result.files.map((f) => f.contents).join('\n');

describe('the go backend', () => {
  it('returns a fallible call straight through instead of rewrapping it', () => {
    // `return f(ctx), nil` is a tuple inside a tuple, which Go rejects.
    expect(source).toContain('return s.taskRepository.ListTasks(ctx)');
    expect(source).not.toMatch(/return s\.\w+\.\w+\(ctx[^)]*\), nil/);
  });

  it('discards a binding nothing reads, keeping only its failure', () => {
    // `let task be find task by id` before a delete exists for the not-found
    // check alone; declaring `task` would not compile.
    expect(source).toContain('if _, err := s.taskRepository.FindTaskByID(ctx, id); err != nil {');
  });
});
