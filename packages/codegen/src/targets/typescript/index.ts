/**
 * TypeScript / Node.js backend.
 *
 * Emits a hexagonal project: plain domain classes with their invariants,
 * application services that depend on port interfaces, adapters that implement
 * them, and a thin HTTP layer that maps checked errors to status codes.
 */
import {
  CodeWriter,
  GENERATED_BANNER,
  camelCase,
  comment,
  file,
  indexModule,
  kebabCase,
  pascalCase,
  screamingSnakeCase,
  tableName,
  typeToString,
  type CodeGenerator,
  type GeneratedFile,
  type GenerationContext,
  type GenerationResult,
  type IRAggregateDecl,
  type IRDeclaration,
  type IREntityDecl,
  type IRExpression,
  type IRField,
  type IRModule,
  type IROperation,
  type IROperationSignature,
  type IRQueryDecl,
  type IRType,
  type ModuleIndex,
  scenarioPlans,
  type IRPortDecl,
  type ScenarioPlan,
  type ServicePlan,
} from '@haic/core';
import { declaredImplementation } from '../../shared/adapters.js';
import { emitScenarioBody, skippedComments, type TestHooks } from '../../shared/scenario-tests.js';
import { prefixReferences } from '../../shared/emitter.js';
import { ProjectLayout, relativeImport } from '../../shared/layout.js';
import { compileQuery } from '../../shared/query-sql.js';
import { TypeScriptEmitter } from './emitter.js';

const layout = new ProjectLayout({ sourceRoot: 'src', extension: '.ts' });

export const typescriptGenerator: CodeGenerator = {
  id: 'typescript',
  displayName: 'TypeScript',
  framework: 'Node.js + Express',
  verifyCommand: ['npm', 'run', 'build'],

  generate(module, context) {
    const index = indexModule(module);
    const files = [
      enumsFile(module, index),
      valueObjectsFile(module, index),
      modelFile(module, index),
      errorsFile(module, index),
      messagesFile(module, index),
      portsFile(module, index),
      servicesFile(module, index),
      adaptersFile(module, index),
      routesFile(module, index),
      handlersFile(module, index),
      scenarioTestsFile(module, index),
    ].filter((f): f is NonNullable<typeof f> => f !== null);

    void context;
    return { files, diagnostics: [] };
  },

  generateProject(context) {
    return {
      files: [
        packageJson(context),
        tsconfig(),
        sharedErrors(),
        sharedValidation(),
        sharedEventPublisher(),
        sharedSqlClient(),
        mainFile(context),
        readme(context),
        dotEnvExample(context),
      ],
      diagnostics: [],
    };
  },
};

// ---------------------------------------------------------------------------
// Domain layer
// ---------------------------------------------------------------------------

function enumsFile(module: IRModule, index: ModuleIndex) {
  if (index.enums.length === 0) return null;
  const writer = new CodeWriter();
  for (const declaration of index.enums) {
    docComment(writer, declaration.description);
    writer.line(`export enum ${pascalCase(declaration.name)} {`);
    writer.block(() => {
      for (const value of declaration.values) {
        if (value.description) writer.line(`/** ${value.description} */`);
        writer.line(`${value.name} = '${value.name}',`);
      }
    });
    writer.line('}');
    writer.blank();
  }
  return assemble(layout.path('domain', module, 'enums'), module, index, {}, writer);
}

function valueObjectsFile(module: IRModule, index: ModuleIndex) {
  if (index.valueObjects.length === 0) return null;
  const self = layout.path('domain', module, 'value-objects');
  const writer = new CodeWriter();
  const emitter = new TypeScriptEmitter(index);
  for (const declaration of index.valueObjects) {
    const selfEmitter = new TypeScriptEmitter(index, new Map(), new Set(declaration.fields.map((f) => f.name)));
    docComment(writer, declaration.description ?? `Value object ${declaration.name}. Compared by value, never by identity.`);
    writer.line(`export class ${pascalCase(declaration.name)} {`);
    writer.block(() => {
      for (const field of declaration.fields) {
        fieldDoc(writer, field);
        writer.line(`readonly ${camelCase(field.name)}: ${emitter.typeName(field.type)};`);
      }
      writer.blank();
      writer.line(`constructor(input: ${pascalCase(declaration.name)}Input) {`);
      writer.block(() => {
        for (const field of declaration.fields) {
          writer.line(`this.${camelCase(field.name)} = ${defaultedInput(field, emitter)};`);
        }
        emitConstraintChecks(writer, declaration.name, declaration.fields, emitter);
        emitInvariantChecks(writer, declaration.invariants, selfEmitter);
        writer.line('Object.freeze(this);');
      });
      writer.line('}');
      writer.blank();
      writer.line(`equals(other: ${pascalCase(declaration.name)}): boolean {`);
      writer.block(() => {
        const comparisons = declaration.fields.map((f) => `this.${camelCase(f.name)} === other.${camelCase(f.name)}`);
        writer.line(`return ${comparisons.join(' && ')};`);
      });
      writer.line('}');
    });
    writer.line('}');
    writer.blank();
    writeInputType(writer, declaration.name, declaration.fields, emitter);
  }
  return assemble(self, module, index, { enums: true, valueObjects: true, validation: true }, writer);
}

function modelFile(module: IRModule, index: ModuleIndex) {
  const shapes = [...index.entities, ...index.aggregates];
  if (shapes.length === 0) return null;

  const self = layout.path('domain', module, 'model');
  const writer = new CodeWriter();
  const emitter = new TypeScriptEmitter(index);

  for (const declaration of shapes) {
    const fieldNames = new Set(declaration.fields.map((f) => f.name));
    const selfEmitter = new TypeScriptEmitter(index, new Map(), fieldNames);
    const kindLabel = declaration.kind === 'aggregate' ? 'Aggregate root' : 'Entity';
    docComment(
      writer,
      declaration.description ?? `${kindLabel} ${declaration.name}, identified by ${declaration.identity.join(', ')}.`,
    );
    writer.line(`export class ${pascalCase(declaration.name)} {`);
    writer.block(() => {
      for (const field of declaration.fields) {
        fieldDoc(writer, field);
        const readonly = declaration.identity.includes(field.name) ? 'readonly ' : '';
        const rendered = field.derived ? `${emitter.typeName(field.type)} | null` : emitter.typeName(field.type);
        writer.line(`${readonly}${camelCase(field.name)}: ${rendered};`);
      }
      writer.blank();
      writer.line(`constructor(input: ${pascalCase(declaration.name)}Input) {`);
      writer.block(() => {
        for (const field of declaration.fields) {
          writer.line(`this.${camelCase(field.name)} = ${defaultedInput(field, emitter)};`);
        }
        writer.line('this.checkInvariants();');
      });
      writer.line('}');
      writer.blank();

      writer.line('/** Re-checks every rule declared on this type. Call after any change. */');
      writer.line('checkInvariants(): void {');
      writer.block(() => {
        emitConstraintChecks(writer, declaration.name, declaration.fields, emitter);
        emitInvariantChecks(writer, declaration.invariants, selfEmitter);
        if (declaration.fields.length === 0 && declaration.invariants.length === 0) writer.line('// no rules declared');
      });
      writer.line('}');

      for (const operation of operationsOf(declaration)) {
        writer.blank();
        // Parameters shadow fields of the same name, so they leave the self set.
        const visible = new Set([...fieldNames].filter((n) => !operation.parameters.some((param) => param.name === n)));
        emitOperation(writer, new TypeScriptEmitter(index, new Map(), visible), operation, { async: false });
      }
    });
    writer.line('}');
    writer.blank();
    writeInputType(writer, declaration.name, declaration.fields, emitter);
  }
  return assemble(self, module, index, { enums: true, valueObjects: true, errors: true, validation: true }, writer);
}

