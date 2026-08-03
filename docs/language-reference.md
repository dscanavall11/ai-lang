# HADL Language Reference

HADL is a programming language whose source is a Markdown document. It exists
for one purpose: to be the thing an AI writes when it is asked to build software,
so that what gets built is the system that was asked for and nothing else.

A `.hadl` file declares a **bounded context's module**: its domain model, the rules
that model must obey, the ports it depends on, the use cases it exposes, and the
infrastructure it needs. The compiler lowers that into a typed IR, checks it
against the rules below, and emits idiomatic code in a target language plus the
infrastructure to run it.

---

## 1. File structure

```
---
module: orders          # required identifier, lower camel case
context: Sales          # bounded context this module belongs to
target: java            # java | typescript | python | go | rust
imports:
  - catalog via anti-corruption-layer
---

# Free-form title

Prose paragraphs before the first `##` become the module's documentation.

## <keyword> <Name> [(modifiers)] [trailing clauses]
```

Everything after the frontmatter is Markdown. A `#` heading is a title. Every
`##` heading opens a **declaration**. Deeper headings are documentation.

### 1.1 Frontmatter

| Key | Required | Meaning |
| --- | --- | --- |
| `module` | no (defaults to the file name) | Identifier of the module |
| `context` | no (defaults to the module name) | Bounded context |
| `target` | no | Preferred compilation target for this context |
| `imports` | no | List of `<module> [via <relationship>] [exposing A, B]` |

Import relationships: `anti-corruption-layer` (default), `shared-kernel`,
`conformist`, `open-host`. They become the project's context map.

### 1.2 Comments

`// text` at the start of a line is ignored. A trailing `// text` on a field or
operation bullet becomes that member's documentation.

---

## 2. The one rule that makes the syntax work

> **A word beginning with a capital letter names a type. A word beginning with a
> lower-case letter names a value. Two or more lower-case words in a row name an
> operation.**

That is the whole disambiguation strategy. `order` is a value, `Order` is a type,
`find order by id` is a call. No other rule is needed, and none of the syntax
below contradicts it.

Reserved words never appear inside an operation phrase: `is are was not and or
plus minus times divided equals contains starts ends matches with be then
otherwise else true false yes no nothing null none now using carrying`.

Words like `by`, `of`, `to`, `from`, `for` and `in` **are** allowed inside a
phrase, which is what lets `find order by id` read as one name.

---

## 3. Types

| Written | Meaning |
| --- | --- |
| `text` | Unicode string |
| `integer` | Whole number |
| `decimal` | Fractional number |
| `boolean` | Yes or no |
| `uuid` | Opaque identifier |
| `timestamp` | Instant in time |
| `date` | Calendar date |
| `duration` | Length of time |
| `json` | Untyped payload |
| `bytes` | Binary blob |
| `nothing` | Absence of a value |

Aliases accepted for readability: `string`, `str`, `int`, `number`, `float`,
`double`, `bool`, `flag`, `id`, `datetime`, `instant`, `void`, `none`, `binary`,
`object`.

### 3.1 Composite types

```
list of OrderItem
set of uuid
map from text to Money
Money or nothing              # optional
Order or OrderNotFound        # result carrying a checked error
Order or OrderNotFound, Conflict
```

`X or nothing` is an optional. `X or SomeError` is a **result**: the operation
either produces `X` or raises `SomeError`, and the caller must deal with both.

---

## 4. Declarations

### 4.1 `enum`

```
## enum OrderStatus
- Draft
- Placed        // the order is frozen and heading for fulfilment
```

### 4.2 `value object`

Compared by value, never by identity. Immutable once built.

```
## value object Money
- amount: decimal, required, min 0
- currency: text, required, length 3

invariant "amounts are never negative":
  amount is at least 0
```

A value object may not declare an identity field, and may not hold anything that
has one (`HADL2208`).

### 4.3 `entity`

Has identity; lives inside exactly one aggregate.

