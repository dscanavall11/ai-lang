# Architecture decisions

Each entry records what was decided, what it rules out, and what would make us
revisit it. Decisions that deviate from the original plan say so explicitly.

---

## ADR-001 — A hand-written parser, not ANTLR4

**Decision.** The parser is a hand-written lexer plus recursive-descent parser in
TypeScript. No parser generator, no grammar file, no code generation step.

**Deviates from the plan**, which specified ANTLR4 with semantic predicates.

**Why.** HADL's surface syntax is line-oriented and indentation-sensitive:
Markdown headings open declarations, bullets declare fields, a trailing `:` opens
a block. That is the shape a parser generator is worst at. ANTLR would have meant
a Java toolchain in the build, a generated-code checkout step, and a grammar
fighting the very whitespace sensitivity that makes the language readable — while
the actual ambiguity in the language is resolved by a single lexical rule
(capitalised means type) that needs no lookahead at all.

The hand-written parser is also what makes the diagnostics good: every parse
function has the source line in hand, so it can point at a column and suggest a
fix. Generated parsers produce "mismatched input" and leave the rest to you.

**Rules out.** Machine-checkable grammar documentation, and grammar reuse by
third-party tooling.

**Revisit if** we need an incremental parser for an editor, in which case
tree-sitter — not ANTLR — is the right answer, running alongside this one.

---

## ADR-002 — One typed IR, N backends

**Decision.** Every backend consumes the same JSON-serializable IR. There is no
source-to-source path between targets.

**Why.** Five languages and four deployment platforms is nine backends. Pairwise
lowering would be 5 × 4 = 20 translators that all drift apart. One IR makes each
backend independent, and makes the IR itself the reviewable artifact: `haic ir`
prints something a person can read and diff.

**Rules out.** Target-specific source constructs. If a backend needs something
the IR cannot express, the IR grows — which forces the question of whether every
other target can express it too. That friction is the point.

---

## ADR-003 — Compilation is deterministic; the architect is a separate phase

**Decision.** `haic check`, `haic build` and `haic deploy` make no LLM calls, no
network requests, and use no randomness. The same input produces the same bytes.
`haic architect`, which turns a requirements document into a first draft, is a
separate command that writes a reviewable `.ai-spec/` directory.

**Why.** A compiler that consults a model is a compiler whose output you cannot
review, cache, or reproduce in CI. Keeping the non-deterministic step upstream
and visible means the artifact a human reviews is the spec, not the diff of a
regenerated codebase.

---

## ADR-004 — Checked errors are contracts; unchecked errors are defects

**Decision.** `## error X (checked)` becomes part of every operation signature
that can raise it, and every endpoint that exposes it must map it to a status.
`## error X (unchecked)` may never appear in a signature.

**Why.** Java's checked exceptions failed because `throws Exception` was legal
and `catch (Exception e) {}` was easy. HADL closes both: an operation declares
exactly the errors it raises — no more (`HADL2304`) and no fewer (`HADL2303`) —
and there is no catch construct at all. Errors propagate; the only place they
stop is an endpoint, which must say what status each one becomes.

**Rules out.** Recovering from an error mid-operation. That is deliberate: an
operation that can continue past a failure was two operations.

**Revisit if** real programs need a recovery construct. The shape would be
`attempt <call> otherwise <statements>`, not a catch-all.

---

## ADR-005 — Each backend picks its own error idiom

**Decision.** The IR models checked errors uniformly; each backend lowers them
into whatever its ecosystem already does. Java uses checked exceptions,
TypeScript and Python use typed thrown errors with a central handler, Go uses
`(T, error)`, Rust uses `Result<T, E>`.

**Why.** The compile-time guarantee is already delivered — by HADL, before any
target code exists. What the generated code owes its readers is idiom. A
`Result<T, E>` union hand-rolled in Java would be correct and unreadable.

---

## ADR-006 — Simplicity findings are warnings, not errors

**Decision.** Everything in the `HADL25xx` family — unreachable declarations,
duplicate shapes, pass-through operations, ports with no callers, fields nothing
reads — is a warning or a note. `haic check --strict` promotes them.

**Why.** Unused code is a smell, not a contradiction. A rule that blocks the
build on a smell gets suppressed, and a suppressed rule teaches nothing. A rule
that names the cost in a sentence, with `haic explain` behind it, changes what
gets written next time.

The exception is the structural rules — aggregate boundaries, error contracts,
dependency direction. Those are errors, because a program that violates them is
not merely untidy; it will not behave as its own source claims.

---

## ADR-007 — Zod schemas are the IR's source of truth

**Decision.** The IR is defined as Zod schemas; TypeScript types are derived with
`z.infer`. The analyzer validates the finished IR against the schema before
handing it to any backend.

**Why.** The IR is a published artifact — external tools and models will write
it. Hand-rolled validation would have been a second copy of the type definitions
to keep in sync, which is exactly the duplication this project exists to argue
against.

**Cost.** One runtime dependency, and recursive types need `z.lazy` plus an
explicit interface. Accepted.

---

## ADR-008 — Adapters generate real code where the phrase is recognisable