function errorsFile(module: IRModule, index: ModuleIndex) {
  if (index.errors.length === 0) return null;
  const self = layout.path('domain', module, 'errors');
  const writer = new CodeWriter();
  const emitter = new TypeScriptEmitter(index);
  for (const declaration of index.errors) {
    const base = declaration.checked ? 'CheckedError' : 'UncheckedError';
    docComment(
      writer,
      declaration.description ??
        (declaration.checked
          ? 'Checked: part of the operation contract, callers are expected to handle it.'
          : 'Unchecked: signals a bug. Do not catch it to keep going.'),
    );
    writer.line(`export class ${pascalCase(declaration.name)} extends ${base} {`);
    writer.block(() => {
      writer.line(`static readonly code = '${screamingSnakeCase(declaration.name)}';`);
      writer.line(`static readonly status = ${declaration.status ?? (declaration.checked ? 400 : 500)};`);
      writer.blank();
      writer.line(`constructor(readonly details: ${errorDetailsType(declaration.fields, emitter)}) {`);
      writer.block(() => {
        writer.line(`super(${pascalCase(declaration.name)}.code, ${pascalCase(declaration.name)}.status, ${messageTemplate(declaration.message, declaration.fields)});`);
      });
      writer.line('}');
    });
    writer.line('}');
    writer.blank();
  }
  return assemble(self, module, index, {}, writer, [
    `import { CheckedError, UncheckedError } from '${relativeImport(self, layout.sharedPath('errors'), false)}.js';`,
  ]);
}

function messagesFile(module: IRModule, index: ModuleIndex) {
  const shapes = [...index.commands, ...index.events, ...index.dtos, ...index.queries];
  if (shapes.length === 0) return null;

  const self = layout.path('domain', module, 'messages');
  const writer = new CodeWriter();
  const emitter = new TypeScriptEmitter(index);
  for (const declaration of shapes) {
    const role =
      declaration.kind === 'command'
        ? `Command handled by ${declaration.target ?? 'the application layer'}.`
        : declaration.kind === 'event'
          ? `Event emitted by ${declaration.source ?? 'the domain'}.`
          : declaration.kind === 'query'
            ? `Selects ${declaration.over} records matching its fields.`
            : `Data transfer object${declaration.projects ? ` projecting ${declaration.projects}` : ''}.`;
    docComment(writer, declaration.description ?? role);
    writer.line(`export interface ${pascalCase(declaration.name)} {`);
    writer.block(() => {
      for (const field of declaration.fields) {
        fieldDoc(writer, field);
        // HADL has no `undefined`: an optional field is present and null, so
        // it assigns straight into a domain field of the same optional type.
        writer.line(`${camelCase(field.name)}: ${emitter.typeName(field.type)};`);
      }
    });
    writer.line('}');
    writer.blank();
    if (declaration.kind === 'event') {
      writer.line(`export const ${screamingSnakeCase(declaration.name)}_TOPIC = '${declaration.topic ?? kebabCase(declaration.name)}';`);
      writer.blank();
    }
  }
  return assemble(self, module, index, { enums: true, valueObjects: true }, writer);
}

// ---------------------------------------------------------------------------
// Application layer
// ---------------------------------------------------------------------------

function portsFile(module: IRModule, index: ModuleIndex) {
  if (index.ports.length === 0) return null;
  const self = layout.path('application', module, 'ports');
  const writer = new CodeWriter();
  const emitter = new TypeScriptEmitter(index);
  for (const port of index.ports) {
    docComment(
      writer,
      port.description ??
        (port.direction === 'inbound'
          ? 'Inbound port: a use case the outside world can drive.'
          : 'Outbound port: something the domain drives. Implemented by an adapter.'),
    );
    writer.line(`export interface ${pascalCase(port.name)} {`);
    writer.block(() => {
      for (const operation of port.operations) {
        signatureDoc(writer, operation);
        writer.line(`${camelCase(operation.phrase)}(${parameterObject(operation, emitter)}): Promise<${emitter.typeName(operation.returns)}>;`);
      }
    });
    writer.line('}');
    writer.blank();
  }
  return assemble(self, module, index, { enums: true, valueObjects: true, model: true, messages: true }, writer);
}

function servicesFile(module: IRModule, index: ModuleIndex) {
  if (index.services.length === 0) return null;
  const self = layout.path('application', module, 'services');
  const writer = new CodeWriter();

  for (const service of index.services) {
    const portFields = new Map(service.uses.map((name) => [name, camelCase(name)]));
    const emitter = new TypeScriptEmitter(index, portFields);

    docComment(writer, service.description ?? `Application service ${service.name}.`);
    const implementsClause = service.implements ? ` implements ${pascalCase(service.implements)}` : '';
    writer.line(`export class ${pascalCase(service.name)}${implementsClause} {`);
    writer.block(() => {
      writer.line('constructor(');
      writer.block(() => {
        for (const name of service.uses) writer.line(`private readonly ${camelCase(name)}: ${pascalCase(name)},`);
        writer.line('private readonly eventPublisher: EventPublisher,');
      });
      writer.line(') {}');

      for (const operation of service.operations) {
        writer.blank();
        emitOperation(writer, emitter, operation, { async: true });
      }
    });
    writer.line('}');
    writer.blank();
  }
  return assemble(
    self,
    module,
    index,
    { enums: true, valueObjects: true, model: true, messages: true, errors: true, ports: true, eventPublisher: true },
    writer,
  );
}

// ---------------------------------------------------------------------------
// Infrastructure layer
// ---------------------------------------------------------------------------

function adaptersFile(module: IRModule, index: ModuleIndex) {
  if (index.adapters.length === 0) return null;
  const self = layout.path('infrastructure', module, 'adapters');
  const writer = new CodeWriter();
  const emitter = new TypeScriptEmitter(index);
  for (const adapter of index.adapters) {
    const port = index.typed(adapter.implements, 'port');
    if (!port) continue;

    docComment(writer, adapter.description ?? `${adapter.technology} adapter for ${port.name}.`);
    writer.line(`export class ${pascalCase(adapter.name)} implements ${pascalCase(port.name)} {`);
    writer.block(() => {
      if (adapter.technology === 'sql') {
        writer.line(`private readonly table = '${adapter.config['table'] ?? tableName(guessEntity(port.name))}';`);
        writer.blank();
        writer.line('constructor(private readonly db: SqlClient) {}');
      } else if (adapter.technology === 'in-memory') {
        writer.line(`private readonly rows = new Map<string, unknown>();`);
      }

      for (const operation of port.operations) {
        writer.blank();
        signatureDoc(writer, operation);
        const parameters = parameterObject(operation, emitter);
        writer.line(`async ${camelCase(operation.phrase)}(${parameters}): Promise<${emitter.typeName(operation.returns)}> {`);
        writer.block(() => {
          // An operation the adapter wrote for itself wins over anything this
          // backend would have generated for the phrase.
          const declared = declaredImplementation(adapter, operation.phrase);
          if (declared) emitter.emitImplementation(writer, declared);
          else emitAdapterBody(writer, adapter.technology, operation, emitter, index);
        });
        writer.line('}');
      }
    });
    writer.line('}');
    writer.blank();
  }

  emitQueryMatchers(writer, index);

  return assemble(
    self,
    module,
    index,
    { enums: true, valueObjects: true, model: true, messages: true, errors: true, ports: true, sqlClient: true },
    writer,
  );
}

