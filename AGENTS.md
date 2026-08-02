# Writing AI-Lang

You are writing `.ail` files. This is the whole language. Read it once and you
can write it; you do not need the rest of the repository.

AI-Lang describes a system — its data, its rules, its boundaries — and compiles
that description into Java, TypeScript, Python or Go, plus Docker, Kubernetes,
Terraform or AWS. You write the design. The compiler writes the code.

**Write the design, not the implementation.** No frameworks, no annotations, no
layering by hand, no null checks, no try/catch, no getters. If you find yourself
writing something a compiler could have written, delete it.

---

## The loop

This is the part that matters most. Never hand back `.ail` you have not checked.

```bash
ail check .          # parses, type-checks, audits the architecture
ail test .           # runs the scenarios against the IR — no code, no tokens
ail build . --target typescript --out out
```

`ail check` is not a linter. It is a compiler front-end that reports exact
spans and stable codes:

```
examples/orders/orders.ail:44:3  AIL2147  cannot resolve `customer` from `order`
```

When a code is unclear, ask the compiler rather than guessing:

```bash
ail explain AIL2147
```

Codes in the `AIL25xx` family are warnings about over-design — an unused
declaration, a port with one implementation and one caller, a service that only
forwards. They are advice, not errors. Take them seriously anyway; they exist to
stop you rebuilding the ceremony this language was written to remove.

Iterate until `ail check` is silent and `ail test` is green. Only then compile.

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
`AIL1006`, not documentation. `primaryKey id` is an error; it does not silently
become a comment while the identity falls back to convention.

Declaration kinds: `enum` `value object` `entity` `aggregate` `dto` `command`
`event` `error` `query` `port` `adapter` `service` `handler` `endpoint`
`infrastructure` `scenario`.

Types: `text` `integer` `decimal` `boolean` `uuid` `timestamp` `date`
`duration` `json` `bytes` `nothing`, `list of X`, and any `CapitalisedName` you
declared. There is no `undefined`; absence is `optional`.

---

## Data

```ail
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

```ail
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

```ail
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

```ail
## port OrderRepository (outbound)
using in-memory

- find order by id (id: uuid) -> Order or OrderNotFound
- save order (order: Order) -> nothing
```

`outbound` is something your system calls. `inbound` is something that calls
your system — never put `using` on an inbound port.

`using <tech>` builds the adapter for you: `in-memory`, `sql`, `http-client`,
`queue`. Prefer it. Write a separate `## adapter` only when it needs config:

```ail
## adapter PostgresOrderRepository implements OrderRepository using sql
config:
  table = orders
```

```ail
## port PlaceOrderUseCase (inbound)

- place order (command: PlaceOrder) -> OrderPlaced or OrderNotFound, EmptyOrder
```

Return type is `Result or Error1, Error2`. `nothing` is a valid result.

---

## Behaviour

```ail
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

**Never map a DTO field by field.** Use `from`:

```ail
return OrderSummary from order with itemCount = count of order.items
```

Every field the DTO and the source share is filled in; you write only what
differs. Writing `orderId = order.orderId, status = order.status, ...` is the
exact over-coding this language exists to prevent.

Narrow an optional before reading it:

```ail
when order.total is present:
  return order.total.amount
```

**Invariants run after every `set`, not at the end.** So a transition that
touches two fields must be ordered to never break the rule half-way. Given
`invariant "a placed order has a total": status is not Placed or total is
present`, set the total first:

```ail
set order.total to total     # still Draft, so the rule holds
set order.status to Placed   # total is present, so it holds again
```

The reverse order fails with an `InvariantViolation` between the two lines.
`ail test` catches this; the compiler cannot.

An aggregate operation may not call a port (`AIL2213`). Aggregates decide;
services fetch and save.

### Reacting to events

```ail
## handler NotifyOnPlacement on OrderPlaced
uses CustomerNotifier
retries 5
delivery at-least-once

do:
  perform notify customer with orderId = event.orderId
```

Use `schedule 0 3 * * *` instead of `on <Event>` for a cron handler.

---

## Queries

One criterion per filter, never one repository method per combination. An absent
optional drops its criterion, so a single query covers every subset.

```ail
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
Sorting by `text` or by an enum is `AIL2152`. If an aggregate has nothing
ordered to sort on, give it `createdAt: timestamp, required`.

---

## Edges

```ail
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

```ail
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

---

## Full worked sources

- `examples/crud/tasks.ail` — the five CRUD operations and nothing else
- `examples/orders/orders.ail` — aggregates, events, handlers, DTO projection
- `examples/billing/subscriptions.ail` — adapters with config, scheduled work
- `docs/language-reference.md` — every construct, exhaustively
