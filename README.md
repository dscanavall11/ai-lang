# AI-Lang

A programming language for AI to write software in.

Not an IDE. Not an agent. A language — with its own syntax, its own type system,
its own compiler, and its own opinions about what good software looks like.

```
## aggregate Order
identified by id
contains OrderItem
emits OrderPlaced

- id: uuid, required
- items: list of OrderItem, required
- status: OrderStatus, required, default Draft
- total: Money, derived

invariant "an order must hold at least one item":
  items is not empty

operation compute total () -> Money:
  return Money with amount = sum of items by quantity times unitPrice.amount, currency = "EUR"
```

That is the source. It compiles to Java, TypeScript, Python, Go or Rust, and to
the Docker, Kubernetes, Terraform or AWS artifacts needed to run it.

---

## Why

An AI asked to build a service in Java will write a service in Java. It will also
write four interfaces with one implementation each, a DTO that mirrors the entity
field for field, a service layer that forwards every call unchanged, and an error
hierarchy nobody throws. Every piece of it is defensible in isolation. Together
they are a codebase nobody asked for.

The problem is not that the model writes bad Java. It is that Java — and
TypeScript, and Python — will happily accept all of it. The language has no
opinion, so the only thing holding the design together is taste, and taste does
not survive a large enough prompt.

AI-Lang has opinions, and the compiler enforces them:

```
warning[AIL2503]: PlaceOrderService.fetch order only forwards "find order by id"
  --> src/orders.ail:88:3
  help: let the caller use the port directly, or add the rule this operation was meant to hold

warning[AIL2502]: dto OrderDto has exactly the same fields as aggregate Order
  --> src/orders.ail:41:1
  help: a dto exists to carry less than the model; either drop fields or reuse Order

error[AIL2207]: aggregate Order embeds aggregate Customer in field "customer"
  --> src/orders.ail:52:3
  help: store the identity instead: "- customerId: uuid, required"
```

Run `ail explain AIL2503` for the reasoning behind any of them.

---

## What it checks

| Family | What it enforces |
| --- | --- |
| **Types** | Full inference over operation bodies; no null, no implicit any |
| **DDD** | Aggregate boundaries, entity ownership, value-object purity, no I/O in the domain |
| **Errors** | Checked errors are declared, reachable, and mapped to a status at every endpoint |
| **Architecture** | Services depend on ports not adapters; every outbound port has an adapter; interface segregation; single responsibility |
| **Simplicity** | Unreachable declarations, duplicate shapes, pass-through operations, ports with no callers, fields nothing reads |

The first four are errors. The last family is warnings and notes — unused code is
a smell, not a contradiction. `ail check --strict` promotes them.

---

## Getting started

```bash
git clone https://github.com/dscanavall11/ai-lang.git
cd ai-lang
npm install
npm run build
npm link --workspace @ai-lang/cli
```

Then compile the worked CRUD and run it:

```bash
ail check examples/crud
ail build examples/crud --target typescript --out out
cd out/typescript && npm install && npm run dev
```

```
listening on http://localhost:8080
```

It serves for real, against an in-memory store:

```bash
curl -X POST localhost:8080/tasks -H 'content-type: application/json' \
  -d '{"title":"Buy milk","notes":null,"dueOn":null}'
# → 201 {"id":"74afa342-…","title":"Buy milk","state":"Open",…}

curl -X POST localhost:8080/tasks -H 'content-type: application/json' \
  -d '{"title":"","notes":null,"dueOn":null}'
# → 422 {"code":"CONSTRAINT_VIOLATION","message":"Task.title violates min length 1"}
```

That 422 came from one modifier in the source:
`- title: text, required, min length 1, max length 200`.

Before generating anything, run the design:

```bash
ail test examples/crud
```

```
tasks
  ✓ creating a task
  ✓ reading one that is not there
  ✓ a title must not be empty
  ✓ updating changes the title

7 passed
```

That runs the operations against the IR itself — no code generated, no toolchain,
no tokens. A scenario the interpreter cannot execute is reported as **could not
run**, never as a pass.

**→ [Build your own CRUD](docs/crud-tutorial.md)** — the whole path, step by step.

`ail new <name>` scaffolds a complete slice — one aggregate with a real
invariant, one port, one service, one endpoint — that compiles as written.

## Why write this instead of prompting for the code

The tasks example is **132 lines** of `.ail`. It produces **420 lines of
TypeScript** across 12 files, or **606 lines of Java** across 19 — before tests,
build files, or the compose stack that come with them.

You iterate on the 132 lines: small enough to hold in your head, and a mistake
there is a compiler error with a line number rather than a plausible-looking
paragraph. Only then do you spend the tokens to expand it. And the expansion is
deterministic — same source, same output, every time — so re-running it costs
nothing and reviewing it is a diff, not a re-read.

