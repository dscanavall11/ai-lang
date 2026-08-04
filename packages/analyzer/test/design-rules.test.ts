import { describe, expect, it } from 'vitest';
import { uuidFor } from '@haic/core';
import { ORDER, analysed, check, codes, errorCodes } from './helpers.js';

describe('a constraint that does not fit its type', () => {
  const counter = (field: string): string => `## aggregate Counter
identified by id

- id: uuid, required
${field}

invariant "a counter counts":
  id is present
`;

  it('rejects a default that is not of the field\'s type', () => {
    expect(errorCodes(check(counter('- hits: integer, required, default false')))).toContain('HADL2155');
    expect(errorCodes(check(counter('- label: text, required, default 42')))).toContain('HADL2155');
    expect(errorCodes(check(counter('- active: boolean, required, default "yes"')))).toContain('HADL2155');
  });

  it('says what to write instead', () => {
    const reported = check(counter('- hits: integer, required, default false'));
    expect(reported.find((d) => d.code === 'HADL2155')?.message).toContain('false is not a number');
    expect(reported.find((d) => d.code === 'HADL2155')?.hint).toContain('default 0');
  });

  it('rejects a fractional default on a whole number', () => {
    expect(errorCodes(check(counter('- hits: integer, required, default 1.5')))).toContain('HADL2155');
    expect(errorCodes(check(counter('- ratio: decimal, required, default 1.5')))).not.toContain('HADL2155');
  });

  it('accepts an enum member and rejects one the enum does not have', () => {
    const withEnum = (value: string): string =>
      `## enum State\n- Draft\n- Placed\n\n${counter(`- state: State, required, default ${value}`)}`;
    expect(errorCodes(check(withEnum('Draft')))).not.toContain('HADL2155');
    expect(errorCodes(check(withEnum('Shipped')))).toContain('HADL2155');
  });

  it('rejects a literal default for a shape that is built from fields', () => {
    const withShape = `## value object Money\n- amount: decimal, required\n\n${counter('- total: Money, required, default 0')}`;
    expect(errorCodes(check(withShape))).toContain('HADL2155');
  });

  it('rejects "default nothing" on a required field and allows it on an optional one', () => {
    expect(errorCodes(check(counter('- note: text, required, default nothing')))).toContain('HADL2155');
    expect(errorCodes(check(counter('- note: text, optional, default nothing')))).not.toContain('HADL2155');
  });

  it('rejects a length constraint on a number and a range on text', () => {
    expect(errorCodes(check(counter('- hits: integer, required, min length 2')))).toContain('HADL2156');
    expect(errorCodes(check(counter('- label: text, required, min 2')))).toContain('HADL2156');
    expect(errorCodes(check(counter('- code: uuid, required, pattern "[a-z]+"')))).toContain('HADL2156');
  });

  it('leaves the constraints that do fit alone', () => {
    expect(errorCodes(check(counter('- label: text, required, min length 1, max length 8, pattern "[a-z]+"')))).toEqual([]);
    expect(errorCodes(check(counter('- hits: integer, required, min 0, max 10, default 0')))).toEqual([]);
    expect(errorCodes(check(counter('- tags: list of text, required, min length 1')))).toEqual([]);
  });
});

