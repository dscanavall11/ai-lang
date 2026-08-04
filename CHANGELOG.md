# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org);
while the major is `0`, the minor carries breaking changes.

## 0.3.0 — 2026-08-04

### The release would have shipped a cli nobody could install

The publish step named its packages in a hand-written list, and the list was one
short: `@haic/lsp` was added this cycle and never placed in it, while
`@haic/cli` requires it. Publishing would have put a cli on the registry whose
dependency was not there, and `npm i -g @haic/cli` would have failed to resolve
it. `npm run release:dry` could not catch it, because the dry run publishes
`--workspaces` and the release loop does not — the two never described the same
set.

The list now has to prove it covers every package in `packages/` before anything
is published. Adding a ninth package fails the release until it is placed, which
is the half a script can check; placing it in the right dependency order is the
half that still needs a person.

Which is also why `haic --version` printed `haic 0.1.0` in 0.1.0, 0.2.0 and
0.2.1 alike: `VERSION` was a literal typed beside the thing it names, so
updating the package changed everything except the number it reported. It reads
its own manifest now, and so does the language server.

### `"t-1"` is a uuid, because the design says the field is one

A scenario names the things it sets up: `given task be Task with id = "t-1"`.
The field is declared `uuid`, and `"t-1"` is not one — so the interpreter, which
compares values rather than checking them, ran it happily, while the generated
TypeScript refused to compile it. The first fix was to write real uuids in the
examples, and the examples became unreadable: eight modules of
`"3f2504e0-4f89-41d3-9a0c-0305e82c3301"` where the point was to say *the first
task*.

The rule now: **a text literal standing where a uuid is declared becomes the
UUID version 5 of that text.** `"t-1"` is one uuid, `"t-2"` is another, they are
the same uuid every run, in the interpreter, in `haic ir`, in every backend and
in every compiled test. Nothing reads the digits of an identifier in a scenario;
everything compares it to itself. The conversion is written into the IR at type
inference, so `haic ir` shows the value that will actually run.

Which retires the escape hatch the last release shipped — a scenario whose
values a generated test would refuse no longer stays behind with the
interpreter, because there is no such scenario.

### A scenario is type-checked like an operation body

`given`, `when` and every `then` are now inferred by the same type checker that
reads an operation body, which they never were. The dispatch example wrote

```
when: assign the round with at = GeoPoint with latitude = 41.39, longitude = 2.16, capacity = 2
```

where the parser reads `capacity` as a third argument to the **GeoPoint**. The
interpreter shrugs at a field it does not know, so it passed `haic test` and
failed only once the scenario was compiled into a typed language — which is the
wrong end of the loop to find it at.

- `HADL2157` — a `then` that is not a yes or no, plus every type error the
  checker already knew how to report, now reaching scenario code;
- `HADL2158` — `then it fails with X` where `X` is no error this design
  declares;
- `HADL2159` — `then it publishes X` where `X` is no declared event.

Seventeen scenarios across the examples compile and run against the generated
TypeScript now, and the examples went back to reading like `"r-9"` and `"e-1"`.

### A scenario over a service compiles too

The last PR compiled scenarios over aggregate operations and left service ones
with the interpreter, because a service needs its ports wired and its events
watched. It gets both now, built the way the interpreter builds them: an
in-memory double per port, seeded from `given` through whichever port saves that
aggregate, and a publisher that records what it was handed so `then it publishes
X` has something to read.

The doubles are emitted by the same function that writes the real in-memory
adapter, so a test cannot pass against behaviour the project does not ship. A
port asking for something a double cannot answer — anything that is not find one
by id, save one, list them, delete one — leaves that scenario with the
interpreter and says so in the generated file.

That took the compiled scenarios from two to ten; the two sections above take
them to seventeen.

### `haic test --trace`, which is the debugger

```
  ✗ posting a balanced entry announces the movement
      this did not hold: 40 equals 41
    → post entry(command = PostEntry with entryId = "3333…")
      ⇄ JournalRepository.find journal entry by id
      ? when: no
      → total debited(journalEntry = JournalEntry with id = "3333…")
        ← Money with amount = 40, currency = "EUR"
      ! EntryPosted
```

The interpreter now reports what it did: the call, the branch it took, every
binding, every port it reached, everything published. `--trace` prints it for
scenarios that pass; a failing scenario prints it whether or not you asked,
because the step before a failure is the question being asked.

