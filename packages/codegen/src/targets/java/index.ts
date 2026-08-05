/**
 * Java / Spring Boot backend.
 *
 * Emits a hexagonal Maven project: records and classes for the domain, port
 * interfaces the application layer depends on, `@Repository` adapters that
 * implement them, and a thin web layer where checked errors become HTTP status
 * codes. One public type per file, as javac requires.
 */
import {
  CodeWriter,
  GENERATED_BANNER,
  bodiedOperationsOf,
  camelCase,
  comment,
  escapeReserved,
  file,
  indexModule,
  kebabCase,
  normalisePhrase,
  pascalCase,
  screamingSnakeCase,
  snakeCase,
  tableName,
  toYaml,
  unwrap,
  type CodeGenerator,
  type Diagnostic,
  type GeneratedFile,
  type GenerationContext,
  type IRAdapterDecl,
  type IREndpointDecl,
  type IRExpression,
  type IRField,
  type IRInvariant,
  type IRModule,
  type IROperation,
  type IROperationSignature,
  type IRParameter,
  type IRPortDecl,
  type IRStatement,
  type IRType,
  type ModuleIndex,
} from '@haic/core';
import { declaredImplementation, placeholderDiagnostic, placeholderMessage } from '../../shared/adapters.js';
import { ProjectLayout, type Layer } from '../../shared/layout.js';
import { JavaEmitter, fieldsOf, enumConstant, type JavaEmitterOptions } from './emitter.js';

const SPRING_BOOT_VERSION = '3.4.1';

const MAPPING_ANNOTATION: Record<string, string> = {
  GET: 'GetMapping',
  POST: 'PostMapping',
  PUT: 'PutMapping',
  PATCH: 'PatchMapping',
  DELETE: 'DeleteMapping',
};

const JDBC_URL: Record<string, (name: string) => string> = {
  postgres: (name) => `jdbc:postgresql://localhost:5432/${name}`,
  mysql: (name) => `jdbc:mysql://localhost:3306/${name}`,
  sqlite: (name) => `jdbc:sqlite:${name}.db`,
};

export const javaGenerator: CodeGenerator = {
  id: 'java',
  displayName: 'Java',
  framework: 'Spring Boot',
  verifyCommand: ['mvn', '-q', 'compile'],

  generate(module, context) {
    const index = indexModule(module);
    const layout = layoutFor(context);
    const diagnostics: Diagnostic[] = [];
    return {
      files: [
        ...enumFiles(module, index, layout),
        ...valueObjectFiles(module, index, layout),
        ...modelFiles(module, index, layout),
        ...errorFiles(module, index, layout),
        ...messageFiles(module, index, layout),
        ...portFiles(module, index, layout),
        ...serviceFiles(module, index, layout),
        ...adapterFiles(module, index, layout, diagnostics),
        ...controllerFiles(module, index, layout),
        ...handlerFiles(module, index, layout),
      ],
      diagnostics,
    };
  },

  generateProject(context) {
    const layout = layoutFor(context);
    return {
      files: [
        pomXml(context),
        applicationYaml(context),
        applicationClass(layout),
        checkedDomainException(layout),
        uncheckedDomainException(layout),
        constraintViolation(layout),
        invariantViolation(layout),
        ordering(layout),
        domainEventPublisher(layout),
        loggingDomainEventPublisher(layout),
        globalExceptionHandler(layout),
        readme(context),
      ],
      diagnostics: [],
    };
  },
};

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** `interface` is a Java keyword, so that layer lives in the `interfaces` package. */
const LAYER_PACKAGE: Record<Layer, string> = {
  domain: 'domain',
  application: 'application',
  infrastructure: 'infrastructure',
  interface: 'interfaces',
  shared: 'shared',
};

class JavaLayout {
  private readonly layout: ProjectLayout;

  constructor(readonly packageRoot: string) {
    this.layout = new ProjectLayout({
      sourceRoot: `src/main/java/${packageRoot.split('.').join('/')}`,
      extension: '.java',
      // Callers pre-case the parts: packages are lowercase, a file is its public type.
      directoryCase: (name) => name,
    });
  }

  path(layer: Layer, module: IRModule, typeName: string): string {
    return this.layout.path(layer, packageSegment(module.name), typeName).replace(`/${layer}/`, `/${LAYER_PACKAGE[layer]}/`);
  }

  sharedPath(typeName: string): string {
    return this.layout.sharedPath(typeName);
  }

  entryPoint(typeName: string): string {
    return this.layout.entryPoint(typeName);
  }

  package(layer: Layer, module: IRModule): string {
    return `${this.packageRoot}.${LAYER_PACKAGE[layer]}.${packageSegment(module.name)}`;
  }

  get sharedPackage(): string {
    return `${this.packageRoot}.shared`;
  }
}

function layoutFor(context: GenerationContext): JavaLayout {
  const configured = context.options['packageName'];
  return new JavaLayout(typeof configured === 'string' ? configured : `com.ailang.${packageSegment(context.project.name)}`);
}

// ---------------------------------------------------------------------------
// Domain layer
// ---------------------------------------------------------------------------

function enumFiles(module: IRModule, index: ModuleIndex, layout: JavaLayout): GeneratedFile[] {
  return index.enums.map((declaration) => {
    const writer = body();
    docComment(writer, declaration.description);
    writer.line(`public enum ${pascalCase(declaration.name)} {`);
    writer.block(() => {
      declaration.values.forEach((value, position) => {
        if (value.description) writer.line(`/** ${value.description} */`);
        writer.line(`${enumConstant(value.name)}${position === declaration.values.length - 1 ? ';' : ','}`);
      });
    });
    writer.line('}');
    return javaFile(layout.path('domain', module, pascalCase(declaration.name)), layout.package('domain', module), [], writer);
  });
}

function valueObjectFiles(module: IRModule, index: ModuleIndex, layout: JavaLayout): GeneratedFile[] {
  return index.valueObjects.map((declaration) => {
    const writer = body();
    const emitter = new JavaEmitter(index, { self: declaration, fieldAccess: 'local' });

    docComment(writer, declaration.description ?? `Value object ${declaration.name}. Compared by value, never by identity.`);
    writer.line(`public record ${pascalCase(declaration.name)}(${components(declaration.fields, emitter)}) {`);
    writer.blank();
    writer.block(() => {
      writer.line('/** A value object is never handed out in an invalid state. */');
      writer.line(`public ${pascalCase(declaration.name)} {`);
      writer.block(() => {
        for (const field of declaration.fields) {
          const defaulted = defaultedValue(field, emitter);
          if (defaulted) writer.line(`${fieldName(field.name)} = ${defaulted};`);
        }
        emitConstraintChecks(writer, declaration.name, declaration.fields, (name) => name);
        emitInvariantChecks(writer, declaration.name, declaration.invariants, emitter);
      });
      writer.line('}');
    });
    writer.line('}');
    return javaFile(
      layout.path('domain', module, pascalCase(declaration.name)),
      layout.package('domain', module),
      validationImports(layout),
      writer,
    );
  });
}