describe('domain-driven design rules', () => {
  it('rejects an aggregate embedding another aggregate', () => {
    const diagnostics = check(`${ORDER}
## aggregate Customer
identified by id
- id: uuid, required
- order: Order, required

invariant "a customer is real":
  id is not empty
`);
    expect(errorCodes(diagnostics)).toContain('HADL2207');
    expect(diagnostics.find((d) => d.code === 'HADL2207')?.hint).toContain('store the identity instead');
  });

  it('rejects a value object holding something with identity', () => {
    expect(
      errorCodes(
        check(`${ORDER}
## value object Snapshot
- taken: Order, required
`),
      ),
    ).toContain('HADL2208');
  });

  it('rejects reaching past an aggregate root to its inner entity', () => {
    expect(
      errorCodes(
        check(`## entity Line
identified by id
- id: uuid, required
- quantity: integer, required

## aggregate Cart
identified by id
contains Line
- id: uuid, required
- lines: list of Line, required

invariant "a cart holds lines":
  lines is not empty

## dto CartView
- line: Line, required
`),
      ),
    ).toContain('HADL2206');
  });

  it('rejects two aggregates claiming the same entity', () => {
    expect(
      errorCodes(
        check(`## entity Line
identified by id
- id: uuid, required

## aggregate Cart
identified by id
contains Line
- id: uuid, required
- lines: list of Line, required

invariant "a cart holds lines":
  lines is not empty

## aggregate Invoice
identified by id
contains Line
- id: uuid, required
- lines: list of Line, required

invariant "an invoice holds lines":
  lines is not empty
`),
      ),
    ).toContain('HADL2203');
  });

  it('rejects I/O inside an aggregate operation', () => {
    expect(
      errorCodes(
        check(`## error Missing (checked, status 404)
message: "missing"
- id: uuid, required

## port Repo (outbound)
- load thing (id: uuid) -> Order or Missing

## adapter Memory implements Repo using in-memory

## aggregate Order
identified by id
- id: uuid, required

operation refresh () -> nothing:
  perform load thing with id = id
`),
      ),
    ).toContain('HADL2213');
  });

  it('warns about an aggregate with no rules and no behaviour', () => {
    expect(
      codes(
        check(`## aggregate Blob
identified by id
- id: uuid, required
- payload: text, required
`),
      ),
    ).toContain('HADL2214');
  });

  it('accepts an aggregate that references another by identity', () => {
    expect(
      errorCodes(
        check(`${ORDER}
## aggregate Customer
identified by id
- id: uuid, required
- lastOrderId: uuid, optional

invariant "a customer is real":
  id is not empty
`),
      ),
    ).not.toContain('HADL2207');
  });
});

describe('checked and unchecked error flow', () => {
  const PORT = `## error Missing (checked, status 404)
message: "no thing with id {id}"
- id: uuid, required

## error Broken (unchecked)
message: "broken"

## port Repo (outbound)
- load thing (id: uuid) -> Order or Missing
- store thing (order: Order) -> nothing

## adapter Memory implements Repo using in-memory
`;

  it('rejects an unchecked error in a contract', () => {
    expect(
      errorCodes(
        check(`${ORDER}${PORT}
## service S
uses Repo
operation run (id: uuid) -> Order or Broken:
  let found be load thing with id = id
  return found
`),
      ),
    ).toContain('HADL2302');
  });

  it('rejects raising a checked error the contract omits', () => {
    const diagnostics = check(`${ORDER}${PORT}
## service S
uses Repo
operation run (id: uuid) -> Order:
  let found be load thing with id = id
  return found
`);
    expect(errorCodes(diagnostics)).toContain('HADL2303');
    expect(diagnostics.find((d) => d.code === 'HADL2303')?.hint).toContain('-> ... or Missing');
  });

  it('warns about a declared error that can never be raised', () => {
    expect(
      codes(
        check(`${ORDER}${PORT}
## error Unused (checked, status 400)
message: "unused"

## service S
uses Repo
operation run (order: Order) -> nothing or Unused:
  perform store thing with order = order
`),
      ),
    ).toContain('HADL2304');
  });

  it('rejects an endpoint that leaves a checked error unmapped', () => {
    expect(
      errorCodes(
        check(`${ORDER}${PORT}
## service S
uses Repo
operation run (id: uuid) -> Order or Missing:
  let found be load thing with id = id
  return found

## endpoint GET /things/{id}
handled by S.run
responds 200 with Order
`),
      ),
    ).toContain('HADL2305');
  });

  it('accepts a contract where every raised error is declared and mapped', () => {
    expect(
      errorCodes(
        check(`${ORDER}${PORT}
## service S
uses Repo
operation run (id: uuid) -> Order or Missing:
  let found be load thing with id = id
  return found

## endpoint GET /things/{id}
handled by S.run
responds 200 with Order
responds 404 when Missing
`),
      ),
    ).toEqual([]);
  });
});

