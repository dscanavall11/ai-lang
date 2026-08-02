# Building a CRUD service

Every command here was run against the current build. If one of them fails for
you, that is a bug — please report it.

## Install

```bash
git clone https://github.com/dscanavall11/ai-lang.git
cd ai-lang
npm install
npm run build
npm link --workspace @ai-lang/cli
```

`ail` is now on your path:

```bash
ail --version      # ail 0.1.0
ail targets        # what this build can emit
```

To uninstall later: `npm unlink -g @ai-lang/cli`.

## Run the worked example first

```bash
ail check examples/crud
```

```
no problems found in 1 module, 1 bounded context

Bounded contexts
  Tasks (core) → typescript
```

Now compile and start it:

```bash
ail build examples/crud --target typescript --out out
cd out/typescript
npm install
npm run dev
```

```
listening on http://localhost:8080
```

The service is real. All five operations work against an in-memory store:

```bash
# create
curl -X POST localhost:8080/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"Buy milk","notes":null,"dueOn":null}'
# → 201 {"id":"74afa342-…","title":"Buy milk","state":"Open",…}

# list
curl localhost:8080/tasks                       # → 200 [ … ]

# read one
curl localhost:8080/tasks/74afa342-…            # → 200 { … }

# update
curl -X PUT localhost:8080/tasks/74afa342-… \
  -H 'content-type: application/json' \
  -d '{"taskId":"74afa342-…","title":"Buy oat milk","notes":null,"dueOn":null}'
# → 200 { … }

# delete
curl -X DELETE localhost:8080/tasks/74afa342-…  # → 204

# read it again
curl localhost:8080/tasks/74afa342-…
# → 404 {"code":"TASK_NOT_FOUND","message":"no task exists with id 74afa342-…"}
```

The 404 body is the `message:` line from the `.ail` source, with `{taskId}`
filled in. Nothing about that response was written by hand.

Break a rule and the model refuses:

```bash
curl -X POST localhost:8080/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"","notes":null,"dueOn":null}'
# → 422 {"code":"CONSTRAINT_VIOLATION","message":"Task.title violates min length 1"}
```

That came from `- title: text, required, min length 1, max length 200`.

---

## Write your own

```bash
ail new inventory
cd inventory
```

The scaffold is a complete slice that already compiles. Open
`src/inventory.ail` and replace it with your own. Here is the whole shape of a
CRUD, in the order the compiler wants it.

### 1. The thing you are storing

```
## aggregate Product
identified by id

- id: uuid, required
- sku: text, required, min length 3, unique
- name: text, required, max length 200
- priceCents: integer, required, min 0
- active: boolean, required, default true

invariant "an active product costs something":
  active is false or priceCents is greater than 0
```

The invariant is not documentation. It runs in the constructor and after every
change, in whatever language you compile to.

### 2. What can go wrong

```
## error ProductNotFound (checked, status 404)
message: "no product exists with id {productId}"

- productId: uuid, required
```

`checked` means callers must handle it, and every endpoint that can produce it
must map it to a status. The compiler enforces both.

### 3. What comes in over the wire

```
## command CreateProduct
- sku: text, required, min length 3
- name: text, required, max length 200
- priceCents: integer, required, min 0

## command UpdateProduct
- productId: uuid, required
- name: text, required, max length 200
- priceCents: integer, required, min 0
```

A command carries what the caller sends, which is deliberately less than the
aggregate holds: no `id` on create, no `active` anywhere. If you find yourself
copying every field, the compiler will tell you (`AIL2502`).

### 4. What you ask the outside world for

```
## port ProductRepository (outbound)
using in-memory

- find product by id (id: uuid) -> Product or ProductNotFound
- list products () -> list of Product
- save product (product: Product) -> nothing
- delete product by id (id: uuid) -> nothing
```

Those four phrases are the ones the backends recognise, so they generate real
queries. Anything else you declare here gets a method that says, in the
generated code, that you have to write it.

`using in-memory` is the whole adapter. It needs no setup, so the service runs
on the first try. When you want the data to survive a restart, change that one
line to `using sql` and add what it needs:

```
## port ProductRepository (outbound)
using sql
config:
  table = products
```

Nothing else in the module changes — that is what the port is for.

### 5. What the outside world can ask you for

```
## port ProductUseCases (inbound)

- create product (command: CreateProduct) -> Product
- read product (id: uuid) -> Product or ProductNotFound
- list all products () -> list of Product
- update product (command: UpdateProduct) -> Product or ProductNotFound
- delete product (id: uuid) -> nothing or ProductNotFound
```

### 6. The five operations

