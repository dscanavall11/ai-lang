import { describe, expect, it } from 'vitest';
import { indexModule } from '@haic/core';
import { moduleHeader, parseErrors, parseOk } from './helpers.js';

describe('type expressions', () => {
  const cases: Array<[string, unknown]> = [
    ['text', { kind: 'primitive', name: 'text' }],
    ['string', { kind: 'primitive', name: 'text' }],
    ['int', { kind: 'primitive', name: 'integer' }],
    ['Money', { kind: 'named', name: 'Money' }],
    ['list of Money', { kind: 'list', of: { kind: 'named', name: 'Money' } }],
    ['set of uuid', { kind: 'set', of: { kind: 'primitive', name: 'uuid' } }],
    [
      'map from text to Money',
      { kind: 'map', key: { kind: 'primitive', name: 'text' }, value: { kind: 'named', name: 'Money' } },
    ],
    ['Money or nothing', { kind: 'optional', of: { kind: 'named', name: 'Money' } }],
    ['list of Money or nothing', { kind: 'optional', of: { kind: 'list', of: { kind: 'named', name: 'Money' } } }],
  ];

  for (const [written, expected] of cases) {
    it(`reads "${written}"`, () => {
      const { module } = parseOk(moduleHeader(`## dto Shape\n- field: ${written}\n`));
      expect(indexModule(module).dtos[0]!.fields[0]!.type).toEqual(expected);
    });
  }

  it('reads a result type from a port signature', () => {
    const { module } = parseOk(
      moduleHeader('## port Repo (outbound)\n- find thing (id: uuid) -> Thing or NotFound, Conflict\n'),
    );
    expect(indexModule(module).ports[0]!.operations[0]!.returns).toEqual({
      kind: 'result',
      ok: { kind: 'named', name: 'Thing' },
      errors: ['NotFound', 'Conflict'],
    });
  });
});

describe('field modifiers', () => {
  it('collects every declared constraint', () => {
    const { module } = parseOk(
      moduleHeader(
        '## dto Shape\n' +
          '- code: text, required, min length 3, max length 8, pattern "^[A-Z]+$", unique\n' +
          '- amount: decimal, min 0, max 100\n' +
          '- label: text, optional, default "none"\n' +
          '- ratio: decimal, immutable\n',
      ),
    );
    const fields = indexModule(module).dtos[0]!.fields;
    expect(fields[0]!.constraints).toEqual([
      { kind: 'min-length', value: 3 },
      { kind: 'max-length', value: 8 },
      { kind: 'pattern', value: '^[A-Z]+$' },
      { kind: 'unique' },
    ]);
    expect(fields[1]!.constraints).toEqual([
      { kind: 'min', value: 0 },
      { kind: 'max', value: 100 },
    ]);
    expect(fields[2]!.required).toBe(false);
    expect(fields[2]!.constraints).toEqual([{ kind: 'default', value: 'none' }]);
    expect(fields[3]!.constraints).toEqual([{ kind: 'immutable' }]);
  });

  it('reads a trailing comment as documentation', () => {
    const { module } = parseOk(moduleHeader('## dto Shape\n- currency: text  // ISO 4217 code\n'));
    expect(indexModule(module).dtos[0]!.fields[0]!.description).toBe('ISO 4217 code');
  });
});