function modelFiles(module: IRModule, index: ModuleIndex, layout: JavaLayout): GeneratedFile[] {
  return [...index.entities, ...index.aggregates].map((declaration) => {
    const writer = body();
    const emitter = new JavaEmitter(index, { self: declaration });
    const name = pascalCase(declaration.name);
    const label = declaration.kind === 'aggregate' ? 'Aggregate root' : 'Entity';

    docComment(writer, declaration.description ?? `${label} ${declaration.name}, identified by ${declaration.identity.join(', ')}.`);
    writer.line(`public final class ${name} {`);
    writer.blank();
    writer.block(() => {
      for (const field of declaration.fields) {
        fieldDoc(writer, field);
        const immutable = declaration.identity.includes(field.name) ? 'final ' : '';
        writer.line(`private ${immutable}${emitter.typeName(field.type)} ${fieldName(field.name)};`);
      }
      writer.blank();

      writer.line(`public ${name}(${components(declaration.fields, emitter)}) {`);
      writer.block(() => {
        for (const field of declaration.fields) {
          writer.line(`this.${fieldName(field.name)} = ${defaultedValue(field, emitter) ?? fieldName(field.name)};`);
        }
        writer.line('checkInvariants();');
      });
      writer.line('}');
      writer.blank();

      writer.line('/** Re-checks every rule declared on this type. Call after any change. */');
      writer.line('public void checkInvariants() {');
      writer.block(() => {
        emitConstraintChecks(writer, declaration.name, declaration.fields, (field) => `this.${field}`);
        emitInvariantChecks(writer, declaration.name, declaration.invariants, emitter);
        if (declaration.fields.length === 0 && declaration.invariants.length === 0) writer.line('// no rules declared');
      });
      writer.line('}');

      for (const field of declaration.fields) {
        writer.blank();
        const accessor = `${emitter.typeName(field.type)} get${pascalCase(field.name)}()`;
        writer.line(`public ${accessor} {`);
        writer.block(() => writer.line(`return this.${fieldName(field.name)};`));
        writer.line('}');
        if (declaration.identity.includes(field.name)) continue;
        writer.blank();
        writer.line(`public void set${pascalCase(field.name)}(${emitter.typeName(field.type)} ${fieldName(field.name)}) {`);
        writer.block(() => writer.line(`this.${fieldName(field.name)} = ${fieldName(field.name)};`));
        writer.line('}');
      }

      for (const operation of bodiedOperationsOf(declaration)) {
        writer.blank();
        emitOperation(writer, index, operation, { self: declaration });
      }
    });
    writer.line('}');
    return javaFile(layout.path('domain', module, name), layout.package('domain', module), validationImports(layout), writer);
  });
}

function errorFiles(module: IRModule, index: ModuleIndex, layout: JavaLayout): GeneratedFile[] {
  return index.errors.map((declaration) => {
    const base = declaration.checked ? 'CheckedDomainException' : 'UncheckedDomainException';
    const writer = body();
    const emitter = new JavaEmitter(index);
    const name = pascalCase(declaration.name);

    docComment(
      writer,
      declaration.description ??
        (declaration.checked
          ? 'Checked: part of the operation contract, callers are expected to handle it.'
          : 'Unchecked: signals a defect. Do not catch it to keep going.'),
    );
    writer.line(`public class ${name} extends ${base} {`);
    writer.blank();
    writer.block(() => {
      writer.line(`public static final String CODE = "${screamingSnakeCase(declaration.name)}";`);
      writer.line(`public static final int STATUS = ${declaration.status ?? (declaration.checked ? 400 : 500)};`);
      writer.blank();
      for (const field of declaration.fields) {
        writer.line(`private final ${emitter.typeName(field.type)} ${fieldName(field.name)};`);
      }
      if (declaration.fields.length > 0) writer.blank();

      writer.line(`public ${name}(${components(declaration.fields, emitter)}) {`);
      writer.block(() => {
        writer.line(`super(CODE, STATUS, ${messageExpression(declaration.message, declaration.fields)});`);
        for (const field of declaration.fields) writer.line(`this.${fieldName(field.name)} = ${fieldName(field.name)};`);
      });
      writer.line('}');

      for (const field of declaration.fields) {
        writer.blank();
        writer.line(`public ${emitter.typeName(field.type)} get${pascalCase(field.name)}() {`);
        writer.block(() => writer.line(`return this.${fieldName(field.name)};`));
        writer.line('}');
      }
    });
    writer.line('}');
    return javaFile(
      layout.path('domain', module, name),
      layout.package('domain', module),
      [`${layout.sharedPackage}.${base}`],
      writer,
    );
  });
}

function messageFiles(module: IRModule, index: ModuleIndex, layout: JavaLayout): GeneratedFile[] {
  const shapes = [...index.commands, ...index.events, ...index.dtos, ...index.queries];
  return shapes.map((declaration) => {
    const writer = body();
    const emitter = new JavaEmitter(index);
    const role =
      declaration.kind === 'command'
        ? `Command handled by ${declaration.target ?? 'the application layer'}.`
        : declaration.kind === 'event'
          ? `Event emitted by ${declaration.source ?? 'the domain'}.`
          : declaration.kind === 'query'
            ? `Selects ${declaration.over} records matching its fields.`
            : `Data transfer object${declaration.projects ? ` projecting ${declaration.projects}` : ''}.`;

    docComment(writer, declaration.description ?? role);
    const name = pascalCase(declaration.name);
    const header = `public record ${name}(${components(declaration.fields, emitter)})`;
    if (declaration.kind === 'event') {
      writer.line(`${header} {`);
      writer.blank();
      writer.block(() => writer.line(`public static final String TOPIC = "${declaration.topic ?? kebabCase(declaration.name)}";`));
      writer.line('}');
    } else {
      writer.line(`${header} {}`);
    }
    return javaFile(layout.path('domain', module, name), layout.package('domain', module), [], writer);
  });
}

// ---------------------------------------------------------------------------
// Application layer
// ---------------------------------------------------------------------------