/** Recognised repository phrases get real SQL; anything else is left to the author. */
function emitAdapterBody(
  writer: CodeWriter,
  technology: string,
  operation: IROperationSignature,
  emitter: TypeScriptEmitter,
  index: ModuleIndex,
): void {
  const phrase = operation.phrase.toLowerCase();
  const returnType = emitter.typeName(operation.returns);
  const errorName = operation.throws[0];

  // A phrase whose parameter is a query compiles that query into the WHERE clause.
  const queryParameter = operation.parameters.find((p) => p.type.kind === 'named' && index.typed(p.type.name, 'query'));
  if (queryParameter && (technology === 'sql' || technology === 'in-memory')) {
    const query = index.typed((queryParameter.type as { name: string }).name, 'query')!;
    emitQueryBody(writer, technology, query, camelCase(queryParameter.name), returnType, index);
    return;
  }

  if (technology === 'sql') {
    if (/^(find|get|read|load)\b.*\bby id$/.test(phrase)) {
      writer.line('const result = await this.db.query<Record<string, unknown>>(');
      writer.block(() => writer.line('`SELECT * FROM ${this.table} WHERE id = $1`, [id],'));
      writer.line(');');
      writer.line('const row = result.rows[0];');
      if (errorName) {
        writer.line(`if (!row) throw new ${pascalCase(errorName)}({ ${firstErrorField(index, errorName)}: id });`);
      } else {
        writer.line('if (!row) return null;');
      }
      writer.line(`return new ${stripOptional(returnType)}(row as never);`);
      return;
    }
    if (/^(save|store|persist|upsert)\b/.test(phrase)) {
      const parameter = operation.parameters[0]?.name ?? 'entity';
      writer.line('await this.db.query(');
      writer.block(() => {
        writer.line('`INSERT INTO ${this.table} (data, id) VALUES ($1, $2)');
        writer.line('  ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,');
        writer.line(`[JSON.stringify(${camelCase(parameter)}), ${identityAccess(index, operation, camelCase(parameter))}],`);
      });
      writer.line(');');
      return;
    }
    if (/^(list|find all|search)\b/.test(phrase)) {
      const filter = operation.parameters[0];
      const column = filter ? `${kebabCase(filter.name).replace(/-/g, '_')}` : null;
      writer.line('const result = await this.db.query<Record<string, unknown>>(');
      writer.block(() =>
        column
          ? writer.line(`\`SELECT * FROM \${this.table} WHERE ${column} = $1\`, [${camelCase(filter!.name)}],`)
          : writer.line('`SELECT * FROM ${this.table}`,'),
      );
      writer.line(');');
      writer.line(`return result.rows.map((row) => new ${elementClass(returnType)}(row as never));`);
      return;
    }
    if (/^(delete|remove)\b/.test(phrase)) {
      writer.line('await this.db.query(`DELETE FROM ${this.table} WHERE id = $1`, [id]);');
      return;
    }
  }

  if (technology === 'in-memory') {
    if (/^(find|get|read|load)\b.*\bby id$/.test(phrase)) {
      writer.line('const row = this.rows.get(String(id));');
      if (errorName) writer.line(`if (!row) throw new ${pascalCase(errorName)}({ ${firstErrorField(index, errorName)}: id });`);
      else writer.line('if (!row) return null;');
      writer.line(`return row as ${stripOptional(returnType)};`);
      return;
    }
    if (/^(save|store|persist|upsert)\b/.test(phrase)) {
      const parameter = camelCase(operation.parameters[0]?.name ?? 'entity');
      writer.line(`this.rows.set(String(${identityAccess(index, operation, parameter)}), ${parameter});`);
      return;
    }
    if (/^(list|find all|search)\b/.test(phrase)) {
      writer.line(`return [...this.rows.values()] as ${returnType};`);
      return;
    }
    if (/^(delete|remove)\b/.test(phrase)) {
      writer.line('this.rows.delete(String(id));');
      return;
    }
  }

  writer.line(
    `throw new Error('${operation.phrase} has no generated implementation for a ${technology} adapter; write it here.');`,
  );
}

/**
 * How to read the key off the value being saved.
 *
 * `identified by symbol` is a real thing to write, so a repository cannot assume
 * the identity is called `id` — it used to, and the generated adapter then read
 * a field the aggregate never declared.
 */
function identityAccess(index: ModuleIndex, operation: IROperationSignature, parameter: string): string {
  const type = operation.parameters[0]?.type;
  const named = type && type.kind === 'named' ? index.get(type.name) : undefined;
  const identity = named && 'identity' in named ? named.identity[0] : undefined;
  return `${parameter}.${camelCase(identity ?? 'id')}`;
}

/**
 * A declared query becomes a WHERE clause built at call time: a criterion that
 * reads an absent optional is simply not appended, which is how one query covers
 * what would otherwise be one repository method per combination of filters.
 */
function emitQueryBody(
  writer: CodeWriter,
  technology: 'sql' | 'in-memory',
  query: IRQueryDecl,
  parameter: string,
  returnType: string,
  index: ModuleIndex,
): void {
  const compiled = compileQuery(query, camelCase(query.over));
  const element = elementClass(returnType);

  for (const unsupported of compiled.unsupported) {
    writer.line(`// ${unsupported} in ${query.name} has no SQL form; filter it in memory after loading.`);
  }

  if (technology === 'in-memory') {
    writer.line(`return [...this.rows.values()].filter((row) => ${matcherName(query)}(row as ${element}, ${parameter})) as ${returnType};`);
    return;
  }

  writer.line("const clauses: string[] = ['1 = 1'];");
  writer.line('const values: unknown[] = [];');
  for (const fragment of compiled.fragments) {
    const emit = (): void => {
      // `values.length` is read before the pushes, so a skipped fragment never
      // leaves a gap in the placeholder numbering.
      writer.line(`clauses.push(\`${placeholders(fragment.sql)}\`);`);
      for (const binding of fragment.bindings) writer.line(`values.push(${parameter}.${camelCase(binding)});`);
    };
    if (fragment.guards.length === 0) {
      emit();
      continue;
    }
    writer.line(`if (${fragment.guards.map((name) => `${parameter}.${camelCase(name)} !== null`).join(' && ')}) {`);
    writer.block(emit);
    writer.line('}');
  }

  const tail = [compiled.orderBy ? ` ORDER BY ${compiled.orderBy}` : '', compiled.limit ? ` LIMIT ${compiled.limit}` : ''].join('');
  writer.line(`const sql = \`SELECT * FROM \${this.table} WHERE \${clauses.join(' AND ')}${tail}\`;`);
  writer.line('const result = await this.db.query<Record<string, unknown>>(sql, values);');
  writer.line(`return result.rows.map((row) => new ${element}(row as never));`);
}

/** `a = ? AND b > ?` becomes `a = ${values.length + 1} AND b > ${values.length + 2}`. */
function placeholders(sql: string): string {
  let position = 0;
  return sql.replace(/\?/g, () => `$\${values.length + ${++position}}`);
}

