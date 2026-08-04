# Writing HADL

You are writing `.hadl` files. This is the whole language. Read it once and you
can write it; you do not need the rest of the repository.

HADL describes a system — its data, its rules, its boundaries — and compiles
that description into Java, TypeScript, Python or Go, plus Docker, Kubernetes,
Terraform or AWS. You write the design. The compiler writes the code.

**Write the design, not the implementation.** No frameworks, no annotations, no
layering by hand, no null checks, no try/catch, no getters. If you find yourself
writing something a compiler could have written, delete it.

---

## The loop

This is the part that matters most. Never hand back `.hadl` you have not checked.

```bash
haic fmt .            # canonical layout; never changes what the file means
haic check .          # parses, type-checks, audits the architecture
haic test .           # runs the scenarios against the IR — no code, no tokens
haic build . --java --out out        # or --ts, --py, --go, --rust, or --language <name>
```

Run `haic fmt` before handing work back, the way you would run any formatter.
It rewrites indentation, blank lines and the spacing of a field bullet; it does
not reflow prose, does not touch an expression, and moves a fenced block without
editing inside it. `haic fmt --check` reports instead of writing.

`haic check` is not a linter. It is a compiler front-end that reports exact
spans and stable codes:

```
examples/orders/orders.hadl:44:3  HADL2147  cannot resolve `customer` from `order`
```

When a code is unclear, ask the compiler rather than guessing:

```bash
haic explain HADL2147
```

Codes in the `HADL25xx` family are warnings about over-design — an unused
declaration, a port with one implementation and one caller, a service that only
forwards. They are advice, not errors. Take them seriously anyway; they exist to
stop you rebuilding the ceremony this language was written to remove.

Iterate until `haic check` is silent and `haic test` is green. Only then compile.

If you are working through an editor rather than a terminal, `haic lsp` is the
same compiler behind the Language Server Protocol: the same diagnostics, the
same codes, the same formatter.

---

## File shape

```
---
module: orders
context: Orders
target: typescript
---

# Orders

## <kind> <Name>
<clause>
<clause>

Prose, which is encouraged — it survives into the generated code as comments.

- field: Type, constraints
```

**Position decides meaning.** The lines directly under a heading, with no blank
line, are clauses: `identified by`, `contains`, `emits`, `uses`, `implements`,
`using`, `topic`, `config:`, and so on. Prose starts after the first blank line.

A line in the clause zone whose first word is not a clause the language knows is
`HADL1006`, not documentation. `primaryKey id` is an error; it does not silently
become a comment while the identity falls back to convention.

Declaration kinds: `enum` `value object` `entity` `aggregate` `dto` `command`
`event` `error` `query` `port` `adapter` `service` `handler` `endpoint`
`infrastructure` `scenario`.

Types: `text` `integer` `decimal` `boolean` `uuid` `timestamp` `date`
`duration` `json` `bytes` `nothing`, `list of X`, and any `CapitalisedName` you
declared. There is no `undefined`; absence is `optional`.

---

## Data

```hadl
## enum OrderStatus
- Draft
- Placed

## value object Money
- amount: decimal, required
- currency: text, required, min length 3, max length 3

## aggregate Order
identified by id

- id: uuid, required
- status: OrderStatus, required, default Draft
- items: list of OrderLine, required
- total: Money, optional
- placedAt: timestamp, optional

invariant "a placed order has a total":
  status is not Placed or total is present

operation add item (line: OrderLine) -> nothing:
  add line to items
```

Constraints go after the type: `required` `optional` `default X` `unique`
`min length N` `max length N` `min N` `max N` `pattern "..."` `one of a, b`.

`## entity` is the same but does not own a consistency boundary. `## value
object` has no identity.

### Messages

```hadl
## command PlaceOrder targets Order
- orderId: uuid, required

## event OrderPlaced from Order
topic order-placed

- orderId: uuid, required
- placedAt: timestamp, required

## dto OrderSummary projects Order
- orderId: uuid, required
- itemCount: integer, required
```

### Errors

Two kinds, and the distinction is the point.

```hadl
## error OrderNotFound (checked, status 404)
message: "no order exists with id {orderId}"

- orderId: uuid, required
```

**Checked** — part of the contract. Declare it on every operation that can raise
it and it propagates on its own. There is no `try`, no `catch`, no `throws`
plumbing; the compiler threads it.

**Unchecked** — a defect. Nobody handles it. Constraint and invariant violations
are unchecked.

---

## Boundaries

```hadl
## port OrderRepository (outbound)
using in-memory

- find order by id (id: uuid) -> Order or OrderNotFound
- save order (order: Order) -> nothing
```

`outbound` is something your system calls. `inbound` is something that calls
your system — never put `using` on an inbound port.

`using <tech>` builds the adapter for you: `in-memory`, `sql`, `http-client`,
`queue`. Prefer it. Write a separate `## adapter` only when it needs config:

```hadl
## adapter PostgresOrderRepository implements OrderRepository using sql
config:
  table = orders
```