function portFiles(module: IRModule, index: ModuleIndex, layout: JavaLayout): GeneratedFile[] {
  return index.ports.map((port) => {
    const writer = body();
    const emitter = new JavaEmitter(index);

    docComment(
      writer,
      port.description ??
        (port.direction === 'inbound'
          ? 'Inbound port: a use case the outside world can drive.'
          : 'Outbound port: something the domain drives. Implemented by an adapter.'),
    );
    writer.line(`public interface ${pascalCase(port.name)} {`);
    writer.block(() => {
      for (const operation of port.operations) {
        writer.blank();
        signatureDoc(writer, operation);
        writer.line(
          `${emitter.typeName(operation.returns)} ${camelCase(operation.phrase)}(${parameters(operation, emitter)})${throwsClause(operation.throws, index)};`,
        );
      }
    });
    writer.line('}');
    return javaFile(
      layout.path('application', module, pascalCase(port.name)),
      layout.package('application', module),
      domainImports(layout, module, index),
      writer,
    );
  });
}

function serviceFiles(module: IRModule, index: ModuleIndex, layout: JavaLayout): GeneratedFile[] {
  return index.services.map((service) => {
    const imports = [
      ...domainImports(layout, module, index),
      `${layout.sharedPackage}.DomainEventPublisher`,
      'org.springframework.stereotype.Service',
    ];
    const writer = body();
    const name = pascalCase(service.name);
    const port = service.implements ? index.typed(service.implements, 'port') : undefined;
    const inherited = new Set((port?.operations ?? []).map((operation) => normalisePhrase(operation.phrase)));

    docComment(writer, service.description ?? `Application service ${service.name}.`);
    writer.line('@Service');
    writer.line(`public class ${name}${service.implements ? ` implements ${pascalCase(service.implements)}` : ''} {`);
    writer.blank();
    writer.block(() => {
      for (const used of service.uses) writer.line(`private final ${pascalCase(used)} ${fieldName(used)};`);
      writer.line('private final DomainEventPublisher eventPublisher;');
      writer.blank();

      const injected = [...service.uses.map((used) => `${pascalCase(used)} ${fieldName(used)}`), 'DomainEventPublisher eventPublisher'];
      writer.line(`public ${name}(${injected.join(', ')}) {`);
      writer.block(() => {
        for (const used of service.uses) writer.line(`this.${fieldName(used)} = ${fieldName(used)};`);
        writer.line('this.eventPublisher = eventPublisher;');
      });
      writer.line('}');

      for (const operation of service.operations) {
        writer.blank();
        emitOperation(writer, index, operation, {
          portFields: portFieldsOf(service.uses),
          annotateOverride: inherited.has(normalisePhrase(operation.phrase)),
        });
      }
    });
    writer.line('}');
    return javaFile(layout.path('application', module, name), layout.package('application', module), imports, writer);
  });
}

// ---------------------------------------------------------------------------
// Infrastructure layer
// ---------------------------------------------------------------------------

function adapterFiles(module: IRModule, index: ModuleIndex, layout: JavaLayout, diagnostics: Diagnostic[]): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const adapter of index.adapters) {
    const port = index.typed(adapter.implements, 'port');
    if (!port) continue;

    const sql = adapter.technology === 'sql';
    const entity = entityOf(port, index);
    const imports = [
      ...domainImports(layout, module, index),
      `${layout.package('application', module)}.${pascalCase(port.name)}`,
      'org.springframework.stereotype.Repository',
      ...(sql ? ['com.fasterxml.jackson.databind.ObjectMapper', 'org.springframework.jdbc.core.JdbcTemplate'] : []),
    ];
    const writer = body();
    const emitter = new JavaEmitter(index);
    const name = pascalCase(adapter.name);

    docComment(writer, adapter.description ?? `${adapter.technology} adapter for ${port.name}.`);
    writer.line('@Repository');
    writer.line(`public class ${name} implements ${pascalCase(port.name)} {`);
    writer.blank();
    writer.block(() => {
      if (sql) {
        writer.line(`private static final String TABLE = "${sqlTable(adapter, port)}";`);
        writer.blank();
        writer.line('private final JdbcTemplate jdbcTemplate;');
        writer.line('private final ObjectMapper objectMapper;');
        writer.blank();
        writer.line(`public ${name}(JdbcTemplate jdbcTemplate, ObjectMapper objectMapper) {`);
        writer.block(() => {
          writer.line('this.jdbcTemplate = jdbcTemplate;');
          writer.line('this.objectMapper = objectMapper;');
        });
        writer.line('}');
      } else if (adapter.technology === 'in-memory') {
        const value = entity ? pascalCase(entity) : 'Object';
        writer.line(
          `private final java.util.concurrent.ConcurrentHashMap<String, ${value}> rows = new java.util.concurrent.ConcurrentHashMap<>();`,
        );
      }

      for (const operation of port.operations) {
        writer.blank();
        signatureDoc(writer, operation);
        writer.line('@Override');
        writer.line(
          `public ${emitter.typeName(operation.returns)} ${camelCase(operation.phrase)}(${parameters(operation, emitter)})${throwsClause(operation.throws, index)} {`,
        );
        writer.block(() => {
          const declared = declaredImplementation(adapter, operation.phrase);
          if (declared) {
            operationEmitter(index, declared, {}).emitImplementation(writer, declared);
            return;
          }
          if (!emitAdapterBody(writer, adapter, operation, index, entity)) {
            diagnostics.push(placeholderDiagnostic(adapter, operation.phrase, 'java'));
          }
        });
        writer.line('}');
      }

      if (sql && entity) {
        writer.blank();
        writer.line('/** Rows keep the aggregate in a `data` JSON column; map columns here instead if you prefer. */');
        writer.line(`private ${pascalCase(entity)} readRow(java.util.Map<String, Object> row) {`);
        writer.block(() => {
          writer.line('try {');
          writer.block(() => writer.line(`return this.objectMapper.readValue(String.valueOf(row.get("data")), ${pascalCase(entity)}.class);`));
          writer.line('} catch (com.fasterxml.jackson.core.JsonProcessingException exception) {');
          writer.block(() => writer.line('throw new IllegalStateException("cannot read a row of " + TABLE, exception);'));
          writer.line('}');
        });
        writer.line('}');
        writer.blank();
        writer.line(`private String writeRow(${pascalCase(entity)} entity) {`);
        writer.block(() => {
          writer.line('try {');
          writer.block(() => writer.line('return this.objectMapper.writeValueAsString(entity);'));
          writer.line('} catch (com.fasterxml.jackson.core.JsonProcessingException exception) {');
          writer.block(() => writer.line('throw new IllegalStateException("cannot write a row of " + TABLE, exception);'));
          writer.line('}');
        });
        writer.line('}');
      }
    });
    writer.line('}');
    files.push(javaFile(layout.path('infrastructure', module, name), layout.package('infrastructure', module), imports, writer));
  }
  return files;
}