describe('hexagonal architecture and SOLID', () => {
  it('rejects a service depending on an adapter', () => {
    const diagnostics = check(`${ORDER}
## port Repo (outbound)
- store thing (order: Order) -> nothing

## adapter Memory implements Repo using in-memory

## service S
uses Memory
operation run (order: Order) -> nothing:
  perform store thing with order = order
`);
    expect(errorCodes(diagnostics)).toContain('HADL2402');
    expect(diagnostics.find((d) => d.code === 'HADL2402')?.hint).toContain('uses Repo');
  });

  it('rejects an outbound port with no adapter', () => {
    expect(
      errorCodes(
        check(`${ORDER}
## port Repo (outbound)
- store thing (order: Order) -> nothing

## service S
uses Repo
operation run (order: Order) -> nothing:
  perform store thing with order = order
`),
      ),
    ).toContain('HADL2408');
  });

  it('rejects an inbound port nobody implements', () => {
    expect(
      errorCodes(
        check(`${ORDER}
## port UseCase (inbound)
- run (order: Order) -> nothing
`),
      ),
    ).toContain('HADL2409');
  });

  it('warns about a port that does too many things', () => {
    const operations = Array.from({ length: 9 }, (_, i) => `- do thing ${i} (order: Order) -> nothing`).join('\n');
    expect(
      codes(
        check(`${ORDER}
## port Wide (outbound)
${operations}

## adapter Memory implements Wide using in-memory
`),
      ),
    ).toContain('HADL2421');
  });

  it('rejects an endpoint whose path parameter nothing carries', () => {
    expect(
      errorCodes(
        check(`${ORDER}
## port Repo (outbound)
- store thing (order: Order) -> nothing

## adapter Memory implements Repo using in-memory

## service S
uses Repo
operation run (order: Order) -> nothing:
  perform store thing with order = order

## endpoint POST /things/{tenantId}
handled by S.run
responds 204
`),
      ),
    ).toContain('HADL2416');
  });
});

describe('simplicity rules', () => {
  const REPO = `## port Repo (outbound)
- load thing (id: uuid) -> Order
- store thing (order: Order) -> nothing

## adapter Memory implements Repo using in-memory
`;

  it('warns about a service operation that only forwards a call', () => {
    const diagnostics = check(`${ORDER}${REPO}
## service S
uses Repo
operation fetch (id: uuid) -> Order:
  return load thing with id = id

## endpoint GET /things/{id}
handled by S.fetch
responds 200 with Order
`);
    expect(codes(diagnostics)).toContain('HADL2503');
  });

  it('warns about a dto with exactly the same shape as the model', () => {
    expect(
      codes(
        check(`## aggregate Thing
identified by id
- id: uuid, required
- label: text, required

invariant "a thing has a label":
  label is not empty

## dto ThingDto
- id: uuid, required
- label: text, required
`),
      ),
    ).toContain('HADL2502');
  });

  it('warns about a port with no callers', () => {
    expect(
      codes(
        check(`${ORDER}${REPO}
## port Spare (outbound)
- do nothing (order: Order) -> nothing

## adapter SpareMemory implements Spare using in-memory
`),
      ),
    ).toContain('HADL2504');
  });

  it('warns about a declaration nothing reaches', () => {
    expect(
      codes(
        check(`${ORDER}${REPO}
## dto Orphan
- ghost: text, required
`),
      ),
    ).toContain('HADL2501');
  });

  it('promotes every warning to an error under --strict', () => {
    const relaxed = check(`${ORDER}${REPO}
## dto Orphan
- ghost: text, required
`);
    const strict = check(
      `${ORDER}${REPO}
## dto Orphan
- ghost: text, required
`,
      { strict: true },
    );
    expect(relaxed.filter((d) => d.severity === 'error')).toEqual([]);
    expect(strict.some((d) => d.severity === 'error' && d.code === 'HADL2501')).toBe(true);
  });
});