function matcherName(query: IRQueryDecl): string {
  return `matches${pascalCase(query.name)}`;
}

/** Optional fields of the aggregate that a criterion compares against. */
function nullableFieldsRead(condition: IRExpression, subject: string, fields: readonly IRField[]): string[] {
  const found = new Set<string>();
  const visit = (expression: IRExpression): void => {
    switch (expression.kind) {
      case 'reference':
        if (expression.path[0] === subject && expression.path.length === 2) {
          const field = fields.find((f) => f.name === expression.path[1]);
          if (field && !field.required) found.add(field.name);
        }
        break;
      case 'binary':
        visit(expression.left);
        visit(expression.right);
        break;
      case 'unary':
        // A presence test is exactly what a null guard would duplicate.
        if (expression.operator !== 'is-present' && expression.operator !== 'is-absent') visit(expression.operand);
        break;
      default:
        break;
    }
  };
  visit(condition);
  return [...found];
}

/** The in-memory predicate for each query, rendered from the same criteria. */
function emitQueryMatchers(writer: CodeWriter, index: ModuleIndex): void {
  const queries = index.queries.filter((query) =>
    index.adapters.some(
      (adapter) =>
        adapter.technology === 'in-memory' &&
        index
          .typed(adapter.implements, 'port')
          ?.operations.some((o) => o.parameters.some((p) => p.type.kind === 'named' && p.type.name === query.name)),
    ),
  );

  for (const query of queries) {
    const subject = camelCase(query.over);
    const emitter = new TypeScriptEmitter(index);
    writer.blank();
    writer.line(`/** In-memory form of the criteria declared by query ${query.name}. */`);
    // Exported because a compiled scenario stands up its own double, and a
    // double answering a query differently from the adapter would be testing
    // something the project does not ship.
    writer.line(`export function ${matcherName(query)}(${subject}: ${pascalCase(query.over)}, query: ${pascalCase(query.name)}): boolean {`);
    writer.block(() => {
      const aggregate = index.typed(query.over, 'aggregate');
      for (const criterion of query.criteria) {
        // Bare names in a criterion are the query's own fields.
        const condition = emitter.expression(prefixReferences(criterion.condition, 'query', new Set([subject])));

        // SQL treats a comparison against NULL as false, so a nullable operand
        // on either side has to be present before the criterion can hold.
        const guards = [
          ...criterion.guards
            .filter((name) => query.fields.some((f) => f.name === name && !f.required))
            .map((name) => `query.${camelCase(name)} !== null`),
          ...nullableFieldsRead(criterion.condition, subject, aggregate?.fields ?? []).map(
            (name) => `${subject}.${camelCase(name)} !== null`,
          ),
        ];
        const prefix = guards.length > 0 ? `${guards.join(' && ')} && ` : '';
        writer.line(`if (${prefix}!(${condition})) return false;`);
      }
      writer.line('return true;');
    });
    writer.line('}');
  }
}

// ---------------------------------------------------------------------------
// Interface layer
// ---------------------------------------------------------------------------

function routesFile(module: IRModule, index: ModuleIndex) {
  if (index.endpoints.length === 0) return null;
  const self = layout.path('interface', module, 'routes');
  const writer = new CodeWriter();

  const services = [...new Set(index.endpoints.map((e) => e.handler.service))];
  writer.line(`export interface ${pascalCase(module.name)}Dependencies {`);
  writer.block(() => {
    for (const name of services) writer.line(`${camelCase(name)}: ${pascalCase(name)};`);
  });
  writer.line('}');
  writer.blank();

  writer.line(`export function create${pascalCase(module.name)}Router(dependencies: ${pascalCase(module.name)}Dependencies): Router {`);
  writer.block(() => {
    writer.line('const router = Router();');
    for (const endpoint of index.endpoints) {
      writer.blank();
      const method = endpoint.method.toLowerCase();
      const path = endpoint.path.replace(/\{([^}]+)\}/g, ':$1');
      const success = endpoint.responses.find((r) => r.status < 400);
      writer.line(`// ${endpoint.method} ${endpoint.path}${endpoint.auth !== 'none' ? ` (${endpoint.auth})` : ''}`);
      writer.line(`router.${method}('${path}', async (request: Request, response: Response, next: NextFunction) => {`);
      writer.block(() => {
        writer.line('try {');
        writer.block(() => {
          const service = index.typed(endpoint.handler.service, 'service');
          const operation = service?.operations.find((o) => camelCase(o.phrase) === camelCase(endpoint.handler.operation));
          const requestType = endpoint.request ? pascalCase(typeName(endpoint.request)) : null;
          writer.line('const input = { ...request.body, ...request.params };');

          // A single parameter typed as the request carries the whole payload;
          // anything else is read field by field off the merged input.
          const parameters = operation?.parameters ?? [];
          const wholePayload = parameters.length === 1 && requestType !== null && parameters[0]!.type.kind === 'named';
          const args = wholePayload
            ? `{ ${camelCase(parameters[0]!.name)}: input as ${requestType} }`
            : `{ ${parameters.map((p) => `${camelCase(p.name)}: input.${camelCase(p.name)}`).join(', ')} }`;
          const call = `dependencies.${camelCase(endpoint.handler.service)}.${camelCase(endpoint.handler.operation)}(${parameters.length > 0 ? args : ''})`;
          if (success?.body) {
            writer.line(`const result = await ${call};`);
            writer.line(`response.status(${success.status}).json(result);`);
          } else {
            writer.line(`await ${call};`);
            writer.line(`response.status(${success?.status ?? 204}).end();`);
          }
        });
        writer.line('} catch (error) {');
        writer.block(() => writer.line('next(error);'));
        writer.line('}');
      });
      writer.line('});');
    }
    writer.blank();
    writer.line('return router;');
  });
  writer.line('}');
  return assemble(self, module, index, { messages: true, services: true }, writer, [
    "import { Router, type Request, type Response, type NextFunction } from 'express';",
  ]);
}

function handlersFile(module: IRModule, index: ModuleIndex) {
  if (index.handlers.length === 0) return null;
  const self = layout.path('interface', module, 'handlers');
  const writer = new CodeWriter();

  for (const handler of index.handlers) {
    const portFields = new Map(handler.uses.map((name) => [name, camelCase(name)]));
    const emitter = new TypeScriptEmitter(index, portFields);
    const payload = index.get(handler.on);

    docComment(
      writer,
      handler.description ??
        `Reacts to ${handler.on}. Delivery: ${handler.delivery}, up to ${handler.retries} retries.`,
    );
    writer.line(`export class ${pascalCase(handler.name)} {`);
    writer.block(() => {
      writer.line(`static readonly trigger = '${handler.on}';`);
      writer.line(`static readonly retries = ${handler.retries};`);
      writer.blank();
      writer.line('constructor(');
      writer.block(() => {
        for (const name of handler.uses) writer.line(`private readonly ${camelCase(name)}: ${pascalCase(name)},`);
        writer.line('private readonly eventPublisher: EventPublisher,');
      });
      writer.line(') {}');
      writer.blank();
      const eventType = payload && 'fields' in payload ? pascalCase(payload.name) : 'unknown';
      writer.line(`async handle(event: ${eventType}): Promise<void> {`);
      writer.block(() => emitter.emitBlock(writer, handler.body));
      writer.line('}');
    });
    writer.line('}');
    writer.blank();
  }
  return assemble(
    self,
    module,
    index,
    { enums: true, valueObjects: true, model: true, messages: true, errors: true, ports: true, eventPublisher: true },
    writer,
  );
}