describe('expressions', () => {
  function conditionOf(source: string): unknown {
    const { module } = parseOk(
      moduleHeader(`## dto Ignored\n- x: text\n\n## aggregate Thing\nidentified by id\n- id: uuid\n- quantity: integer\n- items: list of text\n- name: text\n\ninvariant "rule":\n  ${source}\n`),
    );
    return indexModule(module).aggregates[0]!.invariants[0]!.condition;
  }

  it('parses a comparison', () => {
    expect(conditionOf('quantity is greater than 0')).toMatchObject({
      kind: 'binary',
      operator: 'greater-than',
      left: expect.objectContaining({ kind: 'reference', path: ['quantity'] }),
      right: expect.objectContaining({ kind: 'literal', value: 0 }),
    });
  });

  it('parses "is not" as inequality', () => {
    expect(conditionOf('name is not "x"')).toMatchObject({ kind: 'binary', operator: 'not-equals' });
  });

  it('parses emptiness predicates', () => {
    expect(conditionOf('items is not empty')).toMatchObject({ kind: 'unary', operator: 'is-not-empty' });
    expect(conditionOf('items is empty')).toMatchObject({ kind: 'unary', operator: 'is-empty' });
  });

  it('gives "and" tighter binding than "or"', () => {
    expect(conditionOf('items is empty or quantity is at least 1 and name is not empty')).toMatchObject({
      kind: 'binary',
      operator: 'or',
      right: { kind: 'binary', operator: 'and' },
    });
  });

  it('gives multiplication tighter binding than addition', () => {
    expect(conditionOf('quantity plus quantity times 2 is at least 1')).toMatchObject({
      operator: 'greater-or-equal',
      left: { operator: 'add', right: { operator: 'multiply' } },
    });
  });

  it('reads a whole phrase as one operation name, including "by"', () => {
    const { module } = parseOk(
      moduleHeader(
        '## port Repo (outbound)\n- find order by id (id: uuid) -> Order\n\n' +
          '## aggregate Order\nidentified by id\n- id: uuid\n\n' +
          '## service S\nuses Repo\noperation run (id: uuid) -> Order:\n  let found be find order by id with id = id\n  return found\n',
      ),
    );
    const statement = indexModule(module).services[0]!.operations[0]!.body[0]!;
    expect(statement).toMatchObject({ kind: 'let', value: { kind: 'call', operation: 'find order by id' } });
  });

  it('keeps "by" out of the collection when aggregating', () => {
    const { module } = parseOk(
      moduleHeader(
        '## entity Line\nidentified by id\n- id: uuid\n- quantity: integer\n\n' +
          '## aggregate Cart\nidentified by id\ncontains Line\n- id: uuid\n- lines: list of Line\n' +
          '\noperation count units () -> integer:\n  return sum of lines by quantity\n',
      ),
    );
    const statement = indexModule(module).aggregates[0]!.operations[0]!.body[0]!;
    expect(statement).toMatchObject({
      kind: 'return',
      value: { kind: 'aggregate', fn: 'sum', collection: { path: ['lines'] }, of: { path: ['quantity'] } },
    });
  });
});

describe('statements', () => {
  function bodyOf(lines: string): string[] {
    const { module } = parseOk(
      moduleHeader(
        '## aggregate Thing\nidentified by id\n- id: uuid\n- names: list of text\n- flag: boolean\n\n' +
          `operation run () -> nothing:\n${lines}\n`,
      ),
    );
    return indexModule(module).aggregates[0]!.operations[0]!.body.map((s) => s.kind);
  }

  it('parses each statement form', () => {
    expect(bodyOf('  set flag to true\n  add "x" to names\n  remove "x" from names\n  return nothing')).toEqual([
      'set',
      'append',
      'remove',
      'return',
    ]);
  });

  it('parses a when/otherwise pair', () => {
    const { module } = parseOk(
      moduleHeader(
        '## aggregate Thing\nidentified by id\n- id: uuid\n- flag: boolean\n\n' +
          'operation run () -> nothing:\n  when flag is true:\n    set flag to false\n  otherwise:\n    set flag to true\n',
      ),
    );
    const statement = indexModule(module).aggregates[0]!.operations[0]!.body[0]!;
    expect(statement).toMatchObject({ kind: 'when', then: [{ kind: 'set' }], otherwise: [{ kind: 'set' }] });
  });

  it('parses the single-line when/then form', () => {
    const { module } = parseOk(
      moduleHeader(
        '## error Bad (unchecked)\nmessage: "bad"\n\n' +
          '## aggregate Thing\nidentified by id\n- id: uuid\n- flag: boolean\n\n' +
          'operation run () -> nothing:\n  when flag is true then fail with Bad\n',
      ),
    );
    expect(indexModule(module).aggregates[0]!.operations[0]!.body[0]).toMatchObject({
      kind: 'when',
      then: [{ kind: 'fail', error: 'Bad' }],
      otherwise: [],
    });
  });
});

describe('list projections', () => {
  const body = (statement: string): string =>
    moduleHeader(`## aggregate Basket\n- id: uuid, required\n- lines: list of Line, required\n\noperation run () -> nothing:\n  ${statement}\n`);

  it('reads "each of ... by ..." as a map', () => {
    const { module } = parseOk(body('let ids be each of lines by productId'));
    expect(indexModule(module).aggregates[0]!.operations[0]!.body[0]).toMatchObject({
      kind: 'let',
      value: { kind: 'project', fn: 'each', collection: { path: ['lines'] }, of: { path: ['productId'] } },
    });
  });

  it('reads "only ... where ..." as a filter', () => {
    const { module } = parseOk(body('let heavy be only lines where quantity is greater than 2'));
    expect(indexModule(module).aggregates[0]!.operations[0]!.body[0]).toMatchObject({
      kind: 'let',
      value: { kind: 'project', fn: 'only', of: { kind: 'binary', operator: 'greater-than' } },
    });
  });

  it('nests a filter inside a fold', () => {
    const { module } = parseOk(body('let total be sum of only lines where quantity is greater than 2 by quantity'));
    expect(indexModule(module).aggregates[0]!.operations[0]!.body[0]).toMatchObject({
      kind: 'let',
      value: { kind: 'aggregate', fn: 'sum', collection: { kind: 'project', fn: 'only' } },
    });
  });
});