There is no breakpoint and no stepping, deliberately. A scenario runs in about a
millisecond, so the sequence is what is worth reading, and a trace you scan
afterwards beats a prompt you drive through it.

### Found by running the tests it generates

- the dispatch example wrote `at = GeoPoint with latitude = 41.39, longitude =
  2.16, capacity = 2`, where the parser reads `capacity` as a third argument to
  the **GeoPoint**. The example binds the point first now, which is what
  `AGENTS.md` already tells everyone to do — and the checking above is so that
  the next one is a diagnostic rather than a broken build;
- the in-memory query matcher is exported, because a test double answers a query
  by calling it rather than by carrying a second copy of it;
- `haic lsp` reported its version as a string typed next to the field that names
  it. It reads its own manifest now, which is the fix the CLI already had.

### The scenarios run inside the fence too

`haic test` runs scenarios against the IR, where a fenced block cannot execute.
That left the most interesting code in a design as the only code nothing ever
ran — and `HADL2602` could do no better than say so.

A scenario over an aggregate operation is now compiled into a test in the target
language, from the same `given`, the same call and the same expectations:

```
matching
  → a crossing order takes the resting price
      "match incoming" is written in typescript, python, so it runs in the generated project's tests

2 passed, 1 deferred to the target language
```

```bash
haic build src --ts --out out && cd out/typescript && npm test
# ok 1 - a crossing order takes the resting price
```

`deferred` is a fourth outcome, and it is neither a pass nor a failure: nothing
ran here, and something ran elsewhere. `HADL2602` stops firing for an operation
a compiled scenario reaches, because the warning means *nothing* exercises this.

TypeScript uses `node --test`, Python uses `unittest`; neither is a new
dependency, and the generated `npm test` now type-checks and runs them. A
scenario that calls a service stays with the interpreter — that needs its ports
wired and its events observed — and the generated file names it in a comment
rather than dropping it.

Two things surfaced the moment the blocks actually ran, which is the point:

- the Python block in `examples/matching` said `Side.Buy`, and the Python
  backend spells that member `Side.BUY`. It had never been executed;
- a literal keeps the type it looks like, not the type its field declares, so
  `id = "…"` reached a Python call as a bare string where a `uuid.UUID` was
  expected and compared equal to nothing. Literals are now retyped from the
  declaration before lowering — and the conversion rule at the top of this
  release is what makes the value itself acceptable.

Go, Java and Rust do not compile scenarios yet. The work is the same shape as
Python's uuid handling, one backend at a time, and until it is done they emit no
test file rather than an empty one.

### `haic build --java`, and the parser bug behind it

`haic build --java` was accepted, ignored, and answered with a TypeScript
project. The flag existed nowhere, so it was parsed as an unknown option and
dropped, and the build fell back to the target in the frontmatter.

`--java`, `--js`, `--py`, `--go`, `--rust` and every other language name are now
shorthand for `--language <name>`; two of them mean two targets. But the flag
was the symptom. Two things behind it were worse:

**The parser guessed which flags take a value.** Any flag swallowed the next
word unless it began with a dash, so `haic fmt --check src` parsed as
`--check=src` with no paths at all — and then formatted the current directory
instead of checking the one you named, because `--check` held a string rather
than `true`. `haic check --strict src`, `haic build --dry-run src` and
`haic test --only x src` had the same shape. Which flags take a value is now
read from each command's own help text, so the documentation is load-bearing and
a flag written `--out <dir>` takes an argument while `--strict` does not.

**An unknown flag was silently ignored.** `haic build --jav` now exits 2 and
says so. A command that quietly does something other than what was asked is the
one outcome worse than failing.

### A default has to be of the field's type

```
- hits: integer, required, default false
```

was accepted in full, and reached the backends as `int hits = false` in Java and
a TypeScript field whose declared type and initial value disagreed. Nothing
checked a constraint against the type it constrains.

Now `HADL2155` reports a default that is not of the field's type — a number for
text, `false` for an integer, a fraction for a whole number, an enum member the
enum does not have, a literal for a shape that is built from its fields, or
`nothing` on a required field — and says what to write instead. `HADL2156`
reports a constraint that cannot apply at all: a length on a number, a range on
text, a pattern on a uuid.