// ---------------------------------------------------------------------------
// Project-level files
// ---------------------------------------------------------------------------

/**
 * The scenarios, as tests that run against the generated code.
 *
 * `haic test` executes these against the IR, where a fenced block cannot run —
 * so for an operation written in TypeScript, this file is the only place the
 * scenario is actually executed. Same `given`, same call, same expectations,
 * lowered by the same emitter as everything else.
 */
function scenarioTestsFile(module: IRModule, index: ModuleIndex) {
  const { compiled, skipped } = scenarioPlans(index);
  // No file at all when there is nothing to run: an empty test file reports
  // itself as a passing test, and a green count that ran nothing is a lie.
  if (compiled.length === 0) return null;

  const writer = new CodeWriter();
  emitTestDoubles(writer, index, compiled);

  for (const plan of compiled) {
    // A service operation is async, so its test is too. An aggregate's is not,
    // and making it async anyway would hide a forgotten await behind a pass.
    const asynchronous = plan.kind === 'service';
    const emitter = new TypeScriptEmitter(index);

    docComment(writer, plan.scenario.description);
    writer.line(`test(${quote(plan.title)}, ${asynchronous ? 'async ' : ''}() => {`);
    writer.block(() => {
      emitScenarioBody(writer, emitter, plan, testHooks(asynchronous));
      if (plan.kind === 'service') emitPublishedChecks(writer, plan);
    });
    writer.line('});');
    writer.blank();
  }
  for (const line of skippedComments(skipped)) writer.line(line);

  const imports = compiled.length > 0 ? ["import { test } from 'node:test';", "import assert from 'node:assert/strict';"] : [];
  return assemble(
    layout.path('domain', module, 'scenarios').replace(/\.ts$/, '.test.ts'),
    module,
    index,
    {
      enums: true,
      valueObjects: true,
      model: true,
      messages: true,
      errors: true,
      ports: true,
      services: true,
      adapters: true,
      validation: true,
      eventPublisher: true,
    },
    writer,
    imports,
  );
}

function testHooks(asynchronous: boolean): TestHooks {
  return {
    local: (name, value) => `const ${name} = ${value};`,
    discard: (value) => `${value};`,
    assertTrue: (condition, message) => [`assert.ok(${condition}, ${quote(message)});`],
    assertRaises: (call, error) =>
      asynchronous
        ? [`await assert.rejects(async () => ${call}, ${pascalCase(error)});`]
        : [`assert.throws(() => ${call}, ${pascalCase(error)});`],
    setUp: (plan) => (plan.kind === 'service' ? serviceSetUp(plan) : []),
    call: (plan, emitter) => (plan.kind === 'service' ? serviceCall(plan, emitter) : emitter.expression(plan.call)),
  };
}

/** `await matchingService.submitOrder({ command })`, spelled out. */
function serviceCall(plan: ServicePlan, emitter: { expression(value: IRExpression): string }): string {
  const args = plan.call.kind === 'call' ? plan.call.arguments : [];
  const rendered = args.map((argument) => `${camelCase(argument.name)}: ${emitter.expression(argument.value)}`);
  const payload = rendered.length > 0 ? `{ ${rendered.join(', ')} }` : '';
  return `await ${camelCase(plan.service.name)}.${camelCase(plan.operation.phrase)}(${payload})`;
}

/** The doubles, stood up and seeded, before the operation under test runs. */
function serviceSetUp(plan: ServicePlan): string[] {
  const lines: string[] = [];
  for (const port of plan.ports) lines.push(`const ${camelCase(port.name)} = new Fake${pascalCase(port.name)}();`);
  for (const seed of plan.seeds) {
    const parameter = camelCase(seed.save.parameters[0]?.name ?? 'entity');
    lines.push(`await ${camelCase(seed.port.name)}.${camelCase(seed.save.phrase)}({ ${parameter}: ${camelCase(seed.binding)} });`);
  }
  lines.push('const eventPublisher = new RecordingEventPublisher();');
  const args = [...plan.ports.map((port) => camelCase(port.name)), 'eventPublisher'];
  lines.push(`const ${camelCase(plan.service.name)} = new ${pascalCase(plan.service.name)}(${args.join(', ')});`);
  return lines;
}

/** `then it publishes X`, against the publisher the test handed the service. */
function emitPublishedChecks(writer: CodeWriter, plan: ServicePlan): void {
  for (const expectation of plan.expectations) {
    if (expectation.kind !== 'publishes') continue;
    writer.line(
      `assert.ok(eventPublisher.published.includes(${quote(pascalCase(expectation.event))}), ${quote(`it publishes ${expectation.event}`)});`,
    );
  }
}

/**
 * One in-memory double per port the compiled scenarios need, plus a publisher
 * that remembers rather than prints.
 *
 * The doubles are emitted by the same function that writes the real in-memory
 * adapter, so a test cannot pass against behaviour the adapter does not have.
 */
function emitTestDoubles(writer: CodeWriter, index: ModuleIndex, compiled: readonly ScenarioPlan[]): void {
  const ports = new Map<string, IRPortDecl>();
  let publisher = false;
  for (const plan of compiled) {
    if (plan.kind !== 'service') continue;
    publisher = true;
    for (const port of plan.ports) ports.set(port.name, port);
  }
  if (ports.size === 0 && !publisher) return;

  const emitter = new TypeScriptEmitter(index);
  for (const port of ports.values()) {
    writer.line(`/** Stands in for ${port.name}, with the in-memory adapter's behaviour. */`);
    writer.line(`class Fake${pascalCase(port.name)} implements ${pascalCase(port.name)} {`);
    writer.block(() => {
      writer.line('private readonly rows = new Map<string, unknown>();');
      for (const operation of port.operations) {
        writer.blank();
        writer.line(`async ${camelCase(operation.phrase)}(${parameterObject(operation, emitter)}): Promise<${emitter.typeName(operation.returns)}> {`);
        writer.block(() => emitAdapterBody(writer, 'in-memory', operation, emitter, index));
        writer.line('}');
      }
    });
    writer.line('}');
    writer.blank();
  }

  if (publisher) {
    writer.line('/** Records what the service published, so a `then` can look. */');
    writer.line('class RecordingEventPublisher implements EventPublisher {');
    writer.block(() => {
      writer.line('readonly published: string[] = [];');
      writer.blank();
      writer.line('async publish(topic: string): Promise<void> {');
      writer.block(() => writer.line('this.published.push(topic);'));
      writer.line('}');
    });
    writer.line('}');
    writer.blank();
  }
}

function quote(text: string): string {
  return JSON.stringify(text);
}

function packageJson(context: GenerationContext) {
  const name = kebabCase(context.project.name);
  return file(
    'package.json',
    `${JSON.stringify(
      {
        name,
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: {
          build: 'tsc',
          typecheck: 'tsc --noEmit',
          // The scenarios, compiled. Node runs them; nothing was installed for it.
          test: 'tsc && node --test "dist/**/*.test.js"',
          start: 'node dist/main.js',
          dev: 'tsc && node dist/main.js',
        },
        dependencies: { express: '^4.21.2' },
        devDependencies: { '@types/express': '^5.0.0', '@types/node': '^22.10.2', typescript: '^5.7.2' },
      },
      null,
      2,
    )}\n`,
  );
}