/** Recognised repository phrases get a real implementation; anything else is left to the author. */
function emitAdapterBody(
  writer: CodeWriter,
  adapter: IRAdapterDecl,
  operation: IROperationSignature,
  index: ModuleIndex,
  entity: string | null,
): boolean {
  const phrase = operation.phrase.toLowerCase();
  const first = operation.parameters[0];
  const error = operation.throws.find((name) => index.typed(name, 'error')?.checked);
  const key = first ? fieldName(first.name) : 'id';
  /** Identity of the shape being written, e.g. `order.getId()`. */
  const identity = (): string => (first ? identityAccess(index, first) : 'null');

  if (adapter.technology === 'sql' && entity) {
    if (/^(find|get|read|load)\b.*\bby id$/.test(phrase)) {
      writer.line(`var rows = this.jdbcTemplate.queryForList("SELECT * FROM " + TABLE + " WHERE id = ?", ${key});`);
      writer.line('if (rows.isEmpty()) {');
      writer.block(() => writer.line(error ? `throw ${errorConstruction(index, error, key)};` : 'return null;'));
      writer.line('}');
      writer.line('return readRow(rows.get(0));');
      return true;
    }
    if (/^(save|store|persist|upsert)\b/.test(phrase)) {
      writer.line('this.jdbcTemplate.update(');
      writer.block(() => {
        writer.line('"INSERT INTO " + TABLE + " (id, data) VALUES (?, ?::jsonb)"');
        writer.line('    + " ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",');
        writer.line(`${identity()}, writeRow(${key}));`);
      });
      return true;
    }
    if (/^(list|find all|search)\b/.test(phrase)) {
      const filter = first ? `" WHERE ${snakeCase(first.name)} = ?", ${key}` : '""';
      writer.line(`var rows = this.jdbcTemplate.queryForList("SELECT * FROM " + TABLE + ${filter});`);
      writer.line('return rows.stream().map(this::readRow).toList();');
      return true;
    }
  }

  if (adapter.technology === 'sql' && /^(delete|remove)\b/.test(phrase)) {
    writer.line(`this.jdbcTemplate.update("DELETE FROM " + TABLE + " WHERE id = ?", ${key});`);
    return true;
  }

  if (adapter.technology === 'in-memory' && entity) {
    if (/^(find|get|read|load)\b.*\bby id$/.test(phrase)) {
      writer.line(`var found = this.rows.get(String.valueOf(${key}));`);
      writer.line('if (found == null) {');
      writer.block(() => writer.line(error ? `throw ${errorConstruction(index, error, key)};` : 'return null;'));
      writer.line('}');
      writer.line('return found;');
      return true;
    }
    if (/^(save|store|persist|upsert)\b/.test(phrase)) {
      writer.line(`this.rows.put(String.valueOf(${identity()}), ${key});`);
      return true;
    }
    if (/^(list|find all|search)\b/.test(phrase)) {
      const field = first ? fieldsOf(index.get(entity)).find((f) => camelCase(f.name) === camelCase(first.name)) : undefined;
      if (field && first) {
        const access = readAccess(index, 'each', { kind: 'named', name: entity }, field.name);
        writer.line(`return this.rows.values().stream().filter(each -> java.util.Objects.equals(${access}, ${key})).toList();`);
      } else {
        writer.line('return java.util.List.copyOf(this.rows.values());');
      }
      return true;
    }
    if (/^(delete|remove)\b/.test(phrase)) {
      writer.line(`this.rows.remove(String.valueOf(${key}));`);
      return true;
    }
  }

  writer.line(`throw new UnsupportedOperationException("${placeholderMessage(operation.phrase, adapter.technology)}");`);
  return false;
}

// ---------------------------------------------------------------------------
// Interface layer
// ---------------------------------------------------------------------------

function controllerFiles(module: IRModule, index: ModuleIndex, layout: JavaLayout): GeneratedFile[] {
  if (index.endpoints.length === 0) return [];

  const services = [...new Set(index.endpoints.map((endpoint) => endpoint.handler.service))];
  const imports = [
    ...domainImports(layout, module, index),
    ...services.map((service) => `${layout.package('application', module)}.${pascalCase(service)}`),
    'org.springframework.http.ResponseEntity',
    'org.springframework.web.bind.annotation.RestController',
    ...new Set(index.endpoints.map((endpoint) => `org.springframework.web.bind.annotation.${MAPPING_ANNOTATION[endpoint.method] ?? 'RequestMapping'}`)),
    ...(index.endpoints.some((endpoint) => pathVariables(endpoint.path).length > 0) ? ['org.springframework.web.bind.annotation.PathVariable'] : []),
    ...(index.endpoints.some((endpoint) => endpoint.request) ? ['org.springframework.web.bind.annotation.RequestBody'] : []),
  ];

  const writer = body();
  const emitter = new JavaEmitter(index);
  const name = `${pascalCase(module.name)}Controller`;
  const used = new Set<string>();

  writer.line(`/** HTTP entry points for the ${module.name} module. */`);
  writer.line('@RestController');
  writer.line(`public class ${name} {`);
  writer.blank();
  writer.block(() => {
    for (const service of services) writer.line(`private final ${pascalCase(service)} ${fieldName(service)};`);
    writer.blank();
    writer.line(`public ${name}(${services.map((service) => `${pascalCase(service)} ${fieldName(service)}`).join(', ')}) {`);
    writer.block(() => {
      for (const service of services) writer.line(`this.${fieldName(service)} = ${fieldName(service)};`);
    });
    writer.line('}');

    for (const endpoint of index.endpoints) {
      writer.blank();
      emitEndpoint(writer, endpoint, index, emitter, used);
    }
  });
  writer.line('}');
  return [javaFile(layout.path('interface', module, name), layout.package('interface', module), imports, writer)];
}

function emitEndpoint(
  writer: CodeWriter,
  endpoint: IREndpointDecl,
  index: ModuleIndex,
  emitter: JavaEmitter,
  used: Set<string>,
): void {
  const resolved = index
    .resolvePhrase(endpoint.handler.operation)
    .find((entry) => entry.owner.name === endpoint.handler.service)?.operation;
  const success = endpoint.responses.find((response) => response.status < 400) ?? endpoint.responses[0]!;
  const body = success.body ? emitter.typeName(success.body) : 'Void';
  const variables = pathVariables(endpoint.path);
  const requestType = endpoint.request ? namedTypeOf(endpoint.request) : null;

  const signature = [
    ...variables.map((variable) => `@PathVariable("${variable}") ${pathVariableType(variable, requestType, resolved, index, emitter)} ${fieldName(variable)}`),
    ...(requestType ? [`@RequestBody ${pascalCase(requestType)} body`] : []),
  ];
  const args = (resolved?.parameters ?? []).map((parameter) => {
    if (requestType && namedTypeOf(parameter.type) === requestType) return 'body';
    const variable = variables.find((candidate) => camelCase(candidate) === camelCase(parameter.name));
    return variable ? fieldName(variable) : requestType ? 'body' : 'null';
  });

  writer.line(`/** ${endpoint.method} ${endpoint.path}${endpoint.auth === 'none' ? '' : ` (auth: ${endpoint.auth})`} */`);
  writer.line(`@${MAPPING_ANNOTATION[endpoint.method] ?? 'RequestMapping'}("${endpoint.path}")`);
  const method = uniqueName(camelCase(endpoint.handler.operation) || camelCase(endpoint.name), used);
  writer.line(
    `public ResponseEntity<${body}> ${method}(${signature.join(', ')})${throwsClause(resolved?.throws ?? [], index)} {`,
  );
  writer.block(() => {
    const call = `this.${fieldName(endpoint.handler.service)}.${camelCase(endpoint.handler.operation)}(${args.join(', ')})`;
    if (success.body) {
      writer.line(`var result = ${call};`);
      writer.line(`return ResponseEntity.status(${success.status}).body(result);`);
    } else {
      writer.line(`${call};`);
      writer.line(`return ResponseEntity.status(${success.status}).build();`);
    }
  });
  writer.line('}');
}

