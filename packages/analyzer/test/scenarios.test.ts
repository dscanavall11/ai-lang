import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DiagnosticBag, formatDiagnostics, type IRModule } from '@haic/core';
import { parseModule } from '@haic/parser';
import { analyze, runScenarios } from '../src/index.js';

/** Parses and analyses a module, then runs whatever scenarios it declares. */
function run(body: string) {
  const source = `---\nmodule: test\ncontext: Test\n---\n\n${body}`;
  const bag = new DiagnosticBag();
  const { module } = parseModule('test.hadl', source, bag);
  if (bag.hasErrors || !module) {
    throw new Error(`unexpected parse errors:\n${formatDiagnostics(bag.items, new Map([['test.hadl', source]]))}`);
  }
  const analysis = analyze([module], { projectName: 'test' });
  const errors = analysis.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) throw new Error(formatDiagnostics(errors, new Map([['test.hadl', source]])));
  return runScenarios([module]);
}

const DOMAIN = `## enum State
- Open
- Done

## aggregate Task
identified by id

- id: uuid, required
- title: text, required, min length 1
- state: State, required, default Open

invariant "a task has a title":
  title is not empty

operation finish () -> nothing:
  set state to Done

## event TaskFinished from Task
- taskId: uuid, required

## error TaskNotFound (checked, status 404)
message: "no task exists with id {taskId}"
- taskId: uuid, required

## port TaskRepository (outbound)
using in-memory

- find task by id (id: uuid) -> Task or TaskNotFound
- save task (task: Task) -> nothing

## port TaskUseCases (inbound)
- finish task (id: uuid) -> Task or TaskNotFound

## service TaskService
uses TaskRepository
implements TaskUseCases

operation finish task (id: uuid) -> Task or TaskNotFound:
  let task be find task by id with id = id
  perform finish with task = task
  perform save task with task = task
  publish TaskFinished with taskId = task.id
  return task

## endpoint POST /tasks/{id}/finish
handled by TaskService.finish task
responds 200 with Task
responds 404 when TaskNotFound
`;

describe('running scenarios against the IR', () => {
  it('passes when the operation does what the scenario says', () => {
    const report = run(`${DOMAIN}
## scenario finishing a task

given task be Task with id = "t-1", title = "Ship it"
when finished be finish task with id = "t-1"
then finished.state is Done
and task.state is Done
and it publishes TaskFinished
`);
    expect(report.results.map((r) => [r.name, r.outcome, r.problems])).toEqual([['FinishingATask', 'passed', []]]);
    expect(report.ok).toBe(true);
  });

  it('reports both sides of a comparison that did not hold', () => {
    const report = run(`${DOMAIN}
## scenario finishing leaves it open

given task be Task with id = "t-1", title = "Ship it"
when finish task with id = "t-1"
then task.state is Open
`);
    expect(report.results[0]!.outcome).toBe('failed');
    expect(report.results[0]!.problems).toEqual(['this did not hold: "Done" equals "Open"']);
  });

  it('checks a declared failure, and the error it actually raised', () => {
    const passing = run(`${DOMAIN}
## scenario finishing one that is not there

when finish task with id = "t-2"
then it fails with TaskNotFound
`);
    expect(passing.results[0]!.outcome).toBe('passed');

    const failing = run(`${DOMAIN}
## scenario finishing one that is there

given task be Task with id = "t-1", title = "Ship it"
when finish task with id = "t-1"
then it fails with TaskNotFound
`);
    expect(failing.results[0]!.problems).toEqual(['expected it to fail with TaskNotFound, but it succeeded']);
  });

  it('treats an unexpected failure as a failure, not a pass', () => {
    const report = run(`${DOMAIN}
## scenario finishing a missing task

when finished be finish task with id = "t-2"
then finished.state is Done
`);
    expect(report.results[0]!.outcome).toBe('failed');
    expect(report.results[0]!.problems.join(' ')).toContain('failed unexpectedly with TaskNotFound');
  });

  it('enforces the field constraints the model declares', () => {
    const report = run(`${DOMAIN}
## scenario a task needs a title

when Task with id = "t-1", title = ""
then it fails with ConstraintViolation
`);
    expect(report.results[0]!.outcome).toBe('passed');
  });

  it('says which event was published instead of the expected one', () => {
    const report = run(`${DOMAIN}
## event TaskStarted from Task
- taskId: uuid, required

## scenario expecting the wrong event

given task be Task with id = "t-1", title = "Ship it"
when finish task with id = "t-1"
then it publishes TaskStarted
`);
    expect(report.results[0]!.problems).toEqual(['expected it to publish TaskStarted, but it published TaskFinished']);
  });

  it('is deterministic: now and new id do not vary between runs', () => {
    const source = `${DOMAIN}
## scenario identifiers are stable

when made be Task with id = new id, title = "Ship it"
then made.id is "00000000-0000-4000-8000-000000000001"
`;
    expect(run(source).results[0]!.outcome).toBe('passed');
    expect(run(source).results[0]!.outcome).toBe('passed');
  });

  it('marks a scenario it cannot execute as inconclusive, never as a pass', () => {
    // A declared operation the interpreter has no in-memory form of: the port
    // is real, the phrase is real, and no fake store can answer it.
    const report = run(`${DOMAIN}
## port Mailer (outbound)
using http-client

- send a letter (to: text) -> nothing

## service Postroom
uses Mailer

operation post a letter (to: text) -> nothing:
  perform send a letter with to = to

## scenario sending mail

when post a letter with to = "someone@example.com"
then it publishes TaskFinished
`);
    expect(report.results[0]!.outcome).toBe('inconclusive');
    expect(report.results[0]!.problems.join(' ')).toContain('did not run');
    // The run cannot be green while something in it never ran.
    expect(report.ok).toBe(false);
  });
});

describe('the worked CRUD example', () => {
  it('passes every scenario it declares', () => {
    const path = 'examples/crud/tasks.hadl';
    const text = readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');
    const bag = new DiagnosticBag();
    const modules: IRModule[] = [];
    const { module } = parseModule(path, text, bag);
    if (module) modules.push(module);
    expect(formatDiagnostics(bag.errors, new Map([[path, text]]))).toBe('');

    const report = runScenarios(modules);
    expect(report.results.filter((r) => r.outcome !== 'passed').map((r) => [r.name, r.problems])).toEqual([]);
    expect(report.passed).toBeGreaterThan(4);
  });
});