describe('type checking', () => {
  it('rejects comparing values of different types', () => {
    expect(
      errorCodes(
        check(`## aggregate Thing
identified by id
- id: uuid, required
- count: integer, required
- label: text, required

invariant "nonsense":
  count is label
`),
      ),
    ).toContain('HADL2105');
  });

  it('rejects arithmetic on text', () => {
    expect(
      errorCodes(
        check(`## aggregate Thing
identified by id
- id: uuid, required
- label: text, required
- count: integer, required

invariant "nonsense":
  label times 2 is at least count
`),
      ),
    ).toContain('HADL2116');
  });

  it('rejects an unknown field', () => {
    expect(
      errorCodes(
        check(`## aggregate Thing
identified by id
- id: uuid, required
- label: text, required

invariant "nonsense":
  missing is not empty
`),
      ),
    ).toContain('HADL2101');
  });

  it('rejects a constructor missing a required field', () => {
    expect(
      errorCodes(
        check(`## value object Money
- amount: decimal, required
- currency: text, required

## aggregate Thing
identified by id
- id: uuid, required
- price: Money, required

operation reprice () -> Money:
  return Money with amount = 1
`),
      ),
    ).toContain('HADL2114');
  });

  it('rejects assigning to an immutable field', () => {
    expect(
      errorCodes(
        check(`## value object Money
- amount: decimal, required

## aggregate Thing
identified by id
- id: uuid, required
- price: Money, required

operation cheapen () -> nothing:
  set price.amount to 0
`),
      ),
    ).toContain('HADL2125');
  });

  it('suggests a near-miss name', () => {
    const diagnostics = check(`## aggregate Thing
identified by id
- id: uuid, required
- label: text, required

invariant "typo":
  labell is not empty
`);
    expect(diagnostics.find((d) => d.code === 'HADL2101')?.hint).toContain('label');
  });
});

describe('optional narrowing', () => {
  const SOURCE = `## error Missing (checked, status 404)
message: "missing"

## port Repo (outbound)
- load label (id: uuid) -> text or nothing

## adapter Memory implements Repo using in-memory

## aggregate Thing
identified by id
- id: uuid, required

invariant "a thing has an id":
  id is not empty

## service S
uses Repo
operation run (id: uuid) -> text or Missing:
`;

  it('rejects using an optional before it is checked', () => {
    expect(
      errorCodes(
        check(`${SOURCE}  let found be load label with id = id
  return found
`),
      ),
    ).toContain('HADL2141');
  });

  it('accepts an optional inside a presence check', () => {
    expect(
      errorCodes(
        check(`${SOURCE}  let found be load label with id = id
  when found is present:
    return found
  fail with Missing
`),
      ),
    ).toEqual([]);
  });

  it('narrows the other branch for an absence check', () => {
    expect(
      errorCodes(
        check(`${SOURCE}  let found be load label with id = id
  when found is absent:
    fail with Missing
  otherwise:
    return found
`),
      ),
    ).toEqual([]);
  });
});

describe('mapping with "from"', () => {
  const BASE = `## enum State
- Open
- Done

## aggregate Order
identified by id
- id: uuid, required
- label: text, required
- state: State, required, default Open
- lines: list of text, required

invariant "an order has a label":
  label is not empty

## error Missing (checked, status 404)
message: "missing"
- orderId: uuid, required

## port Repo (outbound)
- load order (id: uuid) -> Order or Missing

## adapter Memory implements Repo using in-memory
`;

  function service(body: string, dto: string): string {
    return `${BASE}
## dto Summary
${dto}

## service S
uses Repo
operation run (id: uuid) -> Summary or Missing:
  let order be load order with id = id
${body}
`;
  }

  it('takes matching fields by name and the identity as <thing>Id', () => {
    expect(
      errorCodes(
        check(service('  return Summary from order', '- orderId: uuid, required\n- label: text, required\n- state: State, required')),
      ),
    ).toEqual([]);
  });

  it('refuses to guess a field the source does not have', () => {
    const diagnostics = check(
      service('  return Summary from order', '- orderId: uuid, required\n- lineCount: integer, required'),
    );
    expect(errorCodes(diagnostics)).toContain('HADL2147');
    expect(diagnostics.find((d) => d.code === 'HADL2147')?.hint).toContain('with lineCount = ...');
  });

  it('lets an explicit argument fill what the source cannot', () => {
    expect(
      errorCodes(
        check(
          service(
            '  return Summary from order with lineCount = count of order.lines',
            '- orderId: uuid, required\n- lineCount: integer, required',
          ),
        ),
      ),
    ).toEqual([]);
  });

  it('says so when the clause maps nothing', () => {
    expect(
      codes(
        check(
          service('  return Summary from order with lineCount = count of order.lines', '- lineCount: integer, required'),
        ),
      ),
    ).toContain('HADL2148');
  });

  it('rejects mapping from something without fields', () => {
    expect(errorCodes(check(service('  return Summary from id', '- orderId: uuid, required')))).toContain('HADL2145');
  });

  it('rejects a bare type name used as a value', () => {
    const diagnostics = check(service('  return Summary', '- orderId: uuid, required'));
    expect(errorCodes(diagnostics)).toContain('HADL2149');
    expect(diagnostics.find((d) => d.code === 'HADL2149')?.hint).toContain('Summary from <source>');
  });
});