function handlerFiles(module: IRModule, index: ModuleIndex, layout: JavaLayout): GeneratedFile[] {
  return index.handlers.map((handler) => {
    const scheduled = handler.trigger === 'schedule';
    const imports = [
      ...domainImports(layout, module, index),
      ...handler.uses.map((used) => `${layout.package('application', module)}.${pascalCase(used)}`),
      `${layout.sharedPackage}.DomainEventPublisher`,
      'org.springframework.stereotype.Component',
      scheduled ? 'org.springframework.scheduling.annotation.Scheduled' : 'org.springframework.context.event.EventListener',
    ];
    const writer = body();
    const name = pascalCase(handler.name);
    const payload = fieldsOf(index.get(handler.on)).length > 0 ? pascalCase(handler.on) : null;

    docComment(
      writer,
      handler.description ?? `Reacts to ${handler.on}. Delivery: ${handler.delivery}, up to ${handler.retries} retries.`,
    );
    writer.line('@Component');
    writer.line(`public class ${name} {`);
    writer.blank();
    writer.block(() => {
      for (const used of handler.uses) writer.line(`private final ${pascalCase(used)} ${fieldName(used)};`);
      writer.line('private final DomainEventPublisher eventPublisher;');
      writer.blank();

      const injected = [...handler.uses.map((used) => `${pascalCase(used)} ${fieldName(used)}`), 'DomainEventPublisher eventPublisher'];
      writer.line(`public ${name}(${injected.join(', ')}) {`);
      writer.block(() => {
        for (const used of handler.uses) writer.line(`this.${fieldName(used)} = ${fieldName(used)};`);
        writer.line('this.eventPublisher = eventPublisher;');
      });
      writer.line('}');
      writer.blank();

      if (scheduled) {
        writer.line('// Scheduling has to be switched on with @EnableScheduling on the application class.');
        writer.line(`@Scheduled(cron = "${handler.schedule ?? '0 * * * * *'}")`);
      } else {
        writer.line('@EventListener');
      }
      const emitter = new JavaEmitter(index, { portFields: portFieldsOf(handler.uses) });
      const parameter = payload && !scheduled ? `${payload} event` : '';
      if (payload) emitter.declareLocal('event', { kind: 'named', name: handler.on });
      writer.line(`public void handle(${parameter})${throwsClause(checkedErrors(handler.body, index), index)} {`);
      writer.block(() => emitter.emitBlock(writer, handler.body));
      writer.line('}');
    });
    writer.line('}');
    return javaFile(layout.path('interface', module, name), layout.package('interface', module), imports, writer);
  });
}

// ---------------------------------------------------------------------------
// Project-level files
// ---------------------------------------------------------------------------

function pomXml(context: GenerationContext): GeneratedFile {
  const artifact = kebabCase(context.project.name);
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${GENERATED_BANNER} -->
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>${SPRING_BOOT_VERSION}</version>
        <relativePath/>
    </parent>

    <groupId>com.ailang</groupId>
    <artifactId>${artifact}</artifactId>
    <version>0.1.0</version>
    <name>${artifact}</name>

    <properties>
        <java.version>21</java.version>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-jdbc</artifactId>
        </dependency>
        <dependency>
            <groupId>org.postgresql</groupId>
            <artifactId>postgresql</artifactId>
            <scope>runtime</scope>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>
`;
  return file('pom.xml', body);
}

function applicationYaml(context: GenerationContext): GeneratedFile {
  const infrastructure = context.project.modules.find((module) => module.infrastructure)?.infrastructure;
  const database = infrastructure?.databases[0];
  const settings: Record<string, unknown> = {
    server: { port: infrastructure?.port ?? 8080 },
    spring: {
      application: { name: kebabCase(context.project.name) },
      ...(database
        ? {
            datasource: {
              url: `\${DATABASE_URL:${(JDBC_URL[database.engine] ?? JDBC_URL['postgres']!)(database.name)}}`,
              username: '${DB_USERNAME:postgres}',
              password: '${DB_PASSWORD:}',
            },
          }
        : {}),
    },
    logging: { level: { root: `\${LOG_LEVEL:${infrastructure?.observability.logLevel ?? 'info'}}` } },
  };

  const environment = Object.entries(infrastructure?.environment ?? {});
  if (environment.length > 0) {
    settings['ailang'] = { environment: Object.fromEntries(environment.map(([key, value]) => [key, `\${${key}:${value}}`])) };
  }
  return file('src/main/resources/application.yml', `# ${GENERATED_BANNER}\n${toYaml(settings)}\n`);
}

function applicationClass(layout: JavaLayout): GeneratedFile {
  const writer = body();
  writer.line('/** Component scanning starts here, so every layer below this package is wired. */');
  writer.line('@SpringBootApplication');
  writer.line('public class Application {');
  writer.blank();
  writer.block(() => {
    writer.line('public static void main(String[] args) {');
    writer.block(() => writer.line('SpringApplication.run(Application.class, args);'));
    writer.line('}');
  });
  writer.line('}');
  return javaFile(
    layout.entryPoint('Application'),
    layout.packageRoot,
    ['org.springframework.boot.SpringApplication', 'org.springframework.boot.autoconfigure.SpringBootApplication'],
    writer,
  );
}

function checkedDomainException(layout: JavaLayout): GeneratedFile {
  const writer = body();
  docComment(
    writer,
    'Checked: part of an operation contract, so every caller is forced to handle it. The code and status travel with the exception, which keeps the web layer closed over new error types.',
  );
  writer.line('public abstract class CheckedDomainException extends Exception {');
  writer.blank();
  writer.block(() => emitDomainExceptionBody(writer, 'CheckedDomainException'));
  writer.line('}');
  return javaFile(layout.sharedPath('CheckedDomainException'), layout.sharedPackage, [], writer);
}