```hadl
## port PlaceOrderUseCase (inbound)

- place order (command: PlaceOrder) -> OrderPlaced or OrderNotFound, EmptyOrder
```

Return type is `Result or Error1, Error2`. `nothing` is a valid result.

---

## Behaviour

```hadl
## service PlaceOrderService
uses OrderRepository
implements PlaceOrderUseCase

operation place order (command: PlaceOrder) -> OrderPlaced or OrderNotFound, EmptyOrder:
  let order be find order by id with id = command.orderId
  when order.items is empty:
    fail with EmptyOrder using orderId = command.orderId
  let placedAt be now
  set order.status to Placed
  set order.placedAt to placedAt
  perform save order with order = order
  publish OrderPlaced with orderId = order.id, placedAt = placedAt
  return OrderPlaced with orderId = order.id, placedAt = placedAt
```

Statements: `let X be <expr>` · `set path to <expr>` · `perform <call>` ·
`return <expr>` · `fail with Error using field = value` · `publish Event with
...` · `add X to list` · `remove X from list` · `when <cond>:` with optional
`otherwise:` · `for each x in list:`.

Calling a port operation uses its phrase and names its arguments:
`find order by id with id = command.orderId`. A checked error it declares
propagates automatically — do not test for it.

Operators are spelled: `is` `is not` `and` `or` `not` `plus` `minus` `times`
`divided by` `contains` `starts with` `ends with` `matches` `is empty`
`is present` `is absent` `at most` `at least`. Aggregates: `count of`
`sum of ... by ...` `min of` `max of` `average of`. Values: `now` `new id`
`nothing` `true` `false`.

### Working over a list

Two forms keep the list instead of collapsing it. Reach for them before a loop:

```hadl
each of items by productId                 -- list of uuid
only items where quantity is at least 2    -- list of OrderItem
```

They compose, with each other and with the aggregates:

```hadl
sum of only items where quantity is greater than 1 by unitPrice.amount
```

Inside a `by` or a `where`, a bare name is a field of the element; anything the
element does not declare comes from the enclosing scope, so a parameter still
means itself:

```hadl
operation heavy lines (threshold: integer) -> list of OrderItem:
  return only items where quantity is greater than threshold
```

`each of` needs its `by`, `only` needs its `where`. No `flat map` yet — a
projection returning a list per element still needs `for each`.

**Never map a DTO field by field.** Use `from`:

```hadl
return OrderSummary from order with itemCount = count of order.items
```

Every field the DTO and the source share is filled in; you write only what
differs. Writing `orderId = order.orderId, status = order.status, ...` is the
exact over-coding this language exists to prevent.

Narrow an optional before reading it:

```hadl
when order.total is present:
  return order.total.amount
```

**Invariants run after every `set`, not at the end.** So a transition that
touches two fields must be ordered to never break the rule half-way. Given
`invariant "a placed order has a total": status is not Placed or total is
present`, set the total first:

```hadl
set order.total to total     # still Draft, so the rule holds
set order.status to Placed   # total is present, so it holds again
```

The reverse order fails with an `InvariantViolation` between the two lines.
`haic test` catches this; the compiler cannot.

An aggregate operation may not call a port (`HADL2213`). Aggregates decide;
services fetch and save.

### Reacting to events

```hadl
## handler NotifyOnPlacement on OrderPlaced
uses CustomerNotifier
retries 5
delivery at-least-once

do:
  perform notify customer with orderId = event.orderId
```

Use `schedule 0 3 * * *` instead of `on <Event>` for a cron handler.

---

## When statements are not enough

Some logic is not a design decision. A matching loop, a great-circle distance, a
sum that has to be exact in cents: these have one correct form, and rewriting
them as statements is a translation nobody can check against the original.

For those, and only those, an operation body may be a fenced block — the same
fence Markdown has always had, with the language named on it:

````hadl
operation median price () -> decimal:
  ```typescript
  const sorted = [...this.lines].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
  ```
````

The block is copied into the generated project unchanged, indented to fit and
otherwise untouched. Everything around it is still the compiler's: the
signature, the parameter names, the checked errors, the invariants, the wiring.

Rules that matter:

