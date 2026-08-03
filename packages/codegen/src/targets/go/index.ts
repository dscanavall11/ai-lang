/**
 * Go / chi backend.
 *
 * Emits a hexagonal project: domain structs that validate themselves, ports as
 * interfaces, services that depend on them, adapters that implement them, and a
 * chi surface that maps checked errors to status codes. Errors are Go-native:
 * every port and service operation returns `(T, error)`.
 */
import {
  CodeWriter,
  GENERATED_BANNER,
  NOTHING,
  camelCase,
  comment,
  file,
  indexModule,
  kebabCase,
  named,
  normalisePhrase,
  screamingSnakeCase,
  snakeCase,
  tableName,
  typeToString,
  unwrap,
  type CodeGenerator,
  type GenerationContext,
  type IRAggregateDecl,
  type IREndpointDecl,
  type IREntityDecl,
  type IRErrorDecl,
  type IRField,
  type IRInvariant,
  type IRModule,
  type IROperation,
  type IROperationSignature,
  type IRPortDecl,
  type IRType,
  type IRValueObjectDecl,
  type ModuleIndex,
} from '@haic/core';
import { ProjectLayout } from '../../shared/layout.js';
import { GoEmitter, goExported, goPackage, goString, goUnexported } from './emitter.js';

const layout = new ProjectLayout({ sourceRoot: 'internal', extension: '.go', directoryCase: goPackage });

export const goGenerator: CodeGenerator = {
  id: 'go',
  displayName: 'Go',
  framework: 'Chi',
  verifyCommand: ['go', 'build', './...'],

  generate(module, context) {
    const index = indexModule(module);
    const files = [
      enumsFile(module, index),
      valuesFile(module, index, context),
      modelFile(module, index, context),
      errorsFile(module, index),
      messagesFile(module, index),
      portsFile(module, index, context),
      servicesFile(module, index, context),
      adaptersFile(module, index, context),
      routesFile(module, index, context),
      handlersFile(module, index, context),
    ].filter((f): f is NonNullable<typeof f> => f !== null);

    return { files, diagnostics: [] };
  },

  generateProject(context) {
    return {
      files: [goMod(context), mainFile(context), sharedErrors(), sharedEvents(), sharedValidation(), sharedNumbers(), readme(context), dotEnvExample(context)],
      diagnostics: [],
    };
  },
};

// ---------------------------------------------------------------------------
// Domain layer
// ---------------------------------------------------------------------------

function enumsFile(module: IRModule, index: ModuleIndex) {
  if (index.enums.length === 0) return null;
  const writer = goWriter();

  for (const declaration of index.enums) {
    doc(writer, goExported(declaration.name), 'is a closed set of values, carried as text on the wire.', declaration.description);
    writer.line(`type ${goExported(declaration.name)} string`);
    writer.blank();
    writer.line('const (');
    writer.block(() =>
      writer.lines_(
        aligned(
          declaration.values.map((value) => [
            `${goExported(declaration.name)}${goExported(value.name)}`,
            goExported(declaration.name),
            `= ${goString(value.name)}`,
            value.description ? `// ${value.description}` : '',
          ]),
        ),
      ),
    );
    writer.line(')');
    writer.blank();
  }
  return file(layout.path('domain', module, 'enums'), goSource(goPackage(module.name), [], writer.toString()));
}

function valuesFile(module: IRModule, index: ModuleIndex, context: GenerationContext) {
  if (index.valueObjects.length === 0) return null;
  const writer = goWriter();

  for (const declaration of index.valueObjects) {
    doc(writer, goExported(declaration.name), 'is a value object: two of them are equal when every field is.', declaration.description);
    writeStruct(writer, declaration, new GoEmitter(index));
    writer.blank();
    // Value objects are immutable, so their methods take a value receiver.
    writeValidate(writer, declaration, index, false);
    writer.blank();
  }
  return file(layout.path('domain', module, 'values'), goSource(goPackage(module.name), domainImports(context), writer.toString()));
}

function modelFile(module: IRModule, index: ModuleIndex, context: GenerationContext) {
  const shapes: Array<IREntityDecl | IRAggregateDecl> = [...index.entities, ...index.aggregates];
  if (shapes.length === 0) return null;
  const writer = goWriter();

  for (const declaration of shapes) {
    const summary =
      declaration.kind === 'aggregate'
        ? `is the aggregate root of its consistency boundary, identified by ${declaration.identity.join(', ')}.`
        : `is an entity identified by ${declaration.identity.join(', ')}${declaration.aggregate ? `, owned by ${declaration.aggregate}` : ''}.`;
    doc(writer, goExported(declaration.name), summary, declaration.description);
    writeStruct(writer, declaration, new GoEmitter(index));
    writer.blank();
    writeValidate(writer, declaration, index, true);

    if (declaration.kind === 'aggregate') {
      const emitter = new GoEmitter(index, { receiver: receiverOf(declaration.name), receiverFields: declaration.fields });
      for (const operation of declaration.operations) {
        writer.blank();
        writeOperation(writer, emitter, operation, {
          receiver: `(${receiverOf(declaration.name)} *${goExported(declaration.name)})`,
          contextual: false,
        });
      }
    }
    writer.blank();
  }
  return file(layout.path('domain', module, 'model'), goSource(goPackage(module.name), domainImports(context), writer.toString()));
}

function errorsFile(module: IRModule, index: ModuleIndex) {
  if (index.errors.length === 0) return null;
  const writer = goWriter();
  const emitter = new GoEmitter(index);

  for (const declaration of index.errors) {
    const name = goExported(declaration.name);
    writer.line(`// Err${name} is the sentinel every ${name} wraps, so errors.Is keeps working.`);
    writer.line(`var Err${name} = errors.New(${goString(screamingSnakeCase(declaration.name))})`);
    writer.blank();

    const summary = declaration.checked
      ? 'is a checked error: part of the operation contract, callers are expected to handle it.'
      : 'is an unchecked error: it signals a defect and is raised as a panic.';
    doc(writer, name, summary, declaration.description);
    writeStruct(writer, declaration, emitter);
    writer.blank();

    const message = messageFormat(declaration.message, declaration.fields);
    writer.line(`func (e *${name}) Error() string {`);
    writer.block(() =>
      writer.line(message.args.length === 0 ? `return ${goString(message.format)}` : `return fmt.Sprintf(${goString(message.format)}, ${message.args.join(', ')})`),
    );
    writer.line('}');
    writer.blank();
    writer.line(`func (e *${name}) Unwrap() error { return Err${name} }`);
    writer.blank();
    writer.line('// Status is the HTTP status this error carries when it escapes through an endpoint.');
    writer.line(`func (e *${name}) Status() int { return ${declaration.status ?? (declaration.checked ? 400 : 500)} }`);
    writer.blank();
  }
  return file(layout.path('domain', module, 'errors'), goSource(goPackage(module.name), [STD.errors, STD.fmt, STD.time], writer.toString()));
}