describe('a port that names its own technology', () => {
  const SHORT = `## aggregate Note
identified by id
- id: uuid, required
- body: text, required

invariant "a note has a body":
  body is not empty

## error Missing (checked, status 404)
message: "missing"
- noteId: uuid, required

## port NoteRepository (outbound)
using sql
config:
  table = notes

- find note by id (id: uuid) -> Note or Missing

## port NoteUseCases (inbound)
- read note (id: uuid) -> Note or Missing

## service NoteService
uses NoteRepository
implements NoteUseCases

operation read note (id: uuid) -> Note or Missing:
  let note be find note by id with id = id
  return note

## endpoint GET /notes/{id}
handled by NoteService.read note
responds 200 with Note
responds 404 when Missing
`;

  it('satisfies the port without a separate adapter declaration', () => {
    expect(errorCodes(check(SHORT))).toEqual([]);
  });

  it('still reports a port that names no technology and has no adapter', () => {
    expect(errorCodes(check(SHORT.replace('using sql\nconfig:\n  table = notes\n\n', '')))).toContain('HADL2408');
  });

  it('says which adapter wins when a port has more than one', () => {
    const diagnostics = check(`${SHORT}
## adapter MemoryNoteRepository implements NoteRepository using in-memory
`);
    expect(codes(diagnostics)).toContain('HADL2423');
    expect(diagnostics.find((d) => d.code === 'HADL2423')?.hint).toContain('SqlNoteRepository');
  });

});

describe('queries', () => {
  const BASE = `## enum State
- Open
- Done

## aggregate Task
identified by id
- id: uuid, required
- title: text, required
- state: State, required, default Open
- dueOn: date, optional

invariant "a task has a title":
  title is not empty
`;

  it('accepts a filter over the aggregate it selects from', () => {
    expect(
      errorCodes(
        check(`${BASE}
## query Search over Task
- state: State, optional
- titleContains: text, optional

match task.state is state
match task.title contains titleContains

sort by task.dueOn ascending
limit 20
`),
      ),
    ).toEqual([]);
  });

  it('treats an optional parameter as present inside its own criterion', () => {
    // The criterion only runs when the parameter is supplied, so `State or
    // nothing` compares against a plain `State` rather than failing to unify.
    expect(
      errorCodes(
        check(`${BASE}
## query Search over Task
- state: State, optional

match task.state is state
`),
      ),
    ).not.toContain('HADL2105');
  });

  it('rejects selecting from something that is not an aggregate', () => {
    expect(
      errorCodes(
        check(`${BASE}
## dto Row
- id: uuid, required

## query Search over Row
- rowId: uuid, required

match row.id is rowId
`),
      ),
    ).toContain('HADL2150');
  });

  it('rejects sorting by something with no order', () => {
    expect(
      errorCodes(
        check(`${BASE}
## query Search over Task
- state: State, optional

match task.state is state
sort by task.title ascending
`),
      ),
    ).toContain('HADL2152');
  });

  it('warns about a parameter no criterion reads', () => {
    expect(
      codes(
        check(`${BASE}
## query Search over Task
- state: State, optional
- unused: text, optional

match task.state is state
`),
      ),
    ).toContain('HADL2153');
  });
});

