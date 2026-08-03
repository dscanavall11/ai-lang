# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org);
while the major is `0`, the minor carries breaking changes.

## Unreleased

### An operation can be written in the target language

Some logic is not a design decision. A matching loop, a great-circle distance, a
sum that has to be exact in minor units: each has one correct form, and
restating it in design vocabulary is a translation nobody can check against the
original. Until now the language had no answer for that, and the reference said
so proudly — "no target-language escape hatch". In practice the logic did not
disappear; it moved into a hand-edited file beside the generated ones, where the
compiler could not see it, regenerate around it, or tell anyone it was there.

So an operation body may now be a fenced block, the same fence Markdown has
always had, with the language named on it:

````
operation total debited () -> Money:
  ```typescript
  const cents = this.postings.reduce((sum, p) => sum + Math.round(p.amount.amount * 100), 0);
  return new Money({ amount: cents / 100, currency: this.currency });
  ```

  return Money with amount = sum of postings by amount.amount, currency = currency
````

The block is emitted verbatim into the backend it names. Everything around it is
still the compiler's — the signature, the checked errors, the invariants, the
wiring — and every consequence of the choice is reported rather than assumed:

- statements written beside a block stay the reference implementation, and
  `haic test` runs those;
- an operation with only a block is `HADL2602`, because no scenario can reach
  it, and a scenario that tries is inconclusive rather than green;
- building a target no block covers is `HADL3060`, before a file is written;
- a name used only inside a block still counts as used, so `HADL2505` no longer
  calls a field dead when the block three lines below reads it.

One block per target, several targets per operation, and only inside an
operation — a fence anywhere else is `HADL1424` with the fix in the message.
[ADR-010](docs/decisions.md) records the reasoning and what would make us
revisit it.

### `haic build --language`

```bash
haic build src --language js
```

`--language` replaces the `target:` in the frontmatter for that build and takes
the name a person would write: `js`, `ts`, `py`, `golang`, `rs`, `node`, or any
backend id. `--target` still works and still takes ids. `haic targets` lists the
alternative spellings, and a name no backend can emit is refused rather than
guessed at.

### Three worked systems that are not CRUD

- `examples/matching` — a limit order book, matching by price-time priority, with
  the loop written in TypeScript and in Python and everything around it in HADL.
- `examples/ledger` — double-entry bookkeeping, where the balance rule is an
  invariant and the total is written twice: exact in cents for the backend,
  and in statements for the scenarios.
- `examples/dispatch` — courier assignment, with a haversine distance and a
  greedy sweep inside fences and the round's rules outside them.

Every example in the repository is now checked, run and compiled by the test
suite, so an example that stops working stops the build.

### Also fixed

- `min of` and `max of` were the two spellings `AGENTS.md` told writers to use
  and the parser did not accept. It accepts them now.
- The TypeScript backend escaped reserved words in property position, so a field
  named `symbol` was declared as `symbol` and read as `symbol_`. Only bindings
  are escaped now.
- An in-memory or SQL adapter read `.id` off whatever it was saving, which was
  wrong for any aggregate declaring `identified by <something else>`. It reads
  the declared identity.

## 0.2.1

The first complete release under the new names.

`0.2.0` published the six libraries and was refused the seventh:

```
403 Forbidden - PUT https://registry.npmjs.org/haic
Package name too similar to existing packages has,hapi,chai,cac,yalc,ai
```

Six packages sit inside an edit distance that short, so npm treats the name as a
possible typosquat. That threshold makes any brief unscoped name effectively
unobtainable, which is why the compiler now ships as `@haic/cli` alongside the
libraries it already shared a scope with.

Install with `npm install -g @haic/cli`. The command is still `haic`.

Also fixed: the editor manifest pointed at `snippets/hadl.json` while the file
on disk was still `snippets/ail.json`, so the extension contributed no snippets
at all — silently, because VS Code does not complain about a snippet path it
cannot resolve. A test now asserts every path the manifest declares exists.

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