describe('reported syntax errors', () => {
  const cases: Array<[string, string, string]> = [
    ['a field without a type', '## dto Shape\n- broken\n', 'HADL1101'],
    ['an unknown field modifier', '## dto Shape\n- x: text, wobbly\n', 'HADL1106'],
    ['an unknown type', '## dto Shape\n- x: wobbly\n', 'HADL1213'],
    ['a port without operations', '## port Repo (outbound)\n', 'HADL1021'],
    ['an operation without a parameter list', '## port Repo (outbound)\n- find thing -> Thing\n', 'HADL1108'],
    ['an error that says neither checked nor unchecked', '## error Oops\nmessage: "oops"\n', 'HADL1015'],
    ['an adapter without a port', '## adapter A using sql\n', 'HADL1022'],
    ['an endpoint with no handler', '## endpoint GET /things\nresponds 200\n', 'HADL1027'],
    ['an endpoint with no responses', '## endpoint GET /things\nhandled by S.run\n', 'HADL1029'],
    ['an aggregate with no identity', '## aggregate Thing\n- label: text\n', 'HADL1003'],
    // A misspelled clause used to be read as prose, so the aggregate silently
    // fell back to the `id` convention and nothing was reported.
    ['a misspelled clause', '## aggregate Thing\nprimaryKey id\n\n- id: uuid\n', 'HADL1006'],
    ['an unknown declaration keyword', '## widget Thing\n- x: text\n', 'HADL1612'],
    ['an unknown infrastructure setting', '## infrastructure\nteleport 9\n', 'HADL1508'],
    ['an unknown deployment target', '## infrastructure\ndeploy to mainframe\n', 'HADL1507'],
    ['a map with nothing to map', '## dto Shape\n- x: text\n\n## aggregate A\n- id: uuid\n- lines: list of Line\n\noperation r () -> nothing:\n  let ids be each of lines\n', 'HADL1112'],
    ['a filter with no condition', '## aggregate A\n- id: uuid\n- lines: list of Line\n\noperation r () -> nothing:\n  let kept be only lines\n', 'HADL1113'],
  ];

  for (const [label, source, code] of cases) {
    it(`reports ${label} as ${code}`, () => {
      expect(parseErrors(moduleHeader(source))).toContain(code);
    });
  }

  it('reports several problems in one pass', () => {
    const codes = parseErrors(moduleHeader('## dto Shape\n- broken\n- x: wobbly\n- y: text, wobbly\n'));
    expect(new Set(codes).size).toBeGreaterThan(1);
  });
});

describe('frontmatter', () => {
  it('defaults the context to the module name', () => {
    const { module } = parseOk('---\nmodule: billing\n---\n\n## dto Shape\n- x: text\n');
    expect(module.context).toBe('Billing');
  });

  it('reads imports with their relationship', () => {
    const { module } = parseOk(
      '---\nmodule: a\nimports:\n  - b via shared-kernel\n  - c exposing Thing, Other\n---\n\n## dto Shape\n- x: text\n',
    );
    expect(module.imports).toEqual([
      { module: 'b', names: [], via: 'shared-kernel' },
      { module: 'c', names: ['Thing', 'Other'], via: 'anti-corruption-layer' },
    ]);
  });

  it('rejects an unknown target', () => {
    expect(parseErrors('---\nmodule: a\ntarget: cobol\n---\n\n## dto Shape\n- x: text\n')).toContain('HADL1614');
  });
});

describe('a port that names its own technology', () => {
  const PORT = '## port Repo (outbound)\nusing sql\nconfig:\n  table = things\n\n- find thing (id: uuid) -> Thing\n';

  it('expands into the port plus its adapter', () => {
    const { module } = parseOk(moduleHeader(PORT));
    const index = indexModule(module);
    expect(index.ports.map((p) => p.name)).toEqual(['Repo']);
    expect(index.adapters).toEqual([
      expect.objectContaining({
        name: 'SqlRepo',
        implements: 'Repo',
        technology: 'sql',
        config: { table: 'things' },
      }),
    ]);
  });

  it('rejects a technology on an inbound port', () => {
    expect(parseErrors(moduleHeader('## port UseCase (inbound)\nusing sql\n\n- run (id: uuid) -> Thing\n'))).toContain('HADL1031');
  });

  it('rejects an unknown technology', () => {
    expect(parseErrors(moduleHeader(PORT.replace('using sql', 'using telepathy')))).toContain('HADL1032');
  });
});
