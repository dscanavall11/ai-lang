# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org);
while the major is `0`, the minor carries breaking changes.

## Unreleased

## 0.1.1

The command-line package is `@haic/cli`, not `hadl`.

npm refused the unscoped name: it normalises punctuation away when comparing,
so `hadl` collides with the pre-existing `ailang` and is rejected as a
possible typosquat. That check only runs at publish time — the registry answers
404 for the name right up until it refuses to give it to you.

So `0.1.0` reached npm as six libraries with no command-line tool. This release
is the same code under a name that can actually be published. Install it with
`npm install -g @haic/cli`; the command is still `haic`.

## 0.1.0

Six packages — `@haic/core`, `parser`, `codegen`, `iac`, `analyzer` and
`architect` — published. The CLI did not; see 0.1.1. Use 0.1.1 instead.

First release. The language works end to end: a design compiles to a service
that starts and answers correctly, and the compiler has 249 tests.

### The language

- Declarations: `aggregate`, `entity`, `value object`, `enum`, `dto`, `command`,
  `event`, `error`, `query`, `port`, `adapter`, `service`, `handler`,
  `endpoint`, `infrastructure`, `scenario`.
- Checked errors as contracts — declared on the signature, propagated by the
  compiler, with no `try` anywhere in the source.
- Full type inference over operation bodies. No null, no implicit any; absence
  is `optional`, narrowed with `when x is present:`.
- `from` builds one shape out of another by name, so a dto is never mapped field
  by field.
- Ports may carry their adapter inline with `using <tech>`.
- `## query` expresses a specification: one criterion per filter, and an absent
  optional drops its criterion.
- List projections: `each of items by productId` maps, `only items where …`
  filters.

### Tools

- `haic check` — six semantic passes, reporting exact spans and stable codes.
  `haic explain <code>` gives the reasoning behind any of them.
- `haic test` — runs the scenarios a design declares against the IR itself, in
  about a second, generating nothing. A scenario the interpreter cannot execute
  is reported as **could not run**, never as a pass.
- `haic build` — TypeScript, Java, Python and Go, each built by its real compiler
  in CI on every commit.
- `haic deploy` — Docker, Kubernetes, Terraform and AWS.
- `haic architect` — turns a requirements document into a reviewable spec and
  draft sources that satisfy the compiler that wrote them.
- `haic new` — a starter that compiles as written and whose scenarios are green.

### Known limitations

- **Rust does not compile.** The emitter does not model ownership. It runs in CI
  as an allowed failure so the gap stays measured. Do not pick it for real work.
- No `flat map`; a projection returning a list per element needs `for each`.
- A list literal cannot hold constructions — bind them first.
- No language server, so no diagnostics inside the editor.
- Publishing an event happens after the save with no transaction around the
  pair, while handlers may declare `delivery at-least-once`. The generated code
  does not yet keep that promise.