---

## Commands

| Command | Does |
| --- | --- |
| `ail new <name>` | Scaffold a project |
| `ail check [paths]` | Parse, type-check and audit the design |
| `ail test [paths]` | Run the declared scenarios against the IR — no code generated, no tokens spent |
| `ail build [paths] --target <lang>` | Generate the service |
| `ail deploy [paths] --target <platform>` | Generate the infrastructure |
| `ail architect <requirements.md>` | Turn a requirements document into a reviewable spec and draft sources |
| `ail ir [paths]` | Print the typed IR as JSON |
| `ail explain <code>` | Explain the reasoning behind a diagnostic |
| `ail targets` | List available targets |

---

## Editor support

A Visual Studio Code extension lives in [`editors/vscode`](editors/vscode):
highlighting, two-space indentation with guides, folding, and snippets for every
declaration. It is not on the Marketplace yet — copy the folder into your
extensions directory, or package it:

```bash
npx @vscode/vsce package
```

AI-Lang has almost no punctuation, so colour carries more of the load than in a
curly-brace language: it is what separates a declaration from the prose beside
it. The grammar uses standard TextMate scopes, so whatever theme you already run
will colour it without knowing the language exists.

No language server yet. The compiler already produces diagnostics with exact
source spans, so that is the obvious next step — see
[`editors/vscode/README.md`](editors/vscode/README.md).

---

## How it fits together

```
 .ail sources
      │
      ▼
   parser ──────────► AST            hand-written, line-oriented, no build step
      │
      ▼
  analyzer ─────────► diagnostics    six passes: symbols, architecture, types,
      │                              error flow, DDD, simplicity
      ▼
  typed IR (JSON)                    the single source of truth, diffable and reviewable
      │
      ├──► code generators ────────► Java · TypeScript · Python · Go · Rust
      └──► infrastructure ─────────► Docker · Kubernetes · Terraform · AWS
```

One IR, N backends — never source-to-source. Adding a language means registering
one more `CodeGenerator`; nothing existing changes.

Compilation is **deterministic**: no LLM calls, no network, no randomness. The
same source produces the same bytes. The AI Architect, which turns a requirements
document into a first draft, is a separate phase that runs before compilation and
writes a reviewable `.ai-spec/` directory rather than code.

---

## Repository layout

| Package | Holds |
| --- | --- |
| `packages/core` | IR schema, diagnostics, naming, emission primitives, registries |
| `packages/parser` | Lexer, expression and statement parsers, declaration parsers |
| `packages/analyzer` | The six semantic passes and the type checker |
| `packages/codegen` | One backend per target language |
| `packages/iac` | One generator per deployment platform |
| `packages/architect` | Requirements → bounded contexts → domain model → draft sources |
| `packages/cli` | The `ail` command |
| `editors/vscode` | Grammar, indentation and snippets for Visual Studio Code |

- [CRUD tutorial](docs/crud-tutorial.md)
- [Branching](docs/branching.md)
- [Language reference](docs/language-reference.md)
- [Worked example](examples/orders/orders.ail)

---

## Status

Working end to end, and early.

The worked examples compile to all five languages and all four platforms, and the
compiler itself has 243 tests.

Whether the emitted project then satisfies its own toolchain is a separate
question, so CI builds every one of them with the real compiler on every push:

| Target | Command | Result |
| --- | --- | --- |
| TypeScript | `tsc --noEmit` | passes |
| Java | `mvn compile` | passes |
| Python | `python -m compileall` | passes |
| Go | `go build ./...` | passes |
| Rust | `cargo check` | **experimental — does not compile** |

Rust is the honest exception. The emitter treats ownership as if it were not
there: it moves a value and then reads it, and writes `&mut self` methods that
move out of their own fields. Fixing it means teaching the backend to borrow,
which is real work and not yet done. It runs in CI as an allowed failure so the
gap stays measured rather than forgotten. **Do not pick Rust for anything real
yet.** The other four are built and verified on every commit.

Known gaps, in the order they matter:

- No `flat map`. `each of` and `only … where` cover map and filter; a projection
  that returns a list per element still has to be written as a loop.
- A list literal cannot hold constructions. `lines = [Line with id = "a", Line
  with id = "b"]` cannot be told apart from one construction with four
  arguments; bind them first and write `lines = [first, second]`.
- The architect's field-naming heuristic produces awkward names from long
  requirement sentences. It flags them as open questions rather than hiding them.
- Adapters generate real queries only for the four repository phrases they
  recognise. Everything else is left, explicitly, to the author.
- No language server, so no diagnostics in the editor.

## Licence

Apache-2.0.