function messagesFile(module: IRModule, index: ModuleIndex) {
  const shapes = [...index.commands, ...index.events, ...index.dtos, ...index.queries];
  if (shapes.length === 0) return null;
  const writer = goWriter();
  const emitter = new GoEmitter(index);

  for (const declaration of shapes) {
    const summary =
      declaration.kind === 'command'
        ? `is a command handled by ${declaration.target ?? 'the application layer'}.`
        : declaration.kind === 'event'
          ? `is an event emitted by ${declaration.source ?? 'the domain'}.`
          : declaration.kind === 'query'
            ? `selects ${declaration.over} records matching its fields.`
            : `is a data transfer object${declaration.projects ? ` projecting ${declaration.projects}` : ''}.`;
    doc(writer, goExported(declaration.name), summary, declaration.description);
    writeStruct(writer, declaration, emitter);
    writer.blank();
    if (declaration.kind === 'event') {
      writer.line(`// ${goExported(declaration.name)}Topic is the broker topic ${declaration.name} travels on.`);
      writer.line(`const ${goExported(declaration.name)}Topic = ${goString(declaration.topic ?? kebabCase(declaration.name))}`);
      writer.blank();
    }
  }
  return file(layout.path('domain', module, 'messages'), goSource(goPackage(module.name), [STD.time], writer.toString()));
}

// ---------------------------------------------------------------------------
// Application layer
// ---------------------------------------------------------------------------

function portsFile(module: IRModule, index: ModuleIndex, context: GenerationContext) {
  if (index.ports.length === 0) return null;
  const writer = goWriter();
  const emitter = new GoEmitter(index, { domainPrefix: 'domain.' });

  for (const port of index.ports) {
    const summary =
      port.direction === 'inbound'
        ? 'is an inbound port: a use case the outside world can drive.'
        : 'is an outbound port: something the domain drives, implemented by an adapter.';
    doc(writer, goExported(port.name), summary, port.description);
    writer.line(`type ${goExported(port.name)} interface {`);
    writer.block(() => {
      port.operations.forEach((operation, position) => {
        if (position > 0) writer.blank();
        signatureDoc(writer, operation);
        writer.line(`${goExported(operation.phrase)}(${parameterList(operation, emitter, true)}) ${resultList(operation.returns, emitter, true)}`);
      });
    });
    writer.line('}');
    writer.blank();
  }
  return file(layout.path('application', module, 'ports'), goSource(goPackage(module.name), applicationImports(context, module), writer.toString()));
}

function servicesFile(module: IRModule, index: ModuleIndex, context: GenerationContext) {
  if (index.services.length === 0) return null;
  const writer = goWriter();

  for (const service of index.services) {
    const name = goExported(service.name);
    const fields = service.uses.map((port) => ({ port, field: goUnexported(port) }));
    const emitter = new GoEmitter(index, {
      domainPrefix: 'domain.',
      portFields: new Map(fields.map((f) => [f.port, f.field])),
      receiver: 's',
    });

    doc(writer, name, 'is an application service: it orchestrates ports and publishes what happened.', service.description);
    writer.line(`type ${name} struct {`);
    writer.block(() => writer.lines_(aligned([...fields.map((f) => [f.field, goExported(f.port)]), ['events', 'shared.EventPublisher']])));
    writer.line('}');
    writer.blank();

    const parameters = [...fields.map((f) => `${f.field} ${goExported(f.port)}`), 'events shared.EventPublisher'];
    writer.line(`// New${name} wires ${name} to the ports it depends on.`);
    writer.line(`func New${name}(${parameters.join(', ')}) *${name} {`);
    writer.block(() => writer.line(`return &${name}{${[...fields.map((f) => `${f.field}: ${f.field}`), 'events: events'].join(', ')}}`));
    writer.line('}');

    if (service.implements) {
      writer.blank();
      writer.line(`var _ ${goExported(service.implements)} = (*${name})(nil)`);
    }

    for (const operation of service.operations) {
      writer.blank();
      writeOperation(writer, emitter, operation, { receiver: `(s *${name})`, contextual: true });
    }
    writer.blank();
  }
  return file(layout.path('application', module, 'services'), goSource(goPackage(module.name), applicationImports(context, module), writer.toString()));
}

// ---------------------------------------------------------------------------
// Infrastructure layer
// ---------------------------------------------------------------------------

function adaptersFile(module: IRModule, index: ModuleIndex, context: GenerationContext) {
  if (index.adapters.length === 0) return null;
  const writer = goWriter();
  const emitter = new GoEmitter(index, { domainPrefix: 'domain.' });

  for (const adapter of index.adapters) {
    const port = index.typed(adapter.implements, 'port');
    if (!port) continue;
    const name = goExported(adapter.name);
    const stored = storedShape(port, index);
    const key = stored ? emitter.typeName(identityField(stored).type) : 'string';
    const row = stored ? `domain.${goExported(stored.name)}` : 'any';

    const state =
      adapter.technology === 'sql'
        ? [['db', '*sql.DB'], ['table', 'string']]
        : adapter.technology === 'in-memory'
          ? [['mu', 'sync.RWMutex'], ['rows', `map[${key}]${row}`]]
          : [];

    doc(writer, name, `is the ${adapter.technology} adapter for ${port.name}.`, adapter.description);
    if (state.length === 0) {
      writer.line(`type ${name} struct{}`);
    } else {
      writer.line(`type ${name} struct {`);
      writer.block(() => writer.lines_(aligned(state)));
      writer.line('}');
    }
    writer.blank();

    writer.line(`// New${name} builds the adapter. Its dependencies come from the composition root.`);
    if (adapter.technology === 'sql') {
      const table = String(adapter.config['table'] ?? tableName(stored?.name ?? port.name));
      writer.line(`func New${name}(db *sql.DB) *${name} {`);
      writer.block(() => writer.line(`return &${name}{db: db, table: ${goString(table)}}`));
    } else if (adapter.technology === 'in-memory') {
      writer.line(`func New${name}() *${name} {`);
      writer.block(() => writer.line(`return &${name}{rows: map[${key}]${row}{}}`));
    } else {
      writer.line(`func New${name}() *${name} {`);
      writer.block(() => writer.line(`return &${name}{}`));
    }
    writer.line('}');
    writer.blank();
    writer.line(`var _ application.${goExported(port.name)} = (*${name})(nil)`);

    for (const operation of port.operations) {
      writer.blank();
      signatureDoc(writer, operation);
      writer.line(`func (a *${name}) ${goExported(operation.phrase)}(${parameterList(operation, emitter, true)}) ${resultList(operation.returns, emitter, true)} {`);
      writer.block(() => adapterBody(writer, adapter.technology, operation, emitter, index, stored));
      writer.line('}');
    }
    writer.blank();
  }
  return file(layout.path('infrastructure', module, 'adapters'), goSource(goPackage(module.name), infrastructureImports(context, module), writer.toString()));
}

