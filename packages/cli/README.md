# HADL

A programming language for AI to write software in.

Not an IDE. Not an agent. A language — with its own syntax, its own type system,
its own compiler, and its own opinions about what good software looks like.

```bash
npm install -g @haic/cli
haic new my-store
```

## What the source looks like

```
## aggregate Order
identified by id
contains OrderItem
emits OrderPlaced

- id: uuid, required
- items: list of OrderItem, required
- status: OrderStatus, required, default Draft
- total: Money, optional

invariant "an order must hold at least one item":
  items is not empty

operation compute total () -> Money:
  return Money with amount = sum of items by quantity times unitPrice.amount, currency = "EUR"
```

That compiles to Java, TypeScript, Python or Go, and to the Docker, Kubernetes,
Terraform or AWS artifacts needed to run it. Compilation is deterministic: no
model calls, no network, no randomness. The same source produces the same bytes.

## Why

An AI asked to build a service in Java will write a service in Java. It will
also write four interfaces with one implementation each, a DTO that mirrors the
entity field for field, a service layer that forwards every call unchanged, and
an error hierarchy nobody throws. The problem is not that the model writes bad
Java — it is that Java will happily accept all of it.

HADL has opinions, and the compiler enforces them:

```
warning[HADL2503]: PlaceOrderService.fetch order only forwards "find order by id"
  --> src/orders.hadl:88:3
  help: let the caller use the port directly, or add the rule this operation was meant to hold

error[HADL2207]: aggregate Order embeds aggregate Customer in field "customer"
  --> src/orders.hadl:52:3
  help: store the identity instead: "- customerId: uuid, required"
```

## Commands

| Command | Does |
| --- | --- |
| `haic new <name>` | Scaffold a project that compiles as written |
| `haic check [paths]` | Parse, type-check and audit the design |
| `haic test [paths]` | Run the declared scenarios against the IR — no code generated, no tokens spent |
| `haic build [paths] --target <lang>` | Generate the service |
| `haic deploy [paths] --target <platform>` | Generate the infrastructure |
| `haic architect <requirements.md>` | Turn a requirements document into a reviewable spec |
| `haic explain <code>` | Explain the reasoning behind a diagnostic |

`haic test` is the one worth knowing about. It runs the operations against the
IR itself — about a second, no code generated, no toolchain, no tokens — so a
design can be exercised before it is ever expanded.

## Status

Early, and working end to end. TypeScript, Java, Python and Go are built and
verified against their real compilers on every commit. **Rust is experimental
and does not compile yet** — the emitter does not model ownership.

## More

- [Repository, docs and worked examples](https://github.com/dscanavall11/hadl)
- [Build your own CRUD](https://github.com/dscanavall11/hadl/blob/main/docs/crud-tutorial.md)
- [The whole language, written for a model to read](https://github.com/dscanavall11/hadl/blob/main/AGENTS.md)

Apache-2.0.