function uncheckedDomainException(layout: JavaLayout): GeneratedFile {
  const writer = body();
  docComment(writer, 'Unchecked: signals a defect. Catching it to keep going only hides the bug.');
  writer.line('public abstract class UncheckedDomainException extends RuntimeException {');
  writer.blank();
  writer.block(() => emitDomainExceptionBody(writer, 'UncheckedDomainException'));
  writer.line('}');
  return javaFile(layout.sharedPath('UncheckedDomainException'), layout.sharedPackage, [], writer);
}

function emitDomainExceptionBody(writer: CodeWriter, name: string): void {
  writer.line('private final String code;');
  writer.line('private final int status;');
  writer.blank();
  writer.line(`protected ${name}(String code, int status, String message) {`);
  writer.block(() => {
    writer.line('super(message);');
    writer.line('this.code = code;');
    writer.line('this.status = status;');
  });
  writer.line('}');
  writer.blank();
  writer.line('public String code() {');
  writer.block(() => writer.line('return this.code;'));
  writer.line('}');
  writer.blank();
  writer.line('public int status() {');
  writer.block(() => writer.line('return this.status;'));
  writer.line('}');
}

function constraintViolation(layout: JavaLayout): GeneratedFile {
  const writer = body();
  writer.line('/** Raised when a declared field constraint does not hold. */');
  writer.line('public class ConstraintViolation extends RuntimeException {');
  writer.blank();
  writer.block(() => {
    writer.line('public ConstraintViolation(String shape, String field, String rule) {');
    writer.block(() => writer.line('super(shape + "." + field + " violates " + rule);'));
    writer.line('}');
  });
  writer.line('}');
  return javaFile(layout.sharedPath('ConstraintViolation'), layout.sharedPackage, [], writer);
}

function invariantViolation(layout: JavaLayout): GeneratedFile {
  const writer = body();
  writer.line('/** Raised when a declared invariant does not hold. */');
  writer.line('public class InvariantViolation extends RuntimeException {');
  writer.blank();
  writer.block(() => {
    writer.line('public InvariantViolation(String shape, String rule) {');
    writer.block(() => writer.line('super(shape + ": " + rule);'));
    writer.line('}');
  });
  writer.line('}');
  return javaFile(layout.sharedPath('InvariantViolation'), layout.sharedPackage, [], writer);
}

/**
 * One generic helper covers every ordered type: boxing makes it work for
 * numbers, and Instant, LocalDate, Duration and BigDecimal are all Comparable.
 */
function ordering(layout: JavaLayout): GeneratedFile {
  const writer = body();
  writer.line('/** Ordering comparisons for every type HADL considers ordered. */');
  writer.line('public final class Ordering {');
  writer.blank();
  writer.block(() => {
    writer.line('private Ordering() {}');
    writer.blank();
    for (const [name, operator] of [['gt', '>'], ['ge', '>='], ['lt', '<'], ['le', '<=']] as const) {
      // The primitive overload wins for numbers, so `long` and `double` mix
      // without boxing them into incompatible Comparable bounds.
      writer.line(`public static boolean ${name}(double left, double right) {`);
      writer.block(() => writer.line(`return left ${operator} right;`));
      writer.line('}');
      writer.blank();
      writer.line(`public static <T extends Comparable<T>> boolean ${name}(T left, T right) {`);
      writer.block(() => writer.line(`return left.compareTo(right) ${operator} 0;`));
      writer.line('}');
      writer.blank();
    }
  });
  writer.line('}');
  return javaFile(layout.sharedPath('Ordering'), layout.sharedPackage, [], writer);
}

function domainEventPublisher(layout: JavaLayout): GeneratedFile {
  const writer = body();
  writer.line('/** Outbound port for domain events. The IaC layer wires a broker to it. */');
  writer.line('public interface DomainEventPublisher {');
  writer.blank();
  writer.block(() => writer.line('void publish(String topic, Object payload);'));
  writer.line('}');
  return javaFile(layout.sharedPath('DomainEventPublisher'), layout.sharedPackage, [], writer);
}

function loggingDomainEventPublisher(layout: JavaLayout): GeneratedFile {
  const writer = body();
  writer.line('/** Development implementation: logs instead of publishing. */');
  writer.line('@Component');
  writer.line('public class LoggingDomainEventPublisher implements DomainEventPublisher {');
  writer.blank();
  writer.block(() => {
    writer.line('private static final Logger LOG = LoggerFactory.getLogger(LoggingDomainEventPublisher.class);');
    writer.blank();
    writer.line('@Override');
    writer.line('public void publish(String topic, Object payload) {');
    writer.block(() => writer.line('LOG.info("domain event topic={} payload={}", topic, payload);'));
    writer.line('}');
  });
  writer.line('}');
  return javaFile(
    layout.sharedPath('LoggingDomainEventPublisher'),
    layout.sharedPackage,
    ['org.slf4j.Logger', 'org.slf4j.LoggerFactory', 'org.springframework.stereotype.Component'],
    writer,
  );
}

function globalExceptionHandler(layout: JavaLayout): GeneratedFile {
  const writer = body();
  writer.line('/** Turns domain exceptions into HTTP responses. */');
  writer.line('@RestControllerAdvice');
  writer.line('public class GlobalExceptionHandler {');
  writer.blank();
  writer.block(() => {
    writer.line('/** Each checked error carries its declared status, so new ones need no change here. */');
    writer.line('@ExceptionHandler(CheckedDomainException.class)');
    writer.line('public ResponseEntity<ErrorBody> onChecked(CheckedDomainException exception) {');
    writer.block(() =>
      writer.line('return ResponseEntity.status(exception.status()).body(new ErrorBody(exception.code(), exception.getMessage()));'),
    );
    writer.line('}');
    writer.blank();
    writer.line('@ExceptionHandler(UncheckedDomainException.class)');
    writer.line('public ResponseEntity<ErrorBody> onUnchecked(UncheckedDomainException exception) {');
    writer.block(() => writer.line('return ResponseEntity.status(500).body(new ErrorBody(exception.code(), exception.getMessage()));'));
    writer.line('}');
    writer.blank();
    writer.line('@ExceptionHandler({ConstraintViolation.class, InvariantViolation.class})');
    writer.line('public ResponseEntity<ErrorBody> onViolation(RuntimeException exception) {');
    writer.block(() => writer.line('return ResponseEntity.status(422).body(new ErrorBody("VALIDATION_FAILED", exception.getMessage()));'));
    writer.line('}');
    writer.blank();
    writer.line('public record ErrorBody(String code, String message) {}');
  });
  writer.line('}');
  return javaFile(
    layout.sharedPath('GlobalExceptionHandler'),
    layout.sharedPackage,
    [
      'org.springframework.http.ResponseEntity',
      'org.springframework.web.bind.annotation.ExceptionHandler',
      'org.springframework.web.bind.annotation.RestControllerAdvice',
    ],
    writer,
  );
}