/** Recognised repository phrases get real code; anything else is left to the author. */
function adapterBody(
  writer: CodeWriter,
  technology: string,
  operation: IROperationSignature,
  emitter: GoEmitter,
  index: ModuleIndex,
  stored: IREntityDecl | IRAggregateDecl | null,
): void {
  const phrase = normalisePhrase(operation.phrase);
  const zero = emitter.zeroValue(operation.returns);
  const fail = (expression: string): string => (zero === '' ? `return ${expression}` : `return ${zero}, ${expression}`);
  const ok = (expression: string): string => (zero === '' ? 'return nil' : `return ${expression}, nil`);
  const row = emitter.typeName(unwrap(operation.returns));
  const element = row.replace(/^\[\]/, '');
  const first = operation.parameters[0];
  const argument = first ? goUnexported(first.name) : 'id';
  const identity = stored ? goExported(identityField(stored).name) : 'ID';
  const missing = notFound(index, operation, argument);

  if (technology === 'sql') {
    if (/^(find|get|read|load)\b.*\bby id$/.test(phrase)) {
      writer.line('var payload []byte');
      writer.line(`query := fmt.Sprintf("SELECT data FROM %s WHERE id = $1", a.table)`);
      writer.line(`if err := a.db.QueryRowContext(ctx, query, ${argument}).Scan(&payload); err != nil {`);
      writer.block(() => {
        writer.line('if errors.Is(err, sql.ErrNoRows) {');
        writer.block(() => writer.line(fail(missing)));
        writer.line('}');
        writer.line(fail('err'));
      });
      writer.line('}');
      writer.line(`var record ${row}`);
      writer.line('if err := json.Unmarshal(payload, &record); err != nil {');
      writer.block(() => writer.line(fail('err')));
      writer.line('}');
      writer.line(ok('record'));
      return;
    }
    if (/^(save|store|persist|upsert)\b/.test(phrase)) {
      writer.line(`payload, err := json.Marshal(${argument})`);
      writer.line('if err != nil {');
      writer.block(() => writer.line(fail('err')));
      writer.line('}');
      writer.line(`query := fmt.Sprintf("INSERT INTO %s (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data", a.table)`);
      writer.line(`if _, err := a.db.ExecContext(ctx, query, ${argument}.${identity}, payload); err != nil {`);
      writer.block(() => writer.line(fail('err')));
      writer.line('}');
      writer.line(ok('nil'));
      return;
    }
    if (/^(list|find all|search)\b/.test(phrase)) {
      const column = first ? snakeCase(first.name) : null;
      writer.line(column ? `query := fmt.Sprintf("SELECT data FROM %s WHERE ${column} = $1", a.table)` : `query := fmt.Sprintf("SELECT data FROM %s", a.table)`);
      writer.line(`rows, err := a.db.QueryContext(ctx, query${column ? `, ${argument}` : ''})`);
      writer.line('if err != nil {');
      writer.block(() => writer.line(fail('err')));
      writer.line('}');
      writer.line('defer rows.Close()');
      writer.line(`records := make(${row}, 0)`);
      writer.line('for rows.Next() {');
      writer.block(() => {
        writer.line('var payload []byte');
        writer.line('if err := rows.Scan(&payload); err != nil {');
        writer.block(() => writer.line(fail('err')));
        writer.line('}');
        writer.line(`var record ${element}`);
        writer.line('if err := json.Unmarshal(payload, &record); err != nil {');
        writer.block(() => writer.line(fail('err')));
        writer.line('}');
        writer.line('records = append(records, record)');
      });
      writer.line('}');
      writer.line('if err := rows.Err(); err != nil {');
      writer.block(() => writer.line(fail('err')));
      writer.line('}');
      writer.line(ok('records'));
      return;
    }
    if (/^(delete|remove)\b/.test(phrase)) {
      writer.line(`query := fmt.Sprintf("DELETE FROM %s WHERE id = $1", a.table)`);
      writer.line(`if _, err := a.db.ExecContext(ctx, query, ${argument}); err != nil {`);
      writer.block(() => writer.line(fail('err')));
      writer.line('}');
      writer.line(ok('nil'));
      return;
    }
  }

  if (technology === 'in-memory') {
    if (/^(find|get|read|load)\b.*\bby id$/.test(phrase)) {
      writer.line('a.mu.RLock()');
      writer.line('defer a.mu.RUnlock()');
      writer.line(`record, found := a.rows[${argument}]`);
      writer.line('if !found {');
      writer.block(() => writer.line(fail(missing)));
      writer.line('}');
      writer.line(ok('record'));
      return;
    }
    if (/^(save|store|persist|upsert)\b/.test(phrase)) {
      writer.line('a.mu.Lock()');
      writer.line('defer a.mu.Unlock()');
      writer.line(`a.rows[${argument}.${identity}] = ${argument}`);
      writer.line(ok('nil'));
      return;
    }
    if (/^(list|find all|search)\b/.test(phrase)) {
      writer.line('a.mu.RLock()');
      writer.line('defer a.mu.RUnlock()');
      writer.line(`records := make(${row}, 0, len(a.rows))`);
      writer.line('for _, record := range a.rows {');
      writer.block(() => writer.line('records = append(records, record)'));
      writer.line('}');
      writer.line(ok('records'));
      return;
    }
    if (/^(delete|remove)\b/.test(phrase)) {
      writer.line('a.mu.Lock()');
      writer.line('defer a.mu.Unlock()');
      writer.line(`delete(a.rows, ${argument})`);
      writer.line(ok('nil'));
      return;
    }
  }

  writer.line(fail(`fmt.Errorf(${goString(`${operation.phrase} has no generated implementation; write it here`)})`));
}

// ---------------------------------------------------------------------------
// Interfaces layer
// ---------------------------------------------------------------------------

function routesFile(module: IRModule, index: ModuleIndex, context: GenerationContext) {
  if (index.endpoints.length === 0) return null;
  const writer = goWriter();
  const emitter = new GoEmitter(index, { domainPrefix: 'domain.' });
  const services = [...new Set(index.endpoints.map((e) => e.handler.service))];
  const names = handlerNames(index.endpoints);

  writer.line(`// Dependencies carries the services the ${module.name} endpoints delegate to.`);
  writer.line('type Dependencies struct {');
  writer.block(() => writer.lines_(aligned(services.map((service) => [goExported(service), `*application.${goExported(service)}`]))));
  writer.line('}');
  writer.blank();

  writer.line(`// Routes builds a chi router carrying every ${module.name} endpoint.`);
  writer.line('func Routes(deps Dependencies) chi.Router {');
  writer.block(() => {
    writer.line('router := chi.NewRouter()');
    for (const endpoint of index.endpoints) {
      writer.line(`router.${chiMethod(endpoint.method)}(${goString(endpoint.path)}, ${names.get(endpoint.name)}(deps))`);
    }
    writer.line('return router');
  });
  writer.line('}');

  for (const endpoint of index.endpoints) {
    writer.blank();
    writeHandlerFunc(writer, endpoint, names.get(endpoint.name)!, index, emitter);
  }

  if (index.endpoints.some((e) => e.request)) {
    writer.blank();
    writer.line('// decodeBody reads a JSON body, tolerating an empty one so path-only requests work.');
    writer.line('func decodeBody(r *http.Request, into any) error {');
    writer.block(() => {
      writer.line('if r.Body == nil {');
      writer.block(() => writer.line('return nil'));
      writer.line('}');
      writer.line('if err := json.NewDecoder(r.Body).Decode(into); err != nil && !errors.Is(err, io.EOF) {');
      writer.block(() => writer.line('return err'));
      writer.line('}');
      writer.line('return nil');
    });
    writer.line('}');
  }
  return file(interfacePath(module, 'routes'), goSource(goPackage(module.name), interfaceImports(context, module), writer.toString()));
}

