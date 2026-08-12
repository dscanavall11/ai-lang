# Backlog

What we intend to build, in the order we intend to build it, and the argument
each entry survived to get here. Every entry carries the red-team note that
shaped it — the objection that was raised before it was accepted, kept so the
objection does not have to be rediscovered when the work starts.

An entry graduates out of this file into an ADR when its trade-offs get
decided, and into the changelog when it ships.

---

## Now

### 1. The build says what it did not generate — **shipped**

An adapter operation whose phrase is not one the compiler recognises — find one
by id, save one, list them, delete one, or a declared query — is emitted as a
placeholder that throws (`UnsupportedOperationException` in Java,
`NotImplementedError` in Python, `unimplemented!` in Rust). The throw is
correct: failing loudly beats a method that silently does nothing. What is
wrong is that the build is silent about it. `✓ 106 files` and three of those
files are time bombs; "build succeeded" and "project complete" read as the same
statement and are not.

- `HADL3061`, a warning per placeholder operation, naming the adapter, the
  target, and the two ways out: a fenced block in the `## adapter` (which is
  copied into the generated method), or `in-memory` while it does not matter.
- A build summary line: `3 methods need a hand-written body`, listed.
- The placeholder message in all five backends names the fenced block too.
- In `haic explain`, because a reader may reasonably ask why the compiler did
  not just write the method.

**Red team:** a warning, never an error — an early skeleton is a legitimate
state for a project to be in. The failure being fixed is invisibility, not the
placeholder itself.

### 2. Symbolic checking, bounded by witnesses — **shipped** (ADR-014)

`- hits: integer, at least 1, default 0` passes today: `HADL2155` compares the
default's *type*, and nothing compares its *value* against the constraints
beside it. The same blindness lets contradictory constraints coexist
(`at least 5, at most 3`), lets a branch condition be provably never true, and
lets a scenario `given` construct a value an invariant forbids — each one a
defect this project has been finding one at a time, downstream, in generated
code.

A small domain analysis over field constraints closes the class: intervals for
numbers, length ranges for text, member sets for enums.

- `HADL2160` constraints that contradict each other;
- `HADL2161` a default outside the constraints beside it;
- `HADL2162` a condition that is provably always or never true;
- `HADL2163` a scenario `given` that violates a declared invariant.

**Red team:** the trap is the general inference engine — undecidable, slow, and
wrong in ways a user cannot argue with. The rule that keeps this honest, to be
fixed in an ADR before the first line: **every finding carries a concrete
witness** ("with `quantity = 0`, this invariant is false"), and an analysis
that cannot construct the witness stays silent. A warning you cannot verify
with a value in hand is worse than none.

### 3. "Did you mean", not synonyms

The request behind "accept more ways of writing a use case" is real; granting
it with grammar is the wrong instrument. Everything in this project chose
canonical form — the formatter has no options, the language has no
configuration — because two files that say the same thing differently is a cost
paid on every diff forever. And the stated audience is AIs writing design: a
generator does not need synonyms, it needs a strict target. Strictness is a
feature.

What buys the ergonomics without the cost: parse errors that suggest. The
parser owns the clause table already; edit distance over it turns
`given order is Order` into `did you mean "be"?`. If evidence accumulates that
everyone writes some variant, that variant graduates: the parser accepts it and
`haic fmt` rewrites it to the one canonical form. Synonyms at the keyboard,
never in the repository.

**Red team of the red team:** measure before graduating anything. The clause
table is small on purpose; every alias admitted is one more answer the LSP has
to rank and one more line in the reference.

---

## Next: the context map should compile

The frontmatter already declares it — `imports: Catalogue via
anti-corruption-layer exposing Product` — the analyzer validates it, the
architect draws it. **No backend generates anything from it.** It is the
largest declaration in the language that compiles to nothing, and it is
exactly the microservices story.

### 4. A typed client per import