The check lives in the type pass rather than the parser because `default Draft`
is only meaningful once enums are resolved.

### Four defects in the fenced-block feature

Found by using it, in the order they matter.

**A block in a `## adapter` was silently dropped by three backends.** Java and
Python read `adapter.operations`; TypeScript, Go and Rust never did. So a block
written for the one place the compiler already admits it cannot generate a body
reached two targets and vanished for the other three — the generated method
threw "no generated implementation" while the implementation sat in the source
file, ignored. No diagnostic fired, because from the IR's point of view the body
was there.

The lookup is now one function in `shared/adapters.ts` that all five backends
call, so a sixth cannot forget it, and a test emits the same adapter to every
backend and asserts the placeholder is gone.

**A fence walked around `HADL2213`.** No I/O in the domain is enforced by
reading the statements of an aggregate operation, and a block has none — so the
rule the language is most serious about stopped applying exactly where the code
gets interesting. An aggregate operation whose block names a declared port is
now `HADL2604`, matching the casings a backend would actually write
(`OrderRepository`, `orderRepository`, `order_repository`). It is a warning
rather than an error because the compiler is matching words, not reading code,
and the message says what it saw rather than what it concluded.

**Rust decided `&mut self` from a body that was not there.** `mutatesSelf` reads
statements, so an operation written as a Rust block got a shared borrow and code
that assigns to a field could not compile. A Rust block now takes `&mut self`: a
borrow stricter than necessary costs nothing, and the other guess does not
build.

**Nothing proved a `java` or `go` block reached its own backend.** The examples
carried only TypeScript and Python. `examples/ledger` now writes `total debited`
three times — statements, a TypeScript block and a Java block, each exact in its
own language's minor-unit arithmetic — so CI compiles a real Java block with
Maven, and the adapter test covers all five backends.

### A language server, which is the compiler

```bash
haic lsp
```

An editor now gets the compiler's own answers: diagnostics as you type, with
their codes and their `help:` lines, across the whole project rather than one
file at a time; go to definition on any declared name; hover that says what a
declaration declares — and which language an operation is written in when it
carries a fenced block; an outline of every declaration; completion that follows
the rule the language follows, where a heading takes a declaration keyword, a
clause line takes a clause, an indented line takes a statement, and after `:` or
`->` the answer is a type.

It is a subcommand rather than a separate binary on purpose. A language server
is the second implementation a language grows, and the second implementation is
where the two begin to disagree — the editor accepting what CI rejects. There is
no second implementation here: the server parses and analyses with the same
passes as `haic check` and formats with the same code as `haic fmt`, so the
squiggle under a line and the failure in CI are the same diagnostic. The
Visual Studio Code extension launches it and implements nothing itself, which
also means it has no version of its own to be behind.

The protocol layer is eighty lines and hand-written, like the argument parser
and for the same reason. It is tested where these things actually break: a
header split across two chunks, two messages glued into one, and a body measured
in bytes rather than characters.

[ADR-011](docs/decisions.md) records the reasoning, including why it re-analyses
everything on every keystroke instead of keeping a cache.

### `haic fmt`

```bash
haic fmt src
haic fmt src --check     # for CI: report, write nothing, exit non-zero
```

No options. It normalises indentation, blank lines, the frontmatter and the
spacing of a field bullet, and it touches nothing else: prose is never reflowed,
expressions are left exactly as written, an inline `// comment` keeps the
spacing it was aligned with, and a fenced block is moved as one piece with its
contents unedited — or left where it is, if a line inside it starts at column
zero and the block cannot absorb the shift.

Formatting a whitespace-sensitive language is only safe with a guarantee, and
this one is a test rather than a promise: **formatting never changes the IR a
file parses to.** The suite checks it on every example. It also checks that the
examples are already canonical — as is everything `haic new` and
`haic architect` write, which is now enforced too.

[ADR-012](docs/decisions.md) records what it is allowed to change and why the
list is that short.

### Also

- The Visual Studio Code extension has a client: format on save, diagnostics,
  hover, go to definition, outline and completion, all served by `haic lsp`. It
  finds the compiler in the workspace's `node_modules`, in the checkout, or on
  `PATH`.
- The test that keeps the editor manifest honest now checks `main` as well, so
  an extension that activates into nothing fails the build instead of failing
  quietly — which is exactly how the snippets path broke in 0.2.1.

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