function writeHandlerFunc(writer: CodeWriter, endpoint: IREndpointDecl, name: string, index: ModuleIndex, emitter: GoEmitter): void {
  const service = index.typed(endpoint.handler.service, 'service');
  const operation = service?.operations.find((o) => normalisePhrase(o.phrase) === normalisePhrase(endpoint.handler.operation));
  const success = endpoint.responses.find((r) => r.status < 400) ?? { status: 200 };
  const parameters = operation?.parameters ?? [];
  const pathParams = [...endpoint.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  const request = endpoint.request?.kind === 'named' ? index.get(endpoint.request.name) : undefined;
  const requestFields = request && 'fields' in request ? request.fields : [];

  writer.line(`// ${name} handles ${endpoint.method} ${endpoint.path}${endpoint.auth === 'none' ? '' : ` (${endpoint.auth} auth)`}.`);
  writer.line(`func ${name}(deps Dependencies) http.HandlerFunc {`);
  writer.block(() => {
    writer.line('return func(w http.ResponseWriter, r *http.Request) {');
    writer.block(() => {
      if (endpoint.request) {
        writer.line(`var request ${emitter.typeName(endpoint.request)}`);
        writer.line('if err := decodeBody(r, &request); err != nil {');
        writer.block(() => {
          writer.line('shared.WriteError(w, http.StatusBadRequest, err)');
          writer.line('return');
        });
        writer.line('}');
        // Path values are authoritative: they identify the resource being addressed.
        for (const param of pathParams) {
          const field = requestFields.find((f) => camelCase(f.name) === camelCase(param));
          if (field) writer.line(`request.${goExported(field.name)} = ${pathValue(field.type, param)}`);
        }
      }

      const args = parameters.map((parameter) => {
        if (endpoint.request?.kind === 'named' && parameter.type.kind === 'named' && parameter.type.name === endpoint.request.name) return 'request';
        const param = pathParams.find((p) => camelCase(p) === camelCase(parameter.name));
        return param ? pathValue(parameter.type, param) : emitter.zeroValue(parameter.type);
      });
      const call = `deps.${goExported(endpoint.handler.service)}.${goExported(endpoint.handler.operation)}(${['r.Context()', ...args].join(', ')})`;
      const yields = operation !== undefined && emitter.typeName(operation.returns) !== '';

      writer.line(yields ? `result, err := ${call}` : `err := ${call}`);
      writer.line('if err != nil {');
      writer.block(() => {
        for (const response of endpoint.responses) {
          if (!response.when) continue;
          const variable = goUnexported(response.when);
          writer.line(`var ${variable} *domain.${goExported(response.when)}`);
          writer.line(`if errors.As(err, &${variable}) {`);
          writer.block(() => {
            writer.line(`shared.WriteError(w, ${httpStatus(response.status)}, ${variable})`);
            writer.line('return');
          });
          writer.line('}');
        }
        writer.line('shared.WriteError(w, http.StatusInternalServerError, err)');
        writer.line('return');
      });
      writer.line('}');
      writer.line(yields ? `shared.WriteJSON(w, ${httpStatus(success.status)}, result)` : `w.WriteHeader(${httpStatus(success.status)})`);
    });
    writer.line('}');
  });
  writer.line('}');
}

function handlersFile(module: IRModule, index: ModuleIndex, context: GenerationContext) {
  if (index.handlers.length === 0) return null;
  const writer = goWriter();

  for (const handler of index.handlers) {
    const name = goExported(handler.name);
    const fields = handler.uses.map((port) => ({ port, field: goUnexported(port) }));
    const emitter = new GoEmitter(index, {
      domainPrefix: 'domain.',
      portFields: new Map(fields.map((f) => [f.port, f.field])),
      receiver: 'h',
    });
    const payload = index.get(handler.on);
    const event = payload && 'fields' in payload ? `domain.${goExported(payload.name)}` : 'any';

    doc(writer, name, `reacts to ${handler.on}. Delivery is ${handler.delivery}, with up to ${handler.retries} retries.`, handler.description);
    writer.line(`type ${name} struct {`);
    writer.block(() => writer.lines_(aligned([...fields.map((f) => [f.field, `application.${goExported(f.port)}`]), ['events', 'shared.EventPublisher']])));
    writer.line('}');
    writer.blank();

    const parameters = [...fields.map((f) => `${f.field} application.${goExported(f.port)}`), 'events shared.EventPublisher'];
    writer.line(`// New${name} wires ${name} to the ports it depends on.`);
    writer.line(`func New${name}(${parameters.join(', ')}) *${name} {`);
    writer.block(() => writer.line(`return &${name}{${[...fields.map((f) => `${f.field}: ${f.field}`), 'events: events'].join(', ')}}`));
    writer.line('}');
    writer.blank();

    writer.line(`func (h *${name}) Handle(ctx context.Context, event ${event}) error {`);
    writer.block(() => {
      emitter.enterOperation(NOTHING, true, [{ name: 'event', type: named(handler.on), required: true }]);
      emitter.emitBlock(writer, handler.body);
      if (!endsWithReturn(handler.body)) writer.line('return nil');
    });
    writer.line('}');
    writer.blank();
  }
  return file(interfacePath(module, 'handlers'), goSource(goPackage(module.name), interfaceImports(context, module), writer.toString()));
}

// ---------------------------------------------------------------------------
// Project-level files
// ---------------------------------------------------------------------------

function goMod(context: GenerationContext) {
  const lines = [
    `module ${goModulePath(context)}`,
    '',
    'go 1.23',
    '',
    'require (',
    '\tgithub.com/go-chi/chi/v5 v5.1.0',
    '\tgithub.com/google/uuid v1.6.0',
    ')',
  ];
  return file('go.mod', `${lines.join('\n')}\n`);
}

function mainFile(context: GenerationContext) {
  const writer = goWriter();
  const port = context.project.modules.find((m) => m.infrastructure)?.infrastructure?.port ?? 8080;
  const routed = context.project.modules.filter((m) => indexModule(m).endpoints.length > 0);

  writer.line('func main() {');
  writer.block(() => {
    writer.line('router := chi.NewRouter()');
    writer.line('router.Use(middleware.RequestID, middleware.RealIP, middleware.Recoverer)');
    writer.blank();
    writer.line('router.Get("/health", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })');
    writer.blank();
    writer.line('// Build the adapters and services here, then mount each module router:');
    for (const module of routed) {
      const pkg = `${goPackage(module.name)}api`;
      const services = [...new Set(indexModule(module).endpoints.map((e) => e.handler.service))];
      writer.line(`// router.Mount("/", ${pkg}.Routes(${pkg}.Dependencies{${services.map((s) => `${goExported(s)}: ...`).join(', ')}}))`);
      writer.line(`//   import ${pkg} "${goModulePath(context)}/internal/interfaces/${goPackage(module.name)}"`);
    }
    writer.blank();
    writer.line(`address := ":" + envOr("PORT", "${port}")`);
    writer.line('server := &http.Server{Addr: address, Handler: router, ReadHeaderTimeout: 5 * time.Second}');
    writer.line('log.Printf("listening on %s", address)');
    writer.line('if err := server.ListenAndServe(); err != nil {');
    writer.block(() => writer.line('log.Fatal(err)'));
    writer.line('}');
  });
  writer.line('}');
  writer.blank();
  writer.line('func envOr(name string, fallback string) string {');
  writer.block(() => {
    writer.line('if value := os.Getenv(name); value != "" {');
    writer.block(() => writer.line('return value'));
    writer.line('}');
    writer.line('return fallback');
  });
  writer.line('}');
  return file('cmd/server/main.go', goSource('main', [STD.log, STD.http, STD.os, STD.time, EXTERNAL.chi, EXTERNAL.middleware], writer.toString()));
}

function sharedErrors() {
  const writer = goWriter();
  writer.lines_(comment('Two error families mirror HADL. A checked error is part of a contract and every caller is expected to handle it; an unchecked one signals a defect and is raised as a panic.', '// '));
  writer.line('type StatusCarrier interface {');
  writer.block(() => writer.line('Status() int'));
  writer.line('}');
  writer.blank();
  writer.line('// StatusOf reports the HTTP status an error declares, defaulting to 500.');
  writer.line('func StatusOf(err error) int {');
  writer.block(() => {
    writer.line('var carrier StatusCarrier');
    writer.line('if errors.As(err, &carrier) {');
    writer.block(() => writer.line('return carrier.Status()'));
    writer.line('}');
    writer.line('return http.StatusInternalServerError');
  });
  writer.line('}');
  writer.blank();
  writer.line('// WriteError writes err as a JSON problem body with the given status.');
  writer.line('func WriteError(w http.ResponseWriter, status int, err error) {');
  writer.block(() => writer.line('WriteJSON(w, status, map[string]string{"error": err.Error()})'));
  writer.line('}');
  writer.blank();
  writer.line('// WriteJSON writes body as JSON with the given status.');
  writer.line('func WriteJSON(w http.ResponseWriter, status int, body any) {');
  writer.block(() => {
    writer.line('w.Header().Set("Content-Type", "application/json")');
    writer.line('w.WriteHeader(status)');
    writer.line('if body == nil {');
    writer.block(() => writer.line('return'));
    writer.line('}');
    writer.line('if err := json.NewEncoder(w).Encode(body); err != nil {');
    writer.block(() => writer.line('log.Printf("write response: %v", err)'));
    writer.line('}');
  });
  writer.line('}');
  return file(layout.sharedPath('errors'), goSource('shared', [STD.errors, STD.json, STD.log, STD.http], writer.toString()));
}

function sharedEvents() {
  const writer = goWriter();
  writer.line('// EventPublisher is the outbound port for domain events; the IaC layer wires a broker to it.');
  writer.line('type EventPublisher interface {');
  writer.block(() => writer.line('Publish(ctx context.Context, topic string, payload any) error'));
  writer.line('}');
  writer.blank();
  writer.line('// LogEventPublisher is the development implementation: it prints instead of publishing.');
  writer.line('type LogEventPublisher struct{}');
  writer.blank();
  writer.line('func (LogEventPublisher) Publish(ctx context.Context, topic string, payload any) error {');
  writer.block(() => {
    writer.line('encoded, err := json.Marshal(payload)');
    writer.line('if err != nil {');
    writer.block(() => writer.line('return err'));
    writer.line('}');
    writer.line('log.Printf("event %s %s", topic, encoded)');
    writer.line('return nil');
  });
  writer.line('}');
  return file(layout.sharedPath('events'), goSource('shared', [STD.context, STD.json, STD.log], writer.toString()));
}

function sharedValidation() {
  const writer = goWriter();
  writer.line('// ConstraintViolation reports a declared field constraint that does not hold.');
  writer.line('type ConstraintViolation struct {');
  writer.block(() => writer.lines_(aligned([['Shape', 'string'], ['Field', 'string'], ['Rule', 'string']])));
  writer.line('}');
  writer.blank();
  writer.line('func (e *ConstraintViolation) Error() string {');
  writer.block(() => writer.line('return fmt.Sprintf("%s.%s violates %s", e.Shape, e.Field, e.Rule)'));
  writer.line('}');
  writer.blank();
  writer.line('func (e *ConstraintViolation) Status() int { return http.StatusUnprocessableEntity }');
  writer.blank();
  writer.line('// InvariantViolation reports a declared invariant that does not hold.');
  writer.line('type InvariantViolation struct {');
  writer.block(() => writer.lines_(aligned([['Shape', 'string'], ['Rule', 'string']])));
  writer.line('}');
  writer.blank();
  writer.line('func (e *InvariantViolation) Error() string {');
  writer.block(() => writer.line('return fmt.Sprintf("%s: %s", e.Shape, e.Rule)'));
  writer.line('}');
  writer.blank();
  writer.line('func (e *InvariantViolation) Status() int { return http.StatusUnprocessableEntity }');
  return file(layout.sharedPath('validation'), goSource('shared', [STD.fmt, STD.http], writer.toString()));
}

function sharedNumbers() {
  const writer = goWriter();
  // time.Time has no relational operators and Go has no Comparable interface, so
  // ordering dispatches on the dynamic type. The analyzer has already proved both
  // sides are ordered and of the same type, so the default branch is unreachable.
  writer.line('// Ordering across every type HADL considers ordered.');
  for (const [name, operator] of [['Gt', '>'], ['Ge', '>='], ['Lt', '<'], ['Le', '<=']] as const) {
    writer.line(`func ${name}(left any, right any) bool { return compareOrdered(left, right) ${operator} 0 }`);
  }
  writer.blank();
  writer.line('func compareOrdered(left any, right any) int {');
  writer.block(() => {
    writer.line('switch value := left.(type) {');
    writer.line('case time.Time:');
    writer.block(() => writer.line('return value.Compare(right.(time.Time))'));
    writer.line('case time.Duration:');
    writer.block(() => writer.line('return int(value - right.(time.Duration))'));
    writer.line('case int64:');
    writer.block(() => writer.line('return int(value - right.(int64))'));
    writer.line('case float64:');
    writer.block(() => writer.line('return int(math.Copysign(1, value-right.(float64)) * boolToFloat(value != right.(float64)))'));
    writer.line('case string:');
    writer.block(() => writer.line('return strings.Compare(value, right.(string))'));
    writer.line('}');
    writer.line('panic(fmt.Sprintf("%T is not an ordered type", left))');
  });
  writer.line('}');
  writer.blank();
  writer.line('func boolToFloat(value bool) float64 {');
  writer.block(() => {
    writer.line('if value {');
    writer.block(() => writer.line('return 1'));
    writer.line('}');
    writer.line('return 0');
  });
  writer.line('}');
  writer.blank();
  writer.line('// Go has no expression-level fold, so generated aggregates project onto float64 and call these.');
  writer.line('func Sum[T any](items []T, of func(T) float64) float64 {');
  writer.block(() => {
    writer.line('total := 0.0');
    writer.line('for _, item := range items {');
    writer.block(() => writer.line('total += of(item)'));
    writer.line('}');
    writer.line('return total');
  });
  writer.line('}');
  writer.blank();
  writer.line('func Avg[T any](items []T, of func(T) float64) float64 {');
  writer.block(() => {
    writer.line('if len(items) == 0 {');
    writer.block(() => writer.line('return 0'));
    writer.line('}');
    writer.line('return Sum(items, of) / float64(len(items))');
  });
  writer.line('}');
  writer.blank();
  writer.line('func MinOf[T any](items []T, of func(T) float64) float64 {');
  writer.block(() => writeExtremum(writer, '<'));
  writer.line('}');
  writer.blank();
  writer.line('func MaxOf[T any](items []T, of func(T) float64) float64 {');
  writer.block(() => writeExtremum(writer, '>'));
  writer.line('}');
  writer.blank();
  writer.line('// Identity folds a []float64 onto itself, for aggregates declared without a `by` clause.');
  writer.line('func Identity(value float64) float64 { return value }');
  writer.blank();
  writer.line('// Each and Only back the list projections. Unlike the folds above they keep');
  writer.line('// their element type, so the result is whatever the projection returned.');
  writer.line('func Each[T any, R any](items []T, of func(T) R) []R {');
  writer.block(() => {
    writer.line('mapped := make([]R, 0, len(items))');
    writer.line('for _, item := range items {');
    writer.block(() => writer.line('mapped = append(mapped, of(item))'));
    writer.line('}');
    writer.line('return mapped');
  });
  writer.line('}');
  writer.blank();
  writer.line('func Only[T any](items []T, keep func(T) bool) []T {');
  writer.block(() => {
    writer.line('kept := make([]T, 0, len(items))');
    writer.line('for _, item := range items {');
    writer.block(() => {
      writer.line('if keep(item) {');
      writer.block(() => writer.line('kept = append(kept, item)'));
      writer.line('}');
    });
    writer.line('}');
    writer.line('return kept');
  });
  writer.line('}');
  writer.blank();
  writer.line('// ParseInt64 converts a path or query value, yielding 0 when it is not a number.');
  writer.line('func ParseInt64(value string) int64 {');
  writer.block(() => {
    writer.line('parsed, err := strconv.ParseInt(value, 10, 64)');
    writer.line('if err != nil {');
    writer.block(() => writer.line('return 0'));
    writer.line('}');
    writer.line('return parsed');
  });
  writer.line('}');
  writer.blank();
  writer.line('// ParseFloat64 converts a path or query value, yielding 0 when it is not a number.');
  writer.line('func ParseFloat64(value string) float64 {');
  writer.block(() => {
    writer.line('parsed, err := strconv.ParseFloat(value, 64)');
    writer.line('if err != nil {');
    writer.block(() => writer.line('return 0'));
    writer.line('}');
    writer.line('return parsed');
  });
  writer.line('}');
  return file(
    layout.sharedPath('numbers'),
    goSource('shared', [STD.fmt, STD.math, STD.strconv, STD.strings, STD.time], writer.toString()),
  );
}

function writeExtremum(writer: CodeWriter, operator: string): void {
  writer.line('if len(items) == 0 {');
  writer.block(() => writer.line('return 0'));
  writer.line('}');
  writer.line('best := of(items[0])');
  writer.line('for _, item := range items[1:] {');
  writer.block(() => {
    writer.line(`if value := of(item); value ${operator} best {`);
    writer.block(() => writer.line('best = value'));
    writer.line('}');
  });
  writer.line('}');
  writer.line('return best');
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
    '| `internal/domain` | nothing | aggregates, entities, value objects, events, errors |',
    '| `internal/application` | domain | ports and services |',
    '| `internal/infrastructure` | application | adapters that implement outbound ports |',
    '| `internal/interfaces` | application | chi routes and message handlers |',
    '',
    'Errors are Go-native: every port and service operation returns `(T, error)`, checked errors are',
    'concrete types wrapping an `Err<Name>` sentinel, and unchecked ones panic at the raise site.',
    '',
    '## Bounded contexts',
    '',
    ...context.project.contexts.map((c) => `- **${c.name}** (${c.kind}): ${c.modules.join(', ')}`),
    '',
    '## Running',
    '',
    '```bash',
    'go mod tidy',
    'go build ./...',
    'go run ./cmd/server',
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

function writeStruct(writer: CodeWriter, declaration: { name: string; fields: readonly IRField[] }, emitter: GoEmitter): void {
  if (declaration.fields.length === 0) {
    writer.line(`type ${goExported(declaration.name)} struct{}`);
    return;
  }
  writer.line(`type ${goExported(declaration.name)} struct {`);
  writer.block(() =>
    writer.lines_(
      aligned(
        declaration.fields.map((field) => [goExported(field.name), emitter.typeName(field.type), jsonTag(field), fieldNote(field)]),
      ),
    ),
  );
  writer.line('}');
}

function writeValidate(
  writer: CodeWriter,
  declaration: IRValueObjectDecl | IREntityDecl | IRAggregateDecl,
  index: ModuleIndex,
  pointer: boolean,
): void {
  const receiver = receiverOf(declaration.name);
  const emitter = new GoEmitter(index, { receiver, receiverFields: declaration.fields });

  writer.line(`// Validate re-checks every constraint and invariant declared on ${goExported(declaration.name)}.`);
  writer.line(`func (${receiver} ${pointer ? '*' : ''}${goExported(declaration.name)}) Validate() error {`);
  writer.block(() => {
    writeConstraints(writer, declaration.name, declaration.fields, receiver);
    writeInvariants(writer, declaration.name, declaration.invariants, emitter);
    writer.line('return nil');
  });
  writer.line('}');
}

function writeConstraints(writer: CodeWriter, shape: string, fields: readonly IRField[], receiver: string): void {
  const violation = (condition: string, field: string, rule: string): void => {
    writer.line(`if ${condition} {`);
    writer.block(() => writer.line(`return &shared.ConstraintViolation{Shape: ${goString(shape)}, Field: ${goString(field)}, Rule: ${goString(rule)}}`));
    writer.line('}');
  };

  for (const field of fields) {
    const access = `${receiver}.${goExported(field.name)}`;
    for (const constraint of field.constraints) {
      switch (constraint.kind) {
        case 'min':
          violation(`${access} < ${constraint.value}`, field.name, `min ${constraint.value}`);
          break;
        case 'max':
          violation(`${access} > ${constraint.value}`, field.name, `max ${constraint.value}`);
          break;
        case 'min-length':
          violation(`len(${access}) < ${constraint.value}`, field.name, `min length ${constraint.value}`);
          break;
        case 'max-length':
          violation(`len(${access}) > ${constraint.value}`, field.name, `max length ${constraint.value}`);
          break;
        case 'length':
          violation(`len(${access}) != ${constraint.value}`, field.name, `length ${constraint.value}`);
          break;
        case 'pattern':
          violation(`!regexp.MustCompile(${goString(constraint.value)}).MatchString(${access})`, field.name, 'pattern');
          break;
        default:
          break;
      }
    }
    // Go zero values are valid for scalars, so only nil-able fields can be missing.
    if (field.required && isNilable(field.type)) violation(`${access} == nil`, field.name, 'required');
  }
}

function writeInvariants(writer: CodeWriter, shape: string, invariants: readonly IRInvariant[], emitter: GoEmitter): void {
  for (const invariant of invariants) {
    writer.line(`if !${parenthesised(emitter.expression(invariant.condition))} {`);
    writer.block(() => writer.line(`return &shared.InvariantViolation{Shape: ${goString(shape)}, Rule: ${goString(invariant.description)}}`));
    writer.line('}');
  }
}

/** Wraps an expression unless its own outermost parentheses already span it. */
function parenthesised(expression: string): string {
  if (!expression.startsWith('(') || !expression.endsWith(')')) return `(${expression})`;
  let depth = 0;
  for (let i = 0; i < expression.length; i += 1) {
    if (expression[i] === '(') depth += 1;
    else if (expression[i] === ')' && (depth -= 1) === 0) return i === expression.length - 1 ? expression : `(${expression})`;
  }
  return `(${expression})`;
}

interface OperationOptions {
  /** Receiver clause, e.g. `(s *PlaceOrderService)`. */
  receiver: string;
  /** The operation takes `ctx context.Context` and may propagate errors. */
  contextual: boolean;
}

function writeOperation(writer: CodeWriter, emitter: GoEmitter, operation: IROperation, options: OperationOptions): void {
  const fallible = options.contextual || operation.throws.length > 0;
  const results = resultList(operation.returns, emitter, fallible);
  signatureDoc(writer, operation);
  writer.line(`func ${options.receiver} ${goExported(operation.phrase)}(${parameterList(operation, emitter, options.contextual)})${results ? ` ${results}` : ''} {`);
  writer.block(() => {
    emitter.enterOperation(operation.returns, fallible, operation.parameters);
    emitter.emitBlock(writer, operation.body);
    if (!endsWithReturn(operation.body)) {
      const terminal = emitter.terminalReturn();
      if (terminal) writer.line(terminal);
    }
  });
  writer.line('}');
}

function parameterList(operation: IROperationSignature, emitter: GoEmitter, contextual: boolean): string {
  const parameters = operation.parameters.map((p) => `${goUnexported(p.name)} ${emitter.typeName(p.type)}`);
  return (contextual ? ['ctx context.Context', ...parameters] : parameters).join(', ');
}

/** `(T, error)`, `error`, or the bare ok type when the operation cannot fail. */
function resultList(returns: IRType, emitter: GoEmitter, fallible: boolean): string {
  const ok = emitter.typeName(returns);
  if (!fallible) return ok;
  return ok === '' ? 'error' : `(${ok}, error)`;
}

function jsonTag(field: IRField): string {
  const omit = !field.required || field.type.kind === 'optional' ? ',omitempty' : '';
  return '`json:"' + snakeCase(field.name) + omit + '"`';
}

function fieldNote(field: IRField): string {
  const parts: string[] = [];
  if (field.description) parts.push(field.description);
  if (field.derived) parts.push('Derived: recomputed rather than stored.');
  const fallback = field.constraints.find((c) => c.kind === 'default');
  if (fallback && fallback.kind === 'default') parts.push(`Defaults to ${String(fallback.value)}.`);
  return parts.length > 0 ? `// ${parts.join(' ')}` : '';
}

/** `"no order exists with id {orderId}"` becomes a Sprintf format plus its arguments. */
function messageFormat(message: string, fields: readonly IRField[]): { format: string; args: string[] } {
  const known = new Set(fields.map((f) => f.name));
  const args: string[] = [];
  const format = message.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    if (!known.has(name)) return match;
    args.push(`e.${goExported(name)}`);
    return '%v';
  });
  return { format, args };
}