Feign exists because in an ordinary microservice the client is written by hand
against a contract that lives in another repository, and the two drift. HADL
does not have that problem: both sides of the boundary are in the same IR. An
import should generate, for the consumer, an outbound port shaped by what the
provider `exposes` — and an HTTP client adapter for it derived from the
provider's *endpoints*, so the server route and the client call cannot
disagree by construction. The anti-corruption layer becomes a generated
translation scaffold with one obvious place to write the mapping; `conformist`
skips the scaffold; `shared-kernel` shares the types outright, which is what
the relationship means.

**Red team:** do not bake Feign in. Each backend speaks its own idiom
(ADR-005) and the default client should cost zero dependencies — JDK
`HttpClient`, `fetch`, `requests`. `using feign` can join `using redis` as a
technology choice if demand shows up. Deeper: a synchronous call between
contexts is a *coupling decision*, and the relationship in the map — not the
codegen — is where that decision belongs.

### 5. Events that cross the boundary

Events publish and nothing declared can consume them: there is no way to say
that Dispatch reacts to Sales' `OrderPlaced`. A consuming declaration would
generate the handler skeleton on one side, the broker topic in the IaC that
already exists (compose, k8s, terraform), and the wiring between.

**Red team:** delivery semantics first, codegen second. At-least-once plus an
idempotency slot in the generated handler is the honest contract;
exactly-once is a promise the runtime cannot keep and the ADR must say so
before the first backend emits a consumer.

### 6. `haic diff` — contract evolution as a compiler question

Two versions of a design; the compiler says what broke: a removed field, a
narrowed type, a new required parameter, an endpoint gone. In a microservices
world this is the question every deploy asks, and HADL can answer it from the
IR alone — no service registry, no schema registry, no convention.

**Red team:** scope it to the *exposed* surface (endpoints, exposed types,
events). Diffing whole designs invites a wall of noise about internals that no
consumer can observe.

---

## Later

### 7. The backends catch up on scenarios

Python compiles only aggregate scenarios — service ones need
`IsolatedAsyncioTestCase`, which is the same shape TypeScript already has with
`node --test`. Go, Java and Rust compile none. Until each one does, it emits no
test file rather than an empty one, and the generated file names what it
skipped. (The `await` outside `async def` that reached CI is the cautionary
tale: a generated test that is never executed by its own toolchain is not yet
a test.)

### 8. Rust learns to borrow

The standing red check. The emitter moves a value and then reads it, and
writes `&mut self` methods that move out of their own fields. The fix is a
real ownership pass, not another `continue-on-error`. Until then the check
stays visibly red and the README stays honest about it.

### 9. Observability in the generated services

Every port call is already the interesting boundary — the trace feature proved
it at design time (`haic test --trace`). The generated services should say the
same things at runtime: a span per port call, structured logs at the
composition root, a metrics endpoint the k8s manifests already know how to
probe.

**Red team:** zero-dependency default. OpenTelemetry is a heavy opinion;
`--otel` can be the opt-in, plain structured logging the floor.

### 10. Auth is a hole, on purpose — but a declared one

Endpoints have no auth story. The language should be able to say
`requires role admin` and map refusal to 401/403 in every backend — but the
compiler should generate the *port* that answers "who is calling?", never the
identity provider behind it. Auth is the adapter pattern's home game.

### 11. Schema out of the aggregates

The postgres adapters write SQL against tables nothing creates. The aggregate
declarations carry everything an initial DDL needs. `haic diff` (entry 6)
then turns model changes into migration skeletons.

**Red team:** generate DDL, never apply it. The compiler is deterministic and
stateless; a migration is neither, and pretending otherwise is how generated
migrations earn their reputation.

### 12. An incremental analyzer

ADR-011 named its own revisit condition: when a real project makes the
keystroke path slow. The LSP re-analyses everything on every change today,
which is honest and fast at eight modules. The fix, when it is needed, lives
in the compiler so `haic check` gets it too — never a separate index only the
editor trusts.