function tsconfig() {
  return file(
    'tsconfig.json',
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          outDir: 'dist',
          rootDir: 'src',
          skipLibCheck: true,
          verbatimModuleSyntax: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
  );
}

function sharedErrors() {
  const writer = banner();
  writer.lines_(
    comment(
      'Two error families, mirroring HADL. A CheckedError is part of a contract and every caller is expected to handle it. An UncheckedError signals a defect: catching it to keep going only hides the bug.',
      ' * ',
    ).map((l, i, all) => (i === 0 ? `/**\n${l}` : i === all.length - 1 ? `${l}\n */` : l)),
  );
  writer.line('export abstract class DomainError extends Error {');
  writer.block(() => {
    writer.line('protected constructor(');
    writer.block(() => {
      writer.line('readonly code: string,');
      writer.line('readonly status: number,');
      writer.line('message: string,');
    });
    writer.line(') {');
    writer.block(() => {
      writer.line('super(message);');
      writer.line('this.name = new.target.name;');
    });
    writer.line('}');
  });
  writer.line('}');
  writer.blank();
  writer.line('export abstract class CheckedError extends DomainError {}');
  writer.line('export abstract class UncheckedError extends DomainError {}');
  writer.blank();
  writer.line('/** Express error middleware that turns domain errors into responses. */');
  writer.line('export function domainErrorHandler(');
  writer.block(() => {
    writer.line('error: unknown,');
    writer.line('_request: unknown,');
    writer.line('response: { status(code: number): { json(body: unknown): void } },');
    writer.line('next: (error?: unknown) => void,');
  });
  writer.line('): void {');
  writer.block(() => {
    writer.line('if (error instanceof DomainError) {');
    writer.block(() => writer.line('response.status(error.status).json({ code: error.code, message: error.message });'));
    writer.line('  return;');
    writer.line('}');
    writer.line('next(error);');
  });
  writer.line('}');
  return file(layout.sharedPath('errors'), writer.toString());
}

/**
 * Constraint and invariant failures are unchecked: they mean the caller sent
 * something the model forbids. They travel through the same handler as every
 * other domain error, so a bad request gets a JSON 422 rather than a stack trace.
 */
function sharedValidation() {
  const writer = banner();
  writer.line(`import { UncheckedError } from '${relativeImport(layout.sharedPath('validation'), layout.sharedPath('errors'), false)}.js';`);
  writer.blank();
  writer.line('/** Raised when a declared field constraint does not hold. */');
  writer.line('export class ConstraintViolation extends UncheckedError {');
  writer.block(() => {
    writer.line('constructor(readonly shape: string, readonly field: string, readonly rule: string) {');
    writer.block(() =>
      writer.line("super('CONSTRAINT_VIOLATION', 422, `${shape}.${field} violates ${rule}`);"),
    );
    writer.line('}');
  });
  writer.line('}');
  writer.blank();
  writer.line('/** Raised when a declared invariant does not hold. */');
  writer.line('export class InvariantViolation extends UncheckedError {');
  writer.block(() => {
    writer.line('constructor(readonly shape: string, readonly rule: string) {');
    writer.block(() => writer.line("super('INVARIANT_VIOLATION', 422, `${shape}: ${rule}`);"));
    writer.line('}');
  });
  writer.line('}');
  return file(layout.sharedPath('validation'), writer.toString());
}

function sharedEventPublisher() {
  const writer = banner();
  writer.line('/** Outbound port for domain events. The IaC layer wires a broker to it. */');
  writer.line('export interface EventPublisher {');
  writer.block(() => writer.line('publish(topic: string, payload: unknown): Promise<void>;'));
  writer.line('}');
  writer.blank();
  writer.line('/** Development implementation: prints instead of publishing. */');
  writer.line('export class ConsoleEventPublisher implements EventPublisher {');
  writer.block(() => {
    writer.line('async publish(topic: string, payload: unknown): Promise<void> {');
    writer.block(() => writer.line('console.log(JSON.stringify({ topic, payload }));'));
    writer.line('}');
  });
  writer.line('}');
  return file(layout.sharedPath('event-publisher'), writer.toString());
}

/**
 * One contract for every SQL adapter in the project.
 *
 * It used to be emitted into each module's adapters file, which is fine until a
 * second module needs SQL: the composition root then imports two `SqlClient`
 * types and TypeScript rejects the duplicate.
 */
function sharedSqlClient() {
  const writer = banner();
  writer.line('/** The minimum a SQL driver must offer. `pg.Pool` satisfies it as-is. */');
  writer.line('export interface SqlClient {');
  writer.block(() => writer.line('query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;'));
  writer.line('}');
  return file(layout.sharedPath('sql-client'), writer.toString());
}

/**
 * The composition root, wired for real.
 *
 * Every adapter the source declares is constructed here and injected into the
 * services that named its port. An in-memory adapter needs nothing, so a
 * project built only from those starts and serves on the first run; a SQL one
 * needs a client, and the generated code says so at the line that needs it.
 */
function mainFile(context: GenerationContext) {
  const writer = banner();
  const port = context.project.modules.find((m) => m.infrastructure)?.infrastructure?.port ?? 8080;
  const serving = context.project.modules.filter((m) => indexModule(m).endpoints.length > 0);
  const needsSql = context.project.modules.some((m) => indexModule(m).adapters.some((a) => a.technology === 'sql'));

  writer.line("import express from 'express';");
  writer.line("import { domainErrorHandler } from './shared/errors.js';");
  writer.line("import { ConsoleEventPublisher } from './shared/event-publisher.js';");
  if (needsSql) writer.line("import type { SqlClient } from './shared/sql-client.js';");
  for (const module of context.project.modules) {
    const index = indexModule(module);
    const directory = kebabCase(module.name);
    if (index.adapters.length > 0) {
      const names = index.adapters.map((a) => pascalCase(a.name));
      writer.line(`import { ${names.join(', ')} } from './infrastructure/${directory}/adapters.js';`);
    }
    if (index.services.length > 0) {
      writer.line(`import { ${index.services.map((s) => pascalCase(s.name)).join(', ')} } from './application/${directory}/services.js';`);
    }
    if (index.endpoints.length > 0) {
      writer.line(`import { create${pascalCase(module.name)}Router } from './interface/${directory}/routes.js';`);
    }
  }
  writer.blank();

  if (needsSql) {
    writer.line('// Supply a driver here. `pg.Pool` satisfies SqlClient as-is.');
    writer.line('const db: SqlClient = {');
    writer.block(() => {
      writer.line('async query() {');
      writer.block(() => writer.line("throw new Error('no SQL client configured: pass a pg.Pool here');"));
      writer.line('},');
    });
    writer.line('};');
    writer.blank();
  }

  writer.line('const eventPublisher = new ConsoleEventPublisher();');
  writer.blank();

  for (const module of context.project.modules) {
    const index = indexModule(module);
    if (index.adapters.length === 0 && index.services.length === 0) continue;

    for (const adapter of index.adapters) {
      const argument = adapter.technology === 'sql' ? 'db' : '';
      writer.line(`const ${camelCase(adapter.name)} = new ${pascalCase(adapter.name)}(${argument});`);
    }
    for (const service of index.services) {
      // Each port a service uses is satisfied by the adapter that implements it.
      const dependencies = service.uses.map((portName) => {
        const adapter = index.adapters.find((a) => a.implements === portName);
        return adapter ? camelCase(adapter.name) : `/* no adapter implements ${portName} */ undefined as never`;
      });
      writer.line(`const ${camelCase(service.name)} = new ${pascalCase(service.name)}(${[...dependencies, 'eventPublisher'].join(', ')});`);
    }
    writer.blank();
  }

  writer.line('const app = express();');
  writer.line('app.use(express.json());');
  writer.blank();
  for (const module of serving) {
    const services = [...new Set(indexModule(module).endpoints.map((e) => e.handler.service))];
    const wiring = services.map((name) => camelCase(name)).join(', ');
    writer.line(`app.use(create${pascalCase(module.name)}Router({ ${wiring} }));`);
  }
  writer.blank();
  writer.line('app.use(domainErrorHandler);');
  writer.blank();
  writer.line(`const port = Number(process.env['PORT'] ?? ${port});`);
  writer.line('app.listen(port, () => console.log(`listening on http://localhost:${port}`));');
  return file(layout.entryPoint('main'), writer.toString());
}