function notFound(index: ModuleIndex, operation: IROperationSignature, argument: string): string {
  const name = operation.throws[0];
  const declaration = name ? index.typed(name, 'error') : undefined;
  if (!name || !declaration) return `fmt.Errorf("no record for %v", ${argument})`;
  const field = declaration.fields[0];
  return `&domain.${goExported(name)}{${field ? `${goExported(field.name)}: ${argument}` : ''}}`;
}

function storedShape(port: IRPortDecl, index: ModuleIndex): IREntityDecl | IRAggregateDecl | null {
  for (const operation of port.operations) {
    const inner = unwrap(operation.returns);
    const candidate = inner.kind === 'named' ? inner.name : inner.kind === 'list' && inner.of.kind === 'named' ? inner.of.name : null;
    const declaration = candidate ? index.get(candidate) : undefined;
    if (declaration?.kind === 'aggregate' || declaration?.kind === 'entity') return declaration;
  }
  return index.typed(port.name.replace(/(Repository|Store|Gateway|Adapter)$/, ''), 'aggregate') ?? null;
}

function identityField(declaration: IREntityDecl | IRAggregateDecl): IRField {
  const name = declaration.identity[0];
  return declaration.fields.find((f) => f.name === name) ?? declaration.fields[0]!;
}

function pathValue(type: IRType, param: string): string {
  const raw = `chi.URLParam(r, ${goString(param)})`;
  const inner = unwrap(type);
  if (inner.kind !== 'primitive') return raw;
  if (inner.name === 'integer') return `shared.ParseInt64(${raw})`;
  if (inner.name === 'decimal') return `shared.ParseFloat64(${raw})`;
  return raw;
}