**Decision.** For repository phrases a backend recognises — `find … by id`,
`save …`, `list …`, `delete … by id` — it emits working queries. For anything
else it emits a body that says, in the generated code, that no implementation was
generated and that this is where to write it.

**Why.** The alternative was to guess, and a guessed query that compiles is worse
than no query at all: it looks finished. Naming the gap in the file, at the exact
place a human has to act, is the honest option.

---

## ADR-009 — No configuration for what the language already says

**Decision.** There is no `haic.config.js`, no per-target options file, no
codegen templates. `haic build --target java` reads the `.hadl` sources and emits.

**Why.** Every knob is a way for the generated system to disagree with its
source. The `.hadl` file already says which database, which port, which scaling
policy, which deployment targets. A configuration layer on top would let those
two descriptions drift, and the whole premise is that they cannot.

**Revisit if** a real project needs environment-specific overrides. The answer
would be environment values injected at deploy time, not a second source of
truth at build time.

---

## ADR-010 — One escape hatch: a fenced block, per operation, per target

**Decision.** An operation body may be a fenced code block naming a target
language. The block is emitted verbatim into that backend and nowhere else.
Statements may be written beside it; when they are, they remain the reference
implementation that `haic test` runs. Everything the choice costs is reported:
an operation with only a block is `HADL2602`, a target with no body for it is
`HADL3060`, and a scenario that reaches one is inconclusive, never green.

**Deviates from** the earlier stated position that there is no target-language
escape hatch at all.

**Why.** The premise of the language is that a compiler should write the code a
design implies. That premise holds for structure — layering, mapping, wiring,
validation — and it holds for rules, which is why invariants and checked errors
belong in the source. It does not hold for algorithms. A price-time matching
loop, a great-circle distance, a sum that must be exact in minor units: each has
one correct form, already written down somewhere, and expressing it in design
vocabulary produces a translation nobody can check against the original.

Without a hatch, that logic does not disappear. It moves into a hand-edited file
next to the generated ones, where the compiler cannot see it, cannot regenerate
around it, and cannot tell anyone it exists. A declared hole is better than an
undeclared one.

The rules exist to keep the hole a hole rather than a second language living
inside the first. It attaches to an operation, so the signature, the checked
errors and the invariants stay the compiler's. It names its target, so building
another one fails loudly instead of emitting a method that quietly does nothing.
And the compiler keeps saying, on every check, which parts of the design it can
no longer run.

**Rules out.** Blocks in handlers, invariants and scenarios; more than one block
per target on one operation; any promise that a design using them is portable.

**Revisit if** the escape hatch starts carrying orchestration rather than
algorithms. That would mean the language is missing something structural, and
the answer is to add it to the language rather than to widen the hatch.

---

## ADR-011 — The editor runs the compiler, not a copy of it

**Decision.** `haic lsp` is a subcommand of the compiler, and the Visual Studio
Code extension launches it rather than implementing anything itself. The server
parses and analyses with the same passes as `haic check`, and formats with the
same code as `haic fmt`. It re-analyses the whole project on every keystroke,
and holds no incremental cache.

**Why.** A language server is the second implementation a language grows, and
the second implementation is where the two start to disagree: the editor accepts
what CI rejects, and the author is told two different stories about the same
line. Shipping the server inside the compiler removes the possibility rather
than managing it. There is also nothing to install and nothing to keep in step —
the extension has no version of its own to be behind.

Re-analysing everything is the same argument in the small. A cache is a third
opinion about what the file says, and the failure mode is a stale squiggle that
outlives the fix. Analysing eight modules takes a few milliseconds, which is
under the threshold where anyone notices, so the honest version is also the fast
enough one.

**Rules out.** Editor features that need information the compiler does not keep,
notably renaming across files, and anything requiring sub-millisecond response
on a project far larger than the examples.

**Revisit if** a real project makes the keystroke path slow. The answer then is
an incremental analyzer inside the compiler — which `haic check` would benefit
from too — never a separate index that only the editor trusts.

---

## ADR-012 — The formatter guarantees the IR, not the bytes

**Decision.** `haic fmt` rewrites layout: indentation, blank lines, the spacing
of a field bullet, the frontmatter. It does not reflow prose, does not rewrite
expressions, and does not edit inside a fenced block — a block is moved as one
piece or left alone. It has no options. The property it promises is checked by
tests: formatting never changes the IR a file parses to.

**Why.** HADL is whitespace-sensitive in a way most languages are not — a blank
line separates clauses from prose, indentation opens a body, a heading opens a
declaration. A formatter here can silently change what a file means, which is
why the guarantee is stated in terms of the IR and not in terms of a style
guide. If the two disagree, the IR wins and the style loses.

Prose is excluded for a different reason. It is not decoration: it survives into
the generated code as documentation, and its line breaks are the author's. A
formatter that reflows paragraphs would make every documentation edit a diff
nobody can read.

No options, because a formatter with options is a formatter that gets argued
about in review, which is the cost it was adopted to remove.

**Rules out.** Aligning columns, sorting declarations, wrapping long lines, and
any normalisation of the code inside a fence.

**Revisit if** the canonical layout and the examples ever disagree. That is a
bug in one of them, and the test that compares them says which.