describe('a literal standing where a uuid is declared', () => {
  const withId = (value: string, then = 'then result is present'): string => `## aggregate Note
identified by id

- id: uuid, required
- title: text, required

invariant "a note is titled":
  title is not empty

operation rename (to: text) -> text:
  set title to to
  return title

## scenario naming a note

given note be Note with id = ${value}, title = "Draft"
when rename with note = note, to = "Final"
${then}
`;

  it('is accepted, because an id in a design is a name', () => {
    expect(errorCodes(check(withId('"n-1"', 'then result is "Final"')))).toEqual([]);
  });

  it('becomes the same uuid every time, and a different one per name', () => {
    expect(uuidFor('n-1')).toBe(uuidFor('n-1'));
    expect(uuidFor('n-1')).not.toBe(uuidFor('n-2'));
    expect(uuidFor('n-1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('leaves a value that is already a uuid exactly as written', () => {
    const written = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(uuidFor(written)).toBe(written);
  });

  it('is recorded in the IR, so every backend sees the same value', () => {
    const module = analysed(withId('"n-1"', 'then result is "Final"'));
    const scenario = module.declarations.find((d) => d.kind === 'scenario')!;
    const given = (scenario as { given: Array<{ value: { arguments: Array<{ name: string; value: { value: unknown } }> } }> }).given[0]!;
    const id = given.value.arguments.find((argument) => argument.name === 'id')!;
    expect(id.value.value).toBe(uuidFor('n-1'));
  });

  it('converts on both sides of a comparison', () => {
    // `then note.id is "n-1"` reads as a question about the same note.
    expect(errorCodes(check(withId('"n-1"', 'then note.id is "n-1"')))).toEqual([]);
  });

  it('does not convert anything else', () => {
    // Only text-to-uuid. A number where text is declared is still an error.
    expect(errorCodes(check(withId('"n-1"', 'then result is 3')))).toContain('HADL2105');
  });
});

describe('a scenario, which is a program too', () => {
  const shape = `## value object Point
- latitude: decimal, required
- longitude: decimal, required

## aggregate Pin
identified by id

- id: uuid, required
- at: Point, required
- label: text, required

invariant "a pin is labelled":
  label is not empty

operation rename (to: text) -> text:
  set label to to
  return label
`;

  it('catches an argument that landed on the wrong construction', () => {
    // The parser reads `label` as a third argument to the Point, which is the
    // bug this check exists for: `haic test` passed it, TypeScript did not.
    const reported = check(`${shape}
## scenario naming a pin

given pin be Pin with id = "p-1", at = Point with latitude = 1, longitude = 2, label = "Home"
when rename with pin = pin, to = "Away"
then result is "Away"
`);
    expect(errorCodes(reported).length).toBeGreaterThan(0);
  });

  it('accepts it once the point is bound first', () => {
    expect(
      errorCodes(check(`${shape}
## scenario naming a pin

given here be Point with latitude = 1, longitude = 2
and pin be Pin with id = "p-1", at = here, label = "Home"
when rename with pin = pin, to = "Away"
then result is "Away"
`)),
    ).toEqual([]);
  });

  it('rejects a "then" that is not a yes or no', () => {
    expect(errorCodes(check(`${shape}
## scenario naming a pin

given here be Point with latitude = 1, longitude = 2
and pin be Pin with id = "p-1", at = here, label = "Home"
when rename with pin = pin, to = "Away"
then result
`))).toContain('HADL2157');
  });

  it('rejects an error or an event nothing declares', () => {
    const base = `${shape}
## scenario naming a pin

given here be Point with latitude = 1, longitude = 2
and pin be Pin with id = "p-1", at = here, label = "Home"
when rename with pin = pin, to = "Away"
`;
    expect(errorCodes(check(`${base}then it fails with Nope\n`))).toContain('HADL2158');
    expect(errorCodes(check(`${base}then it publishes Nope\n`))).toContain('HADL2159');
  });

  it('accepts the failures the language raises itself', () => {
    expect(
      errorCodes(check(`${shape}
## scenario naming a pin nothing

given here be Point with latitude = 1, longitude = 2
and pin be Pin with id = "p-1", at = here, label = "Home"
when rename with pin = pin, to = ""
then it fails with InvariantViolation
`)),
    ).toEqual([]);
  });
});