/** Handler functions are named after the operation, falling back to the route. */
function handlerNames(endpoints: readonly IREndpointDecl[]): Map<string, string> {
  const taken = new Set<string>();
  const names = new Map<string, string>();
  for (const endpoint of endpoints) {
    const preferred = goUnexported(endpoint.handler.operation);
    const name = taken.has(preferred) ? goUnexported(endpoint.name) : preferred;
    taken.add(name);
    names.set(endpoint.name, name);
  }
  return names;
}

function endsWithReturn(body: readonly { kind: string }[]): boolean {
  return body.length > 0 && body[body.length - 1]!.kind === 'return';
}

function isNilable(type: IRType): boolean {
  if (type.kind === 'optional' || type.kind === 'list' || type.kind === 'set' || type.kind === 'map') return true;
  return type.kind === 'primitive' && (type.name === 'bytes' || type.name === 'json');
}

/** Go receivers are one letter: the initial of the type they hang off. */
function receiverOf(name: string): string {
  return goUnexported(name).charAt(0) || 'v';
}

function chiMethod(method: string): string {
  return method.charAt(0) + method.slice(1).toLowerCase();
}

const HTTP_STATUS: Record<number, string> = {
  200: 'http.StatusOK',
  201: 'http.StatusCreated',
  202: 'http.StatusAccepted',
  204: 'http.StatusNoContent',
  400: 'http.StatusBadRequest',
  401: 'http.StatusUnauthorized',
  403: 'http.StatusForbidden',
  404: 'http.StatusNotFound',
  409: 'http.StatusConflict',
  410: 'http.StatusGone',
  422: 'http.StatusUnprocessableEntity',
  429: 'http.StatusTooManyRequests',
  500: 'http.StatusInternalServerError',
  502: 'http.StatusBadGateway',
  503: 'http.StatusServiceUnavailable',
};