```
## service ProductService
uses ProductRepository
implements ProductUseCases

operation create product (command: CreateProduct) -> Product:
  let product be a new Product with id = new id, sku = command.sku, name = command.name, priceCents = command.priceCents
  perform save product with product = product
  return product

operation read product (id: uuid) -> Product or ProductNotFound:
  let product be find product by id with id = id
  return product

operation list all products () -> list of Product:
  return list products

operation update product (command: UpdateProduct) -> Product or ProductNotFound:
  let product be find product by id with id = command.productId
  set product.name to command.name
  set product.priceCents to command.priceCents
  perform save product with product = product
  return product

operation delete product (id: uuid) -> nothing or ProductNotFound:
  let product be find product by id with id = id
  perform delete product by id with id = id
```

Two things worth noticing.

`active` never appears in `create product` — it has `default true`, so the
constructor fills it in.

`delete product` loads the product it is about to delete and does nothing with
it. That is not waste: `find product by id` raises `ProductNotFound`, which is
how deleting something that does not exist becomes a 404 instead of a silent
204. The error propagates on its own; there is no `try`.

### 7. The routes

```
## endpoint POST /products
handled by ProductService.create product
request CreateProduct
responds 201 with Product

## endpoint GET /products
handled by ProductService.list all products
responds 200 with list of Product

## endpoint GET /products/{id}
handled by ProductService.read product
responds 200 with Product
responds 404 when ProductNotFound

## endpoint PUT /products/{productId}
handled by ProductService.update product
request UpdateProduct
responds 200 with Product
responds 404 when ProductNotFound

## endpoint DELETE /products/{id}
handled by ProductService.delete product
responds 204
responds 404 when ProductNotFound
```

Leave out one `responds ... when` and the compiler stops you:

```
error[AIL2305]: DELETE /products/{id} does not say what happens when ProductNotFound is raised
  help: add "responds 404 when ProductNotFound"
```

### 8. Where it runs

```
## infrastructure
port 8080
database inventorydb using postgres version 16
deploy to docker
```

### Then

```bash
ail check src
ail build src --target typescript --out out
cd out/typescript && npm install && npm run dev
```

And when you want the infrastructure:

```bash
ail deploy src --out out
docker compose -f out/docker/docker-compose.yml up
```

---

## Switching to a database

Change one line:

```
## adapter PostgresProductRepository implements ProductRepository using sql
config:
  table = products
```

Recompile. The adapter now issues real parameterised SQL for all four
repository phrases. The generated `main.ts` will have a `SqlClient` placeholder
at the top — hand it a `pg.Pool` and you are done:

```typescript
import { Pool } from 'pg';
const db = new Pool({ connectionString: process.env.DATABASE_URL });
```

Nothing else in the project changes. That is the whole point of the port.

---

## Compiling to another language

Same source, different backend:

```bash
ail build src --target java     # Spring Boot
ail build src --target python   # FastAPI
ail build src --target go       # Chi
ail build src --target rust     # Axum
ail build src --target all      # all five
```

Or let each bounded context choose its own with `target:` in the frontmatter.

---

## What this buys you over prompting for the code directly

The tasks example is 132 lines of `.ail`. It produces 420 lines of TypeScript
across 12 files, or 606 lines of Java across 19 — before tests, and before you
count the build files and the compose stack that come with them.

That ratio is the point. You iterate on 130 lines you can hold in your head,
where a mistake is a compiler error with a line number, and only then spend the
tokens to expand it. And the expansion is deterministic: the same source
produces the same output every time, so re-running it is free and reviewing it
is a diff rather than a re-read.

The compiler also refuses shapes that a model will happily produce and you will
happily approve:

```
warning[AIL2502]: dto ProductDto has exactly the same fields as aggregate Product
  help: a dto exists to carry less than the model; either drop fields or reuse Product

warning[AIL2504]: port PricingGateway has no callers
  help: add it to the "uses" line of the service that needs it, or delete it
```

Run `ail explain AIL2502` for the reasoning behind any of them.

---

## Returning a view instead of the aggregate

Exposing the aggregate straight out of an endpoint is fine to start with, and
wrong the moment the model grows a field the client should not see. Declare
what the wire carries:

```
## dto ProductView projects Product
- productId: uuid, required
- name: text, required
- priceCents: integer, required
```

Then build it without restating anything:

```
operation read product (id: uuid) -> ProductView or ProductNotFound:
  let product be find product by id with id = id
  return ProductView from product
```

`from` takes `name` and `priceCents` by name, and `productId` from the
aggregate's identity. Add a `with` clause for anything it cannot reach:

```
  return ProductView from product with priceLabel = format price with cents = product.priceCents
```

If a field cannot be resolved, that is a compile error naming it — the mapper
never quietly leaves a null behind.

## Known limits you will hit

- **No list projection.** `sum of items by quantity` works; there is no
  `each of items by field` yet, so a dto cannot carry a mapped list. Return the
  aggregate for now.
- **Adapters generate queries for four phrases.** `find … by id`, `save …`,
  `list …`, `delete … by id`. Anything else is left to you, explicitly, at the
  line where you have to write it.
- **Go and Rust output is unverified.** It is generated but nobody has run
  `go build` or `cargo check` on it yet.