- **Name the language.** ```` ```typescript ````, ```` ```python ````,
  ```` ```java ````, ```` ```go ````, ```` ```rust ````. Short names work:
  `ts`, `js`, `py`, `golang`, `rs`. A bare fence is `HADL1420`; a language no
  backend can emit is `HADL1421`. `js` and `javascript` mean the TypeScript
  backend, and the block lands in a `.ts` file, so it has to type-check there.
- **One block per target, several targets per operation.** Write a `typescript`
  block and a `python` block and each backend takes its own.
- **Write the statements too, when you can.** Statements beside a block are the
  reference implementation: `haic test` runs *them*, and the block is what
  ships. An operation with a block and no statements is `HADL2602` — no scenario
  can reach it, and the compiler says so rather than letting the untested part
  of the system be the interesting part.
- **Keep it indented.** The fence and its contents sit under the operation, like
  any Markdown block. A line at column zero ends the body.
- **A block in an aggregate still may not do I/O.** The compiler cannot read the
  code, so it warns when a block inside an aggregate names one of your ports
  (`HADL2604`). Aggregates decide; services fetch and save.
- **A block only fits an operation.** Not a handler, not an invariant, not a
  scenario (`HADL1424`). If a handler needs one, give the work to an operation
  and call it.
- **Building a target no block covers fails.** `HADL3060`, before anything is
  written. Add a block for that target, add statements, or build the language
  the operation was written for.

Reach for a block last, not first. `only … where`, `each of … by` and the
aggregates cover most of what looks at first like it needs a loop, and every
line inside a fence is a line the compiler cannot check, cannot run in a
scenario, and cannot port to another language.

### Choosing the language at build time

```bash
haic build src --language typescript --out out
```

`--language` replaces the `target:` in the frontmatter for that build, and takes
the name a person would write: `js`, `ts`, `py`, `golang`, `rs`, or the full
name. `--target` is the same thing by backend id. Neither changes the source;
they decide which backend runs, and therefore which block is used.

---

## Queries

One criterion per filter, never one repository method per combination. An absent
optional drops its criterion, so a single query covers every subset.

```hadl
## query OrderSearch over Order

- status: OrderStatus, optional
- placedAfter: timestamp, optional

match order.status is status
match order.placedAt is at least placedAfter

sort by order.placedAt descending
limit 100
```

The subject binds to the aggregate's camelCase name. Every `match` must mention
it.

`sort by` needs a type that has an order — a number, a `timestamp` or a `date`.
Sorting by `text` or by an enum is `HADL2152`. If an aggregate has nothing
ordered to sort on, give it `createdAt: timestamp, required`.

---

## Edges

```hadl
## endpoint POST /orders/{orderId}/place
handled by PlaceOrderService.place order
request PlaceOrder
auth bearer
responds 200 with OrderPlaced
responds 404 when OrderNotFound
responds 422 when EmptyOrder

## infrastructure
port 8080
database ordersdb using postgres version 16
deploy to docker
```

Every checked error the operation declares needs a `responds ... when`.

---

## Scenarios

Write these. They run in one second against the IR, with no code generated and
no tokens spent, and they are the only way to know a design works before
compiling it.

```hadl
## scenario placing an order that has no items

given order be Order with id = "o-1", status = Draft, items = []
when place order with command = PlaceOrder with orderId = "o-1"
then it fails with EmptyOrder
```

`given` seeds state (repeat with `and`), `when` runs one operation, `then`
asserts. Assertions: `then x.field is value` · `then it fails with Error` ·
`then it publishes Event`. Chain more with `and`.

`now` is frozen and `new id` is counted, so scenarios are deterministic.

---

## Rules that decide reviews

1. **YAGNI.** No declaration without a caller. No port with one implementation
   and one caller — call it directly. No service that only forwards.
2. **The aggregate owns its invariants.** Rules about an Order live on `Order`,
   not in the service. A service orchestrates; it does not decide.
3. **Ports point outward.** Domain never names infrastructure. `sql`, `http`
   and `postgres` appear in adapters and `## infrastructure`, nowhere else.
4. **Checked errors are contracts.** Declare them, never catch them.
5. **One reason to change per declaration.** A port with unrelated operations
   should be two ports.
6. **Prose is part of the source.** Say why, in English, above the declaration.
   It reaches the generated code.

---

## Common mistakes

| Wrong | Right |
| --- | --- |
| `orderId = o.orderId, status = o.status` | `OrderSummary from o` |
| `try`, `catch`, `throws` | declare the checked error in `->` |
| a port with `using` on `(inbound)` | `using` is for outbound only |
| `## adapter` with only a technology | `using <tech>` inside the port |
| one repository method per filter | one `## query` with optional criteria |
| `null`, `undefined` | `optional`, then `when x is present:` |
| reading `x.y` where `x` is optional | narrow first |
| a service holding domain rules | move them to the aggregate's `invariant` |
| `sort by note.title` | sort by a number, timestamp or date |
| setting the flag before the field it requires | set the field first |
| `primaryKey id`, `key id` | `identified by id` |
| a `for each` loop to build a list | `each of … by …` or `only … where …` |
| `[Line with id = "a", Line with id = "b"]` | bind each first, then `[first, second]` |
| a fenced block for logic `only … where` covers | statements; keep the fence for what has no design form |
| a fenced block and no statements beside it | write both, so a scenario can still run the design |

---

## Full worked sources

- `examples/crud/tasks.hadl` — the five CRUD operations and nothing else
- `examples/orders/orders.hadl` — aggregates, events, handlers, DTO projection
- `examples/billing/subscriptions.hadl` — adapters with config, scheduled work
- `examples/matching/book.hadl` — an order book: a matching loop in TypeScript and in Python, everything around it in HADL
- `examples/ledger/ledger.hadl` — double-entry bookkeeping: a block and the statements it is checked against, side by side
- `examples/dispatch/dispatch.hadl` — courier assignment: a distance formula and a greedy sweep, surrounded by rules
- `docs/language-reference.md` — every construct, exhaustively