function httpStatus(status: number): string {
  return HTTP_STATUS[status] ?? String(status);
}

function doc(writer: CodeWriter, name: string, summary: string, description?: string): void {
  writer.lines_(comment(`${name} ${summary}`, '// '));
  if (!description) return;
  writer.line('//');
  writer.lines_(comment(description, '// '));
}

function signatureDoc(writer: CodeWriter, operation: IROperationSignature): void {
  const name = goExported(operation.phrase);
  const parts = [`implements the HADL operation "${operation.phrase}", returning ${typeToString(operation.returns)}.`];
  if (operation.throws.length > 0) parts.push(`It fails with ${operation.throws.join(', ')}.`);
  writer.lines_(comment(`${name} ${parts.join(' ')}`, '// '));
  if (operation.description) {
    writer.line('//');
    writer.lines_(comment(operation.description, '// '));
  }
}

// ---------------------------------------------------------------------------
// Files, packages and imports
// ---------------------------------------------------------------------------

interface GoImport {
  path: string;
  /** Selector used in code; emitted as an alias when it differs from the last path segment. */
  selector?: string;
}

const STD = {
  context: { path: 'context' },
  errors: { path: 'errors' },
  fmt: { path: 'fmt' },
  io: { path: 'io' },
  json: { path: 'encoding/json' },
  log: { path: 'log' },
  math: { path: 'math' },
  http: { path: 'net/http' },
  os: { path: 'os' },
  regexp: { path: 'regexp' },
  sql: { path: 'database/sql' },
  strconv: { path: 'strconv' },
  strings: { path: 'strings' },
  sync: { path: 'sync' },
  time: { path: 'time' },
} satisfies Record<string, GoImport>;

