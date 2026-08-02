# Contributing to AI-Lang

Thanks for looking. This project is early enough that a good bug report is worth
as much as a patch.

## The short version

```bash
git clone https://github.com/dscanavall11/ai-lang.git
cd ai-lang
npm install
npm run build
npm test
```

Then compile the worked example and read what comes out:

```bash
node packages/cli/dist/bin.js check examples
node packages/cli/dist/bin.js build examples --target typescript --out out
```

## Where things live

| Package | Holds | Change it when |
| --- | --- | --- |
| `packages/core` | IR schema, diagnostics, naming, emission | the language gains a construct |
| `packages/parser` | lexer, expressions, statements, declarations | the surface syntax changes |
| `packages/analyzer` | six semantic passes and the type checker | a rule is added or relaxed |
| `packages/codegen` | one backend per target language | a language's output is wrong |
| `packages/iac` | one generator per deployment platform | infrastructure output is wrong |
| `packages/architect` | requirements → contexts → model → drafts | the elicitation heuristics change |
| `packages/cli` | the `ail` command | a command or flag changes |

## The rules this codebase holds itself to

They are the same ones the compiler enforces on its users, which is the point.

- **Open/closed.** Adding a language means registering one more `CodeGenerator`.
  Adding a rule means adding one more `SemanticPass`. If your change requires
  editing five existing files, the seam is in the wrong place — say so in the PR
  and we will move it.
- **YAGNI.** No abstraction without a second caller. No option without a user.
- **English everywhere** — identifiers, strings, comments, commit messages.
- **Comments explain why, not what.** One line, and only where the code cannot
  say it itself. Match the density of the file you are editing.
- **No new runtime dependencies** without a paragraph in the PR explaining what
  it buys and what it would take to drop it later.

## Adding a language backend

The cheapest way in. Read `packages/codegen/src/targets/typescript/` first — it
is the reference — then:

1. Subclass `LanguageEmitter`. It owns the walk over statements and expressions;
   you implement roughly twenty small methods that decide surface syntax.
2. Write the file emitters: domain, application, infrastructure, interface.
3. Register the generator in `packages/codegen/src/index.ts`. That is the only
   existing file you touch.
4. Add the target to the `generated` matrix in `.github/workflows/ci.yml` with
   the command that compiles its output.

The `cross-target` test suite runs against every registered backend
automatically, so you inherit about a dozen tests the moment you register.

**The bar is that the generated project compiles with its real toolchain.** Not
that it looks right — that `mvn compile`, `go build`, `cargo check` pass in CI.

## Adding a semantic rule

1. Add a pass under `packages/analyzer/src/passes/`, or a check inside an
   existing one if it belongs to the same family.
2. Claim a code from the ranges documented in
   [the language reference](docs/language-reference.md#7-diagnostic-codes).
3. **Every diagnostic needs an actionable hint.** "X is invalid" is not a
   diagnostic; "X is invalid, write Y instead" is.
4. Design rules that a reader might argue with go in the `ail explain` catalogue
   at `packages/cli/src/commands/explain.ts`, with the reasoning, not a slogan.
5. Add a test to `packages/analyzer/test/design-rules.test.ts` proving it fires,
   and one proving it does *not* fire on the correct shape. The second matters
   more: a rule with false positives gets suppressed, and a suppressed rule
   teaches nothing.

Structural rules (boundaries, contracts, dependency direction) are errors.
Simplicity findings are warnings. See
[ADR-006](docs/decisions.md) before proposing to change which is which.

## Changing the language itself

Syntax and semantics changes need more than a patch:

1. Open an issue using the **Language proposal** template first. Say what you
   cannot express today and what you would write instead.
2. Changes to `IRType`, `IRStatement` or `IRExpression` ripple into all five
   backends. Expect to update them all in the same PR.
3. Update `docs/language-reference.md` in the same PR. The reference is the
   specification; code that disagrees with it is the bug.
4. If the change is a decision with trade-offs, add an ADR to
   `docs/decisions.md`: what was decided, what it rules out, what would make us
   revisit it.

## Branching

Work lands on `develop` through a pull request; `main` is what is released.
Both are protected, so neither takes a direct push. See
[docs/branching.md](docs/branching.md) for the full flow.

```bash
git switch develop && git pull
git switch -c feature/<name>
```

## Before you open a PR

```bash
npm run build   # every package type-checks
npm test        # the whole suite
node packages/cli/dist/bin.js check examples   # the examples still pass
```

Commit messages: imperative mood, one line, lower case after the prefix —
`parser: keep "by" inside operation phrases`.

## What gets rejected

- Output that does not compile with the target's own toolchain.
- A rule without a hint, or with a hint that restates the error.
- An abstraction with one implementation and no second caller in sight.
- Configuration for something the `.ail` source already states. See
  [ADR-009](docs/decisions.md).
- Generated code that guesses. If the compiler cannot know, it says so in the
  output, at the line where a human has to act.

## Reporting a bug

Include the `.ail` source that reproduces it — the smallest one you can get to —
and what you expected instead. A failing `.ail` file is a better bug report than
any description of it.