```
## entity OrderItem
identified by id
belongs to Order

- id: uuid, required
- quantity: integer, required, min 1
```

### 4.4 `aggregate`

The consistency boundary. Only the root is reachable from outside.

```
## aggregate Order
identified by id
contains OrderItem
emits OrderPlaced

- id: uuid, required
- items: list of OrderItem, required
- total: Money, derived

invariant "an order must hold at least one item":
  items is not empty

operation compute total () -> Money:
  return Money with amount = sum of items by quantity times unitPrice.amount, currency = "EUR"
```

Rules the compiler enforces:

- an entity named in `contains` belongs to no other aggregate (`HADL2203`);
- nothing outside the aggregate may reference a contained entity (`HADL2206`);
- an aggregate references another by identity, never by embedding (`HADL2207`);
- an aggregate operation may not call a port (`HADL2213`);
- an aggregate with no invariants and no operations is flagged (`HADL2214`).

### 4.5 Field syntax

```
- <name>: <type>[, <modifier>]*      // optional documentation
```

| Modifier | Effect |
| --- | --- |
| `required` / `mandatory` | Must be present (default unless the type is optional) |
| `optional` / `nullable` | May be absent |
| `identity` / `primary key` | Part of the identity |
| `derived` / `computed` | Calculated, not stored as given |
| `unique` | Unique across the collection |
| `immutable` / `read only` | Cannot be reassigned |
| `min N` / `max N` | Numeric bounds |
| `min length N` / `max length N` / `length N` | Size bounds |
| `pattern "regex"` | Text must match |
| `one of A \| B \| C` | Restricted set |
| `default V` | Value used when absent |

### 4.6 `command`, `event`, `dto`

```
## command PlaceOrder targets Order
- orderId: uuid, required

## event OrderPlaced from Order
topic order-placed
- orderId: uuid, required

## dto OrderSummary projects Order
- orderId: uuid, required
- itemCount: integer, required
```

### 4.7 `error`

```
## error OrderNotFound (checked, status 404)
message: "no order exists with id {orderId}"
- orderId: uuid, required

## error EmptyOrderTotal (unchecked)
message: "cannot total an order with no items"
```

**Checked** errors are part of a contract. Every operation that can raise one
must declare it (`HADL2303`), every endpoint that exposes one must map it to a
status (`HADL2305`), and declaring one that can never happen is flagged
(`HADL2304`).

**Unchecked** errors signal a defect. They propagate on their own and may never
appear in a contract (`HADL2302`).

`{fieldName}` inside `message` is substituted from the error's own fields.

### 4.8 `port`

```
## port OrderRepository (outbound)
- find order by id (id: uuid) -> Order or OrderNotFound
- save order (order: Order) -> nothing

## port PlaceOrderUseCase (inbound)
- place order (command: PlaceOrder) -> OrderPlaced or OrderNotFound
```

`outbound` — the domain drives the outside world. Needs an adapter (`HADL2408`).
`inbound` — the outside world drives the domain. Needs a service (`HADL2409`).