const EXTERNAL = {
  chi: { path: 'github.com/go-chi/chi/v5', selector: 'chi' },
  middleware: { path: 'github.com/go-chi/chi/v5/middleware' },
  uuid: { path: 'github.com/google/uuid' },
} satisfies Record<string, GoImport>;

function goModulePath(context: GenerationContext): string {
  return `github.com/generated/${kebabCase(context.project.name)}`;
}

function domainPackage(context: GenerationContext, module: IRModule): GoImport {
  return { path: `${goModulePath(context)}/internal/domain/${goPackage(module.name)}`, selector: 'domain' };
}

function applicationPackage(context: GenerationContext, module: IRModule): GoImport {
  return { path: `${goModulePath(context)}/internal/application/${goPackage(module.name)}`, selector: 'application' };
}

function sharedPackage(context: GenerationContext): GoImport {
  return { path: `${goModulePath(context)}/internal/shared`, selector: 'shared' };
}

function domainImports(context: GenerationContext): GoImport[] {
  return [STD.regexp, STD.strings, STD.time, EXTERNAL.uuid, sharedPackage(context)];
}

function applicationImports(context: GenerationContext, module: IRModule): GoImport[] {
  return [STD.context, STD.regexp, STD.strings, STD.time, EXTERNAL.uuid, domainPackage(context, module), sharedPackage(context)];
}

function infrastructureImports(context: GenerationContext, module: IRModule): GoImport[] {
  return [
    STD.context,
    STD.sql,
    STD.errors,
    STD.fmt,
    STD.json,
    STD.sync,
    STD.time,
    applicationPackage(context, module),
    domainPackage(context, module),
    sharedPackage(context),
  ];
}

function interfaceImports(context: GenerationContext, module: IRModule): GoImport[] {
  return [
    STD.context,
    STD.errors,
    STD.io,
    STD.json,
    STD.http,
    STD.time,
    EXTERNAL.chi,
    EXTERNAL.uuid,
    applicationPackage(context, module),
    domainPackage(context, module),
    sharedPackage(context),
  ];
}

/** `interface` is a Go keyword, so the driving-adapter layer gets a plural directory. */
function interfacePath(module: IRModule, fileName: string): string {
  return layout.path('interface', module, fileName).replace('/interface/', '/interfaces/');
}

function selectorOf(imported: GoImport): string {
  return imported.selector ?? imported.path.split('/').pop() ?? imported.path;
}

/** Assembles a compilable file: only the imports the body actually references survive. */
function goSource(packageName: string, imports: readonly GoImport[], body: string): string {
  const writer = goWriter();
  writer.line(`// ${GENERATED_BANNER}`);
  writer.blank();
  writer.line(`package ${packageName}`);

  const used = imports.filter((i) => new RegExp(`\\b${selectorOf(i)}\\.`).test(body)).sort((a, b) => a.path.localeCompare(b.path));
  if (used.length > 0) {
    const standard = used.filter((i) => !i.path.includes('.'));
    const external = used.filter((i) => i.path.includes('.'));
    writer.blank();
    writer.line('import (');
    writer.block(() => {
      writer.lines_(standard.map(importLine));
      if (standard.length > 0 && external.length > 0) writer.line('');
      writer.lines_(external.map(importLine));
    });
    writer.line(')');
  }
  return `${writer.toString()}\n${body}`;
}

function importLine(imported: GoImport): string {
  const last = imported.path.split('/').pop();
  const selector = selectorOf(imported);
  return selector === last ? `"${imported.path}"` : `${selector} "${imported.path}"`;
}

function goWriter(): CodeWriter {
  return new CodeWriter('\t');
}

/** Pads columns so structs and const blocks read like gofmt output. */
function aligned(rows: ReadonlyArray<readonly string[]>): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join(' ')
      .trimEnd(),
  );
}

export { GoEmitter };