function readme(context: GenerationContext) {
  const lines = [
    `# ${context.project.name}`,
    '',
    'Generated from HADL sources. Edit the `.hadl` files and recompile; everything here is overwritten.',
    '',
    '## Layout',
    '',
    '| Directory | Depends on | Holds |',
    '| --- | --- | --- |',
    '| `src/domain` | nothing | aggregates, entities, value objects, events, errors |',
    '| `src/application` | domain | ports and services |',
    '| `src/infrastructure` | application | adapters that implement outbound ports |',
    '| `src/interface` | application | HTTP routes and message handlers |',
    '',
    '## Bounded contexts',
    '',
    ...context.project.contexts.map((c) => `- **${c.name}** (${c.kind}): ${c.modules.join(', ')}`),
    '',
    '## Running',
    '',
    '```bash',
    'npm install',
    'npm run typecheck',
    'npm run dev',
    '```',
    '',
  ];
  return file('README.md', `${lines.join('\n')}\n`);
}

function dotEnvExample(context: GenerationContext) {
  const lines = ['# Generated from the infrastructure blocks of the .hadl sources.'];
  for (const module of context.project.modules) {
    const infrastructure = module.infrastructure;
    if (!infrastructure) continue;
    lines.push('', `# ${module.name}`);
    lines.push(`PORT=${infrastructure.port}`);
    for (const [key, value] of Object.entries(infrastructure.environment)) lines.push(`${key}=${value}`);
    for (const secret of infrastructure.secrets) lines.push(`${secret}=`);
    for (const database of infrastructure.databases) {
      lines.push(`${screamingSnakeCase(database.name)}_URL=${database.engine}://localhost/${database.name}`);
    }
  }
  return file('.env.example', `${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

function emitOperation(writer: CodeWriter, emitter: TypeScriptEmitter, operation: IROperation, options: { async: boolean }): void {
  signatureDoc(writer, operation);
  const returns = emitter.typeName(operation.returns);
  const prefix = options.async ? 'async ' : '';
  const wrapped = options.async ? `Promise<${returns}>` : returns;
  writer.line(`${prefix}${camelCase(operation.phrase)}(${parameterObject(operation, emitter)}): ${wrapped} {`);
  writer.block(() => emitter.emitImplementation(writer, operation));
  writer.line('}');
}

/** Destructured so a body written against bare parameter names compiles as-is. */
function parameterObject(operation: IROperationSignature, emitter: TypeScriptEmitter): string {
  if (operation.parameters.length === 0) return '';
  const names = operation.parameters.map((p) => camelCase(p.name)).join(", ");
  const fields = operation.parameters
    .map((p) => `${camelCase(p.name)}${p.required ? '' : '?'}: ${emitter.typeName(p.type)}`)
    .join('; ');
  return `{ ${names} }: { ${fields} }`;
}

function writeInputType(writer: CodeWriter, name: string, fields: readonly IRField[], emitter: TypeScriptEmitter): void {
  writer.line(`export interface ${pascalCase(name)}Input {`);
  writer.block(() => {
    for (const field of fields) {
      const optional = !field.required || field.derived || field.constraints.some((c) => c.kind === 'default');
      const rendered = field.derived ? `${emitter.typeName(field.type)} | null` : emitter.typeName(field.type);
      writer.line(`${camelCase(field.name)}${optional ? '?' : ''}: ${rendered};`);
    }
  });
  writer.line('}');
  writer.blank();
}

function defaultedInput(field: IRField, emitter: TypeScriptEmitter): string {
  const name = camelCase(field.name);
  const fallback = field.constraints.find((c) => c.kind === 'default');
  if (fallback && fallback.kind === 'default') return `input.${name} ?? ${emitter.literal(fallback.value, field.type)}`;
  if (field.type.kind === 'list') return `input.${name} ?? []`;
  if (!field.required || field.derived) return `input.${name} ?? null`;
  return `input.${name}`;
}

function emitConstraintChecks(writer: CodeWriter, shape: string, fields: readonly IRField[], emitter: TypeScriptEmitter): void {
  for (const field of fields) {
    const name = camelCase(field.name);
    for (const constraint of field.constraints) {
      switch (constraint.kind) {
        case 'min':
          writer.line(`if (this.${name} < ${constraint.value}) throw new ConstraintViolation('${shape}', '${name}', 'min ${constraint.value}');`);
          break;
        case 'max':
          writer.line(`if (this.${name} > ${constraint.value}) throw new ConstraintViolation('${shape}', '${name}', 'max ${constraint.value}');`);
          break;
        case 'min-length':
          writer.line(`if (this.${name}.length < ${constraint.value}) throw new ConstraintViolation('${shape}', '${name}', 'min length ${constraint.value}');`);
          break;
        case 'max-length':
          writer.line(`if (this.${name}.length > ${constraint.value}) throw new ConstraintViolation('${shape}', '${name}', 'max length ${constraint.value}');`);
          break;
        case 'length':
          writer.line(`if (this.${name}.length !== ${constraint.value}) throw new ConstraintViolation('${shape}', '${name}', 'length ${constraint.value}');`);
          break;
        case 'pattern':
          writer.line(`if (!/${constraint.value}/.test(this.${name})) throw new ConstraintViolation('${shape}', '${name}', 'pattern');`);
          break;
        default:
          break;
      }
    }
    const defaulted = field.constraints.some((c) => c.kind === 'default');
    if (field.required && !field.derived && !defaulted && field.type.kind !== 'optional' && field.type.kind !== 'list') {
      writer.line(`if (this.${name} === undefined || this.${name} === null) throw new ConstraintViolation('${shape}', '${name}', 'required');`);
    }
  }
  void emitter;
}

function emitInvariantChecks(
  writer: CodeWriter,
  invariants: ReadonlyArray<{ description: string; condition: Parameters<TypeScriptEmitter['expression']>[0] }>,
  emitter: TypeScriptEmitter,
): void {
  for (const invariant of invariants) {
    const condition = emitter.expression(invariant.condition);
    writer.line(`if (!(${condition})) throw new InvariantViolation(this.constructor.name, ${JSON.stringify(invariant.description)});`);
  }
}

/** Invariants are written against bare field names; inside a class they are `this.x`. */
function prefixThis<T extends Parameters<TypeScriptEmitter['expression']>[0]>(expression: T): T {
  switch (expression.kind) {
    case 'reference':
      return expression.path.length === 1 && /^[a-z]/.test(expression.path[0]!)
        ? ({ ...expression, path: ['this', ...expression.path] } as T)
        : expression;
    case 'binary':
      return { ...expression, left: prefixThis(expression.left), right: prefixThis(expression.right) } as T;
    case 'unary':
      return { ...expression, operand: prefixThis(expression.operand) } as T;
    case 'aggregate':
      return {
        ...expression,
        collection: prefixThis(expression.collection),
        of: expression.of ? prefixThis(expression.of) : null,
      } as T;
    case 'call':
    case 'construct':
      return { ...expression, arguments: expression.arguments.map((a) => ({ ...a, value: prefixThis(a.value) })) } as T;
    default:
      return expression;
  }
}

function errorDetailsType(fields: readonly IRField[], emitter: TypeScriptEmitter): string {
  if (fields.length === 0) return 'Record<string, never>';
  return `{ ${fields.map((f) => `${camelCase(f.name)}${f.required ? '' : '?'}: ${emitter.typeName(f.type)}`).join('; ')} }`;
}

/** `"no order exists with id {orderId}"` becomes a template literal over `details`. */
function messageTemplate(message: string, fields: readonly IRField[]): string {
  const known = new Set(fields.map((f) => f.name));
  const body = message.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) =>
    known.has(name) ? `\${String(details.${camelCase(name)})}` : match,
  );
  return `\`${body.replace(/`/g, '\\`')}\``;
}

function firstErrorField(index: ModuleIndex, errorName: string): string {
  const declaration = index.typed(errorName, 'error');
  return camelCase(declaration?.fields[0]?.name ?? 'id');
}

function operationsOf(declaration: IRDeclaration): IROperation[] {
  return declaration.kind === 'aggregate' ? declaration.operations : [];
}

function typeName(type: IRType): string {
  return type.kind === 'named' ? type.name : typeToString(type);
}

function stripOptional(rendered: string): string {
  return rendered.replace(/ \| null$/, '');
}

function elementClass(rendered: string): string {
  return rendered.replace(/\[\]$/, '');
}

function guessEntity(portName: string): string {
  return portName.replace(/(Repository|Store|Gateway|Adapter)$/, '');
}

interface ImportFlags {
  enums?: boolean;
  valueObjects?: boolean;
  model?: boolean;
  messages?: boolean;
  errors?: boolean;
  ports?: boolean;
  services?: boolean;
  adapters?: boolean;
  validation?: boolean;
  eventPublisher?: boolean;
  sqlClient?: boolean;
}

/**
 * Emits only the imports the body actually mentions, split into value and type
 * imports because `verbatimModuleSyntax` rejects a type imported as a value.
 */
function renderImports(self: string, module: IRModule, index: ModuleIndex, flags: ImportFlags, body: string): string {
  const lines: string[] = [];
  const uses = (name: string): boolean => new RegExp(`\\b${name}\\b`).test(body);

  const add = (values: string[], types: string[], target: string): void => {
    if (target === self) return; // A file never imports its own declarations.
    const specifier = `${relativeImport(self, target, false)}.js`;
    const usedValues = values.filter((name) => uses(name));
    const usedTypes = types.filter((name) => uses(name));
    if (usedValues.length > 0) lines.push(`import { ${usedValues.join(', ')} } from '${specifier}';`);
    if (usedTypes.length > 0) lines.push(`import type { ${usedTypes.join(', ')} } from '${specifier}';`);
  };

  if (flags.enums) add(index.enums.map((d) => pascalCase(d.name)), [], layout.path('domain', module, 'enums'));
  if (flags.valueObjects) {
    add(
      index.valueObjects.map((d) => pascalCase(d.name)),
      index.valueObjects.map((d) => `${pascalCase(d.name)}Input`),
      layout.path('domain', module, 'value-objects'),
    );
  }
  if (flags.model) {
    const shapes = [...index.entities, ...index.aggregates];
    add(
      shapes.map((d) => pascalCase(d.name)),
      shapes.map((d) => `${pascalCase(d.name)}Input`),
      layout.path('domain', module, 'model'),
    );
  }
  if (flags.messages) {
    add([], [...index.commands, ...index.events, ...index.dtos, ...index.queries].map((d) => pascalCase(d.name)), layout.path('domain', module, 'messages'));
  }
  if (flags.errors) add(index.errors.map((d) => pascalCase(d.name)), [], layout.path('domain', module, 'errors'));
  if (flags.ports) add([], index.ports.map((d) => pascalCase(d.name)), layout.path('application', module, 'ports'));
  if (flags.services) add(index.services.map((d) => pascalCase(d.name)), [], layout.path('application', module, 'services'));
  // A double answers a query by calling the same matcher the adapter calls.
  if (flags.adapters) add(index.queries.map((query) => matcherName(query)), [], layout.path('infrastructure', module, 'adapters'));
  if (flags.validation) add(['ConstraintViolation', 'InvariantViolation'], [], layout.sharedPath('validation'));
  if (flags.eventPublisher) add([], ['EventPublisher'], layout.sharedPath('event-publisher'));
  if (flags.sqlClient) add([], ['SqlClient'], layout.sharedPath('sql-client'));

  // `new id` lowers to randomUUID, which needs the standard library.
  if (uses('randomUUID')) lines.unshift("import { randomUUID } from 'node:crypto';");

  return lines.length > 0 ? `${lines.join('\n')}\n\n` : '';
}

/** Banner + the imports the body needs + the body. */
function assemble(
  self: string,
  module: IRModule,
  index: ModuleIndex,
  flags: ImportFlags,
  body: CodeWriter,
  extraImports: string[] = [],
): GeneratedFile {
  const text = body.toString();
  const head = extraImports.length > 0 ? `${extraImports.join('\n')}\n` : '';
  return file(self, `// ${GENERATED_BANNER}\n\n${head}${renderImports(self, module, index, flags, text)}${text}`);
}

function banner(): CodeWriter {
  const writer = new CodeWriter();
  writer.line(`// ${GENERATED_BANNER}`);
  writer.blank();
  return writer;
}

function docComment(writer: CodeWriter, text: string | undefined): void {
  if (!text) return;
  writer.line('/**');
  for (const line of comment(text, ' * ')) writer.line(line);
  writer.line(' */');
}

function fieldDoc(writer: CodeWriter, field: IRField): void {
  const parts: string[] = [];
  if (field.description) parts.push(field.description);
  if (field.derived) parts.push('Derived: recomputed rather than stored.');
  if (parts.length > 0) writer.line(`/** ${parts.join(' ')} */`);
}

function signatureDoc(writer: CodeWriter, operation: IROperationSignature): void {
  const lines: string[] = [];
  if (operation.description) lines.push(operation.description);
  lines.push(`Declared in HADL as "${operation.phrase}".`);
  for (const name of operation.throws) lines.push(`@throws ${pascalCase(name)}`);
  writer.line('/**');
  for (const line of lines) writer.line(` * ${line}`);
  writer.line(' */');
}

export function generateForModule(module: IRModule, context: GenerationContext): GenerationResult {
  return typescriptGenerator.generate(module, context);
}

export type { IRAggregateDecl, IREntityDecl };