A port with more than seven operations is flagged (`HADL2421`). Most of the time
the cure is a [`## query`](#49-query) rather than a narrower port: one criterion
replaces the family of `find … by …` methods that made the port wide.

**When there is only one implementation**, which is most of the time, the port
names its own technology and the adapter never gets a heading:

```
## port OrderRepository (outbound)
using sql
config:
  table = orders
  schema = sales

- find order by id (id: uuid) -> Order or OrderNotFound
- save order (order: Order) -> nothing
```

That declares an adapter named `SqlOrderRepository` implementing
`OrderRepository`. It is exactly equivalent to writing the `## adapter` heading
below — the parser expands it, so the IR and every backend see the same thing.

The port stays a real seam: swapping `using sql` for `using in-memory` changes
one word and nothing else in the module. Write the long form when you need a
name of your own, several adapters for one port, or per-operation bodies.

An inbound port may not name a technology (`HADL1031`): it is fulfilled by a
service, not by infrastructure.

### 4.9 `query`

A named filter over one aggregate — the Specification pattern, so a repository
grows a criterion rather than a method.

```
## query OrdersForCustomer over Order

- customerId: uuid, required
- placedAfter: timestamp, optional
- status: OrderStatus, optional

match order.customerId is customerId
match order.placedAt is at least placedAfter
match order.status is status

sort by order.placedAt descending
limit 50
```

The aggregate is bound to its own name in lower camel case — `order` here — so
the two sides of a criterion never look alike even when they share a field name.

**A criterion that reads an absent optional parameter is skipped.** That one
rule is what lets a single query cover every combination of filters, instead of
one repository method per combination:

```
## port OrderRepository (outbound)
using sql
- find orders matching (query: OrdersForCustomer) -> list of Order
```

Because a criterion only runs when its parameters are present, an optional
parameter compares against a plain field inside its own criterion: `status` is
`OrderStatus` there, not `OrderStatus or nothing`.

The SQL adapter compiles the criteria into a parameterised `WHERE` built at call
time, with `ORDER BY` and `LIMIT` from the declaration. The in-memory adapter
compiles the same criteria into a predicate, guarding nullable columns so both
agree on what a comparison against nothing means: false.

Rules:

- the source must be an aggregate (`HADL2150`);
- a criterion must be a yes/no condition (`HADL2151`) and must mention the
  aggregate (`HADL1042`);
- `sort by` needs an ordered type (`HADL2152`);
- a parameter no criterion reads is flagged (`HADL2153`).

Deliberately narrow: filter, sort and limit over **one** aggregate. No joins, no
projections, no aggregation. A criterion with no faithful SQL form is left out
and named in a comment in the generated adapter rather than guessed at. If you
need more than this, what you need is a read model.

### 4.10 `adapter`

```
## adapter PostgresOrderRepository implements OrderRepository using sql
config:
  table = orders
  schema = sales
```

Technologies: `rest`, `graphql`, `grpc`, `sql`, `nosql`, `kafka`, `rabbitmq`,
`sqs`, `http-client`, `in-memory`, `s3`, `redis`, `cron`.

Backends generate real implementations for the repository phrases they
recognise — `find … by id`, `save …`, `list …`, `delete … by id` — and say
plainly, in the generated code, where they could not.

More than one adapter may implement the same port — an in-memory pair for tests
is the usual reason — but the generated composition root wires the first, and
says which one (`HADL2423`).

### 4.11 `service`

```
## service PlaceOrderService
uses OrderRepository
implements PlaceOrderUseCase

operation place order (command: PlaceOrder) -> OrderPlaced or OrderNotFound:
  let order be find order by id with id = command.orderId
  ...
```

`uses` may only name ports (`HADL2402`, `HADL2403`). A service whose operations use
disjoint sets of ports is flagged as two services sharing a name (`HADL2422`).

### 4.12 `endpoint`

```
## endpoint POST /orders/{orderId}/place
handled by PlaceOrderService.place order
request PlaceOrder
auth bearer
responds 200 with OrderPlaced
responds 404 when OrderNotFound
responds 409 when OrderAlreadyPlaced
```

Every path parameter must be carried by the request or by a parameter of the
handled operation (`HADL2416`).

### 4.13 `handler`

```
## handler NotifyOnPlacement on OrderPlaced
uses CustomerNotifier
retries 5
delivery at-least-once

do:
  perform notify customer of placement with customerId = event.customerId, orderId = event.orderId
```

The payload is bound to `event`. `delivery` is one of `at-least-once`,
`at-most-once`, `exactly-once`. A `schedule "0 3 * * *"` line makes it a cron
handler instead.

### 4.14 `infrastructure`

```
## infrastructure
port 8080
database ordersdb using postgres version 16 storage 50
broker events using kafka topics order-placed
cache sessions using redis
storage invoices using s3
secrets DB_PASSWORD, KAFKA_PASSWORD
environment LOG_LEVEL = info, REGION = eu-west-1
scaling min 2 max 10 cpu 70
deploy to docker, kubernetes, terraform
observability tracing on, metrics on, log level info
```

Only names appear here. A secret's **value** never lives in the source.

### 4.15 `scenario`

An executable example. `haic test` runs these **against the IR itself** — no code
is generated, no toolchain is needed, and no tokens are spent.

```
## scenario placing a draft order

given order be Order with id = "o-1", customerId = "c-1", status = Draft, items = [ ... ]
when placed be place order with command = PlaceOrder with orderId = "o-1", customerId = "c-1"
then placed.orderId is "o-1"
and order.status is Placed
and it publishes OrderPlaced
```

The heading is a sentence, not an identifier — it is what the runner prints.

| Step | Meaning |
| --- | --- |
| `given <name> be <expression>` | Builds a value and, if it has an identity, seeds it into the store |
| `and <name> be <expression>` | Another thing to seed |
| `when [<name> be] <call>` | The one operation under test, bound to `result` unless named |
| `then <condition>` / `and <condition>` | A condition that must hold afterwards |
| `then it fails with <Error>` | The operation must raise exactly that error |
| `then it publishes <Event>` | That event must have been published |

A seeded value is the same object the operation mutates, so `order.status is
Placed` above asserts on what the service actually wrote.

**What the interpreter provides.** Outbound ports resolve to an in-memory store
for the phrases a repository is built from — `find … by id`, `save …`,
`list …`, `delete … by id`, and any operation taking a [`## query`](#49-query).
Field constraints and invariants run exactly as the generated constructors run
them, so `then it fails with ConstraintViolation` is a real assertion.

**What makes it trustworthy.** `now` is a fixed instant and `new id` counts from
one, so the same scenario produces the same values on every run. And a scenario
the interpreter cannot execute — a port it has no in-memory form for — is
reported as **inconclusive**, never as a pass:

```
? SendingMail
    the interpreter has no in-memory form of "send a letter" on port Mailer — this scenario did not run

1 passed, 0 failed, 1 could not run
```

`haic test` exits non-zero when anything failed **or** could not run. Reporting
"0 failures" for work that never happened is the one thing a test runner must
not do.

### 4.16 `glossary`

```
## glossary
- Order: a customer's intent to buy a set of items at agreed prices.
```

Carried into the IR and into every generated project's documentation.

---

## 5. Statements

One statement per line. A trailing `:` opens an indented block.

```
let <name> be <expression>
set <path> to <expression>
perform <call>
publish <Event> with <args>
fail with <Error> [using <args>]
add <expression> to <path>
remove <expression> from <path>
return [<expression>]

when <condition>:
  <statements>
otherwise:
  <statements>

when <condition> then <statement>          # single-line form

for each <name> in <expression>:
  <statements>
```

Accepted synonyms: `define` for `let`, `change` for `set`, `if` for `when`,
`else` for `otherwise`, `emit`/`announce` for `publish`, `reject`/`raise` for
`fail`, `do`/`call` for `perform`, `answer`/`give back` for `return`.

### 5.1 Error propagation

```
let order be find order by id with id = command.orderId
```

`find order by id` returns `Order or OrderNotFound`. The binding takes the
`Order`; `OrderNotFound` propagates to the enclosing operation, which must
declare it. This is the whole of checked-error handling: there is no `try`.

### 5.2 Optional narrowing

A `when` on a presence test makes the value non-optional for that branch:

```
let found be load label with id = id
when found is present:
  return found            # `found` is text here, not "text or nothing"
fail with Missing
```

`when x is absent:` narrows the `otherwise` branch instead. Only a bare local is
narrowed — narrowing `a.b.c` would need alias analysis to stay sound, and binding
it with `let` first is one line.

### 5.3 A body written in the target language

An operation body may be a fenced block instead of statements — Markdown's own
fence, with the language named on it:

````
operation median price () -> decimal:
  ```typescript
  const sorted = [...this.lines].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
  ```
````

The fence and everything inside it are indented under the operation, exactly as
they would be in Markdown. That indentation is what tells the parser the block
is part of this body — a line at column zero ends the operation, and a `#` there
opens a declaration.

The block is emitted into the generated project verbatim, re-indented to sit
where the body belongs and otherwise untouched. The compiler still owns
everything around it: the signature, the parameter names, the checked errors,
the invariants that run on the fields it writes, and the wiring that calls it.

| Rule | Code |
| --- | --- |
| The fence must name a language | `HADL1420` |
| The language must be one a backend emits | `HADL1421` |
| The fence must be closed | `HADL1422` |
| At most one block per target | `HADL1423` |
| Only an operation body may hold one | `HADL1424` |
| A block with nothing in it | `HADL2601` |
| A block with no statements beside it | `HADL2602` |
| The module's target has no body | `HADL2603` |
| The target being built has no body | `HADL3060` |

Accepted names are the backend ids and their usual short forms: `typescript`,
`ts`, `javascript`, `js`, `node`; `java`; `python`, `py`; `go`, `golang`;
`rust`, `rs`. `haic targets` lists them. A `js` block is emitted into a `.ts`
file, because the TypeScript backend is the one that generates Node.js.

Several blocks may sit under one operation, at most one per target, and
statements may sit beside them:

````
operation total debited () -> Money:
  ```typescript
  const cents = this.postings.reduce((sum, p) => sum + Math.round(p.amount.amount * 100), 0);
  return new Money({ amount: cents / 100, currency: this.currency });
  ```

  return Money with amount = sum of postings by amount.amount, currency = currency
````

The statements are the **reference implementation**: `haic test` runs them, and
they are what the design says the operation means. The block is what ships for
the target it names. An operation with a block and no statements cannot be
reached by any scenario, and `HADL2602` says so — the interpreter reports such a
scenario as inconclusive rather than passing it.

Nothing inside a fence is checked, inferred, or ported. That is the cost, and it
is why the compiler is loud about who is paying it.

---

## 6. Expressions

```
order.status is not Draft
quantity is at least 1
items is not empty
name starts with "AC-"

quantity times unitPrice.amount
total plus shipping minus discount
subtotal divided by 2

sum of items by quantity times unitPrice.amount
count of order.items
average of ratings
minimum of prices
maximum of prices

each of items by productId
only items where quantity is greater than threshold
sum of only items where quantity is greater than 1 by unitPrice.amount

find order by id with id = command.orderId
compute total with order = order
Money with amount = 10, currency = "EUR"
a new Order with id = new id
now
```

| Written | Operator |
| --- | --- |
| `is`, `equals` | equality |
| `is not` | inequality |
| `is greater than`, `is less than` | strict comparison |
| `is at least`, `is at most` | inclusive comparison |
| `is empty`, `is not empty` | emptiness |
| `is present`, `is absent` | optional presence |
| `and`, `or`, `not` | logic |
| `plus`, `minus`, `times`, `divided by` | arithmetic |
| `contains`, `starts with`, `ends with`, `matches` | text and collections |

Precedence, loosest first: `or` → `and` → comparison → `plus`/`minus` →
`times`/`divided by` → unary → primary. Parentheses group.

### 6.1 Working over a list

The aggregates above collapse a list onto a single value. Two more keep it a
list:

| Written | Gives | Result |
| --- | --- | --- |
| `each of items by productId` | one value per element | `list of uuid` |
| `only items where quantity is at least 2` | the elements that hold | `list of OrderItem` |

Inside either clause, a bare name is a field of the element being visited;
anything the element does not declare is read from the enclosing scope, so an
operation parameter still means itself:

```
operation heavy lines (threshold: integer) -> list of OrderItem:
  return only items where quantity is greater than threshold
```

`quantity` is a field of `OrderItem` and `threshold` is the parameter. The same
rule applies to the `by` clause of a fold.

They compose, and with the aggregates:

```
sum of only items where quantity is greater than 1 by unitPrice.amount
```

`each of` requires its `by` (`HADL1112`) and `only` requires its `where`
(`HADL1113`) — a projection with nothing to project is the collection itself.
A `where` clause that is not a condition is `HADL2115`, and either form over
something that is not a list is `HADL2107`.

There is no `flat map` yet: a projection that returns a list per element still
has to be written as a `for each` loop.

### 6.2 Building one shape from another

Spelling out a projection field by field is the boilerplate this language exists
to delete, so `from` takes everything it can by name:

```
return OrderSummary from order
```

Each field of `OrderSummary` is resolved in this order:

1. an explicit `with` argument, which always wins;
2. a field of `order` with the same name and a compatible type;
3. the identity of `order`, when the target field is named `<thing>Id` — so
   `orderId` finds `order.id` without being told.

Anything left over is **an error**, never a silent null:

```
error[HADL2147]: OrderSummary needs "itemCount", which Order does not provide
  help: add them explicitly: "with itemCount = ..."
```

Add the ones the source cannot supply, and keep the rest implicit:

```
return OrderSummary from order with itemCount = count of order.items
```

`from` is resolved during analysis, so the IR and every generated backend see
the fully spelled-out construction. It is shorthand in the source and nowhere
else.

There is no automatic mapping without `from`. A construction that names no
source states every field, and a bare type name used as a value is an error
(`HADL2149`) rather than an empty object.

### 6.2 Calling an aggregate operation

An aggregate operation is invoked by naming the instance as the argument whose
name matches the aggregate in lower camel case:

```
let total be compute total with order = order
```

The backend emits `order.computeTotal()`.

---

## 7. Diagnostic codes

| Range | Stage |
| --- | --- |
| `HADL10xx` | Section and field syntax |
| `HADL12xx` | Type expressions |
| `HADL13xx` | Expressions |
| `HADL14xx` | Statements |
| `HADL15xx` | Infrastructure block |
| `HADL16xx` | Frontmatter and module structure |
| `HADL20xx` | Symbol resolution |
| `HADL21xx` | Type checking |
| `HADL22xx` | Domain-driven design rules |
| `HADL23xx` | Checked and unchecked error flow |
| `HADL24xx` | Hexagonal architecture and SOLID |
| `HADL25xx` | Simplicity (YAGNI) |
| `HADL26xx` | Bodies written in a target language |
| `HADL29xx` | Internal IR validation |
| `HADL30xx` | Code generation and deployment |

`haic explain <code>` prints the reasoning behind the design rules.

Everything in `HADL25xx` is a warning or a note, never an error: unused code is a
smell, not a contradiction. `haic check --strict` promotes them to errors.

---

## 8. What the language deliberately does not have

- **No classes, no inheritance.** The declaration kinds are the vocabulary.
- **No `try`/`catch`.** Checked errors propagate; unchecked errors are defects.
- **No null.** Absence is `X or nothing`, and the compiler makes you handle it.
- **No free functions.** Behaviour belongs to an aggregate, a service or a handler.
- **No generics.** `list`, `set`, `map` and `optional` are the only parameterised types.
- **No imports inside a module body.** Dependencies are declared once, in the frontmatter.
- **No inline SQL, no inline YAML.** If the compiler cannot express something
  about storage or deployment, that is a gap to close in the language, not a hole
  to punch through it.
- **One escape hatch, declared and bounded.** An operation body may be a fenced
  block in a target language (§5.3). It is deliberately the only one: it names
  its language, it lives inside a signature the compiler still owns, and every
  consequence of using it — untestable by scenarios, unportable to another
  target — is reported rather than assumed. Algorithms are not design decisions,
  and a language that forces them into design vocabulary gets a worse
  translation, not a better design.

Each of these is a decision to make one obvious thing possible rather than many
things expressible. A model with fewer ways to say something is a model an AI
writes correctly more often.