function readme(context: GenerationContext): GeneratedFile {
  const root = layoutFor(context).packageRoot;
  const lines = [
    `# ${context.project.name}`,
    '',
    'Generated from HADL sources. Edit the `.hadl` files and recompile; everything here is overwritten.',
    '',
    '## Layout',
    '',
    `Package root: \`${root}\`.`,
    '',
    '| Package | Depends on | Holds |',
    '| --- | --- | --- |',
    '| `domain` | nothing | aggregates, entities, value objects, events, errors |',
    '| `application` | domain | ports and services |',
    '| `infrastructure` | application | adapters that implement outbound ports |',
    '| `interfaces` | application | REST controllers and event handlers |',
    '| `shared` | nothing | exception bases, validation, event publishing |',
    '',
    '## Bounded contexts',
    '',
    ...context.project.contexts.map((c) => `- **${c.name}** (${c.kind}): ${c.modules.join(', ')}`),
    '',
    '## Running',
    '',
    '```bash',
    'mvn -q compile',
    'mvn spring-boot:run',
    '```',
    '',
  ];
  return file('README.md', `${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

interface OperationOptions extends JavaEmitterOptions {
  annotateOverride?: boolean;
}

function emitOperation(writer: CodeWriter, index: ModuleIndex, operation: IROperation, options: OperationOptions): void {
  const emitter = operationEmitter(index, operation, options);
  signatureDoc(writer, operation);
  if (options.annotateOverride) writer.line('@Override');
  writer.line(
    `public ${emitter.typeName(operation.returns)} ${camelCase(operation.phrase)}(${parameters(operation, emitter)})${throwsClause(operation.throws, index)} {`,
  );
  writer.block(() => emitter.emitImplementation(writer, operation));
  writer.line('}');
}

/** A fresh emitter per operation: locals must not leak from one body into the next. */
function operationEmitter(index: ModuleIndex, operation: IROperationSignature, options: JavaEmitterOptions): JavaEmitter {
  const emitter = new JavaEmitter(index, options);
  for (const parameter of operation.parameters) emitter.declareLocal(parameter.name, parameter.type);
  return emitter;
}

function parameters(operation: IROperationSignature, emitter: JavaEmitter): string {
  return operation.parameters.map((p) => `${emitter.typeName(p.type)} ${fieldName(p.name)}`).join(', ');
}

function components(fields: readonly IRField[], emitter: JavaEmitter): string {
  return fields.map((field) => `${emitter.typeName(field.type)} ${fieldName(field.name)}`).join(', ');
}

/** Replacement expression for a field with a declared default, or `null` when there is none. */
function defaultedValue(field: IRField, emitter: JavaEmitter): string | null {
  const name = fieldName(field.name);
  const fallback = field.constraints.find((c) => c.kind === 'default');
  if (fallback && fallback.kind === 'default') {
    // A Java primitive is never absent, so a default only makes sense for reference types.
    return isNullable(field.type) ? `${name} != null ? ${name} : ${emitter.literal(fallback.value, field.type)}` : null;
  }
  if (field.type.kind === 'list') return `${name} != null ? ${name} : new java.util.ArrayList<>()`;
  return null;
}

function emitConstraintChecks(
  writer: CodeWriter,
  shape: string,
  fields: readonly IRField[],
  reference: (field: string) => string,
): void {
  for (const field of fields) {
    const name = fieldName(field.name);
    const access = reference(name);
    const fail = (rule: string): string => `throw new ConstraintViolation("${shape}", "${name}", "${rule}");`;

    // Presence first: every check below would dereference the field.
    if (field.required && !field.derived && field.type.kind !== 'optional' && isNullable(field.type)) {
      writer.line(`if (${access} == null) ${fail('required')}`);
    }
    for (const constraint of field.constraints) {
      switch (constraint.kind) {
        case 'min':
          writer.line(`if (${access} < ${constraint.value}) ${fail(`min ${constraint.value}`)}`);
          break;
        case 'max':
          writer.line(`if (${access} > ${constraint.value}) ${fail(`max ${constraint.value}`)}`);
          break;
        case 'min-length':
          writer.line(`if (${sizeOf(access, field.type)} < ${constraint.value}) ${fail(`min length ${constraint.value}`)}`);
          break;
        case 'max-length':
          writer.line(`if (${sizeOf(access, field.type)} > ${constraint.value}) ${fail(`max length ${constraint.value}`)}`);
          break;
        case 'length':
          writer.line(`if (${sizeOf(access, field.type)} != ${constraint.value}) ${fail(`length ${constraint.value}`)}`);
          break;
        case 'pattern':
          writer.line(`if (!${access}.matches(${JSON.stringify(constraint.value)})) ${fail('pattern')}`);
          break;
        default:
          break;
      }
    }
  }
}

function emitInvariantChecks(
  writer: CodeWriter,
  shape: string,
  invariants: readonly IRInvariant[],
  emitter: JavaEmitter,
): void {
  for (const invariant of invariants) {
    const condition = emitter.expression(invariant.condition);
    const raises = invariant.raises;
    const failure = raises
      ? `throw new ${pascalCase(raises)}();`
      : `throw new InvariantViolation("${shape}", ${JSON.stringify(invariant.description)});`;
    writer.line(`if (!(${condition})) ${failure}`);
  }
}

/** `"no order exists with id {orderId}"` becomes Java string concatenation. */
function messageExpression(message: string, fields: readonly IRField[]): string {
  const known = new Set(fields.map((f) => f.name));
  const pattern = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  const parts: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(message)) !== null) {
    if (!known.has(match[1]!)) continue;
    const text = message.slice(cursor, match.index);
    if (text.length > 0) parts.push(JSON.stringify(text));
    parts.push(fieldName(match[1]!));
    cursor = match.index + match[0].length;
  }
  const tail = message.slice(cursor);
  if (tail.length > 0 || parts.length === 0) parts.push(JSON.stringify(tail));
  if (!parts[0]!.startsWith('"')) parts.unshift('""');
  return parts.join(' + ');
}

function errorConstruction(index: ModuleIndex, errorName: string, value: string): string {
  const emitter = new JavaEmitter(index);
  const fields = fieldsOf(index.typed(errorName, 'error'));
  const args = fields.map((field, position) => (position === 0 ? value : emitter.defaultValue(field.type)));
  return `new ${pascalCase(errorName)}(${args.join(', ')})`;
}

/** `order.getId()` for a class, `order.id()` for a record. */
function readAccess(index: ModuleIndex, variable: string, type: IRType, field: string): string {
  const emitter = new JavaEmitter(index);
  emitter.declareLocal(variable, type);
  return emitter.member([variable, field]);
}

function identityAccess(index: ModuleIndex, parameter: IRParameter): string {
  const owner = namedTypeOf(parameter.type);
  const declaration = owner ? index.get(owner) : undefined;
  const identity = declaration && 'identity' in declaration ? (declaration.identity[0] ?? 'id') : 'id';
  return readAccess(index, parameter.name, parameter.type, identity);
}

/** Checked errors a body can raise: `fail` statements plus calls into throwing operations. */
function checkedErrors(statements: readonly IRStatement[], index: ModuleIndex): string[] {
  const found = new Set<string>();

  const inExpression = (expression: IRExpression): void => {
    switch (expression.kind) {
      case 'call':
        for (const name of index.resolvePhrase(expression.operation)[0]?.operation.throws ?? []) found.add(name);
        for (const argument of expression.arguments) inExpression(argument.value);
        break;
      case 'construct':
        for (const argument of expression.arguments) inExpression(argument.value);
        break;
      case 'binary':
        inExpression(expression.left);
        inExpression(expression.right);
        break;
      case 'unary':
        inExpression(expression.operand);
        break;
      case 'aggregate':
        inExpression(expression.collection);
        if (expression.of) inExpression(expression.of);
        break;
      default:
        break;
    }
  };

  const walk = (block: readonly IRStatement[]): void => {
    for (const statement of block) {
      switch (statement.kind) {
        case 'fail':
          found.add(statement.error);
          break;
        case 'let':
        case 'set':
        case 'perform':
        case 'append':
        case 'remove':
          inExpression(statement.value);
          break;
        case 'return':
          if (statement.value) inExpression(statement.value);
          break;
        case 'publish':
          for (const argument of statement.arguments) inExpression(argument.value);
          break;
        case 'when':
          inExpression(statement.condition);
          walk(statement.then);
          walk(statement.otherwise);
          break;
        case 'for-each':
          inExpression(statement.collection);
          walk(statement.body);
          break;
      }
    }
  };

  walk(statements);
  return [...found];
}

function throwsClause(names: readonly string[], index: ModuleIndex): string {
  const checked = [...new Set(names)].filter((name) => index.typed(name, 'error')?.checked === true);
  return checked.length > 0 ? ` throws ${checked.map(pascalCase).join(', ')}` : '';
}

/** The shape an adapter reads and writes, taken from the port it implements. */
function entityOf(port: IRPortDecl, index: ModuleIndex): string | null {
  for (const operation of port.operations) {
    const returned = namedTypeOf(operation.returns);
    if (returned && index.get(returned)) return returned;
    for (const parameter of operation.parameters) {
      const named = namedTypeOf(parameter.type);
      const declaration = named ? index.get(named) : undefined;
      if (declaration?.kind === 'aggregate' || declaration?.kind === 'entity') return named;
    }
  }
  return null;
}

function sqlTable(adapter: IRAdapterDecl, port: IRPortDecl): string {
  const table = adapter.config['table'] ?? tableName(port.name.replace(/(Repository|Store|Gateway|Adapter)$/, ''));
  const schema = adapter.config['schema'];
  return schema ? `${schema}.${table}` : String(table);
}

function pathVariables(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
}

function pathVariableType(
  variable: string,
  requestType: string | null,
  operation: IROperationSignature | undefined,
  index: ModuleIndex,
  emitter: JavaEmitter,
): string {
  const parameter = operation?.parameters.find((p) => camelCase(p.name) === camelCase(variable));
  if (parameter) return emitter.typeName(parameter.type);
  const field = requestType ? fieldsOf(index.get(requestType)).find((f) => camelCase(f.name) === camelCase(variable)) : undefined;
  return field ? emitter.typeName(field.type) : 'String';
}

function domainImports(layout: JavaLayout, module: IRModule, index: ModuleIndex): string[] {
  const declarations = [
    ...index.enums,
    ...index.valueObjects,
    ...index.entities,
    ...index.aggregates,
    ...index.commands,
    ...index.events,
    ...index.dtos,
    ...index.queries,
    ...index.errors,
  ];
  return declarations.map((declaration) => `${layout.package('domain', module)}.${pascalCase(declaration.name)}`);
}

function validationImports(layout: JavaLayout): string[] {
  return [
    `${layout.sharedPackage}.ConstraintViolation`,
    `${layout.sharedPackage}.InvariantViolation`,
    `${layout.sharedPackage}.Ordering`,
  ];
}

function portFieldsOf(names: readonly string[]): ReadonlyMap<string, string> {
  return new Map(names.map((name) => [name, fieldName(name)]));
}

function namedTypeOf(type: IRType): string | null {
  const inner = unwrap(type);
  return inner.kind === 'named' ? inner.name : null;
}

function isNullable(type: IRType): boolean {
  if (type.kind === 'optional') return true;
  return !(type.kind === 'primitive' && (type.name === 'integer' || type.name === 'decimal' || type.name === 'boolean'));
}

function sizeOf(access: string, type: IRType): string {
  const inner = type.kind === 'optional' ? type.of : type;
  return inner.kind === 'list' || inner.kind === 'set' || inner.kind === 'map' ? `${access}.size()` : `${access}.length()`;
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let suffix = 2;
  while (used.has(name)) name = `${base}${suffix++}`;
  used.add(name);
  return name;
}

/** Package segments are lowercase and unseparated: `order-management` -> `ordermanagement`. */
function packageSegment(name: string): string {
  return kebabCase(name).replace(/-/g, '');
}

function fieldName(name: string): string {
  return escapeReserved(camelCase(name), 'java');
}

function body(): CodeWriter {
  return new CodeWriter('    ');
}

/** Wraps a rendered type in its package header, keeping only the imports it mentions. */
function javaFile(path: string, packageName: string, imports: readonly string[], contents: CodeWriter): GeneratedFile {
  const rendered = contents.toString();
  const used = [...new Set(imports)].filter((name) => mentions(rendered, name.slice(name.lastIndexOf('.') + 1))).sort();

  const writer = new CodeWriter('    ');
  writer.line(`// ${GENERATED_BANNER}`);
  writer.blank();
  writer.line(`package ${packageName};`);
  if (used.length > 0) {
    writer.blank();
    for (const name of used) writer.line(`import ${name};`);
  }
  return file(path, `${writer.toString()}\n${rendered}`);
}

function mentions(text: string, simpleName: string): boolean {
  return new RegExp(`\\b${simpleName}\\b`).test(text);
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
