/**
 * Rust / Axum backend.
 *
 * Emits a hexagonal crate: domain structs carrying their own invariants, one
 * error enum per module, async traits for the ports, adapters that implement
 * them, and an Axum layer that turns each checked error into its declared
 * status. Errors travel as `Result`, never as unwinding panics.
 */
import {
  nativeFor,
  CodeWriter,
  GENERATED_BANNER,
  comment,
  file,
  indexModule,
  kebabCase,
  normalisePhrase,
  pascalCase,
  screamingSnakeCase,
  snakeCase,
  tableName,
  type CodeGenerator,
  type Diagnostic,
  type GenerationContext,
  type GeneratedFile,
  type GenerationResult,
  type IRAdapterDecl,
  type IREndpointDecl,
  type IRField,
  type IRInvariant,
  type IRModule,
  type IROperation,
  type IROperationSignature,
  type IRPortDecl,
  type IRStatement,
  type IRType,
  type ModuleIndex,
} from '@haic/core';
import { declaredImplementation, placeholderDiagnostic, placeholderMessage } from '../../shared/adapters.js';
import { ProjectLayout } from '../../shared/layout.js';
import { RustEmitter } from './emitter.js';

const layout = new ProjectLayout({ sourceRoot: 'src', extension: '.rs', directoryCase: snakeCase });

/** Rust spells the interface layer `interfaces`, and every directory owns a `mod.rs`. */
const LAYERS = ['domain', 'application', 'infrastructure', 'interfaces'] as const;
type RustLayer = (typeof LAYERS)[number];

export const rustGenerator: CodeGenerator = {
  id: 'rust',
  // Said here as well as in the README, because someone choosing a target from
  // `haic targets` never reads the README first.
  displayName: 'Rust (experimental — does not compile yet)',
  framework: 'Axum',
  verifyCommand: ['cargo', 'check'],

  generate(module, context) {
    const index = indexModule(module);
    const diagnostics: Diagnostic[] = [];
    const files = [
      enumsFile(module, index),
      valueObjectsFile(module, index),
      modelFile(module, index),
      errorsFile(module, index),
      messagesFile(module, index),
      portsFile(module, index),
      servicesFile(module, index),
      adaptersFile(module, index, diagnostics),
      routesFile(module, index),
      handlersFile(module, index),
    ].filter((f): f is GeneratedFile => f !== null);

    void context;
    return { files: [...files, ...moduleMods(module, files)], diagnostics };
  },

  generateProject(context) {
    return {
      files: [
        cargoToml(context),
        libFile(context),
        mainFile(context),
        ...layerMods(context),
        sharedMod(),
        sharedErrors(),
        sharedEvents(),
        sharedValidation(),
        dotEnvExample(context),
        readme(context),
      ],
      diagnostics: [],
    };
  },
};

// ---------------------------------------------------------------------------
// Domain layer
// ---------------------------------------------------------------------------

function enumsFile(module: IRModule, index: ModuleIndex): GeneratedFile | null {
  if (index.enums.length === 0) return null;
  const writer = banner();
  writeUses(writer, module, index, { serde: true });

  for (const declaration of index.enums) {
    docComment(writer, declaration.description);
    writer.line('#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]');
    writer.line(`pub enum ${pascalCase(declaration.name)} {`);
    writer.block(() => {
      for (const value of declaration.values) {
        docComment(writer, value.description);
        writer.line(`${value.name},`);
      }
    });
    writer.line('}');
    writer.blank();
  }
  return file(modulePath('domain', module, 'enums'), writer.toString());
}

function valueObjectsFile(module: IRModule, index: ModuleIndex): GeneratedFile | null {
  if (index.valueObjects.length === 0) return null;
  const writer = banner();
  writeUses(writer, module, index, { serde: true, enums: true, validation: true });

  const emitter = new RustEmitter(index, { errorEnum: errorEnum(module) });
  for (const declaration of index.valueObjects) {
    docComment(writer, declaration.description ?? `Value object ${declaration.name}. Compared by value, never by identity.`);
    writer.line('#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]');
    writer.line(`pub struct ${pascalCase(declaration.name)} {`);
    writer.block(() => writeFields(writer, declaration.fields, emitter));
    writer.line('}');
    writer.blank();

    writer.line(`impl ${pascalCase(declaration.name)} {`);
    writer.block(() => {
      writer.line('/// Builds a checked instance. Value objects are immutable once built.');
      writer.line(`pub fn new(${constructorParameters(declaration.fields, emitter)}) -> Result<Self, ValidationError> {`);
      writer.block(() => {
        writer.line(`let value = Self { ${declaration.fields.map((f) => emitter.identifier(f.name)).join(', ')} };`);
        writeConstraintChecks(writer, declaration.name, declaration.fields, 'value', emitter);
        writeInvariantChecks(writer, declaration.name, declaration.invariants, index, declaration.fields);
        writer.line('Ok(value)');
      });
      writer.line('}');
    });
    writer.line('}');
    writer.blank();
  }
  return file(modulePath('domain', module, 'value_objects'), writer.toString());
}

function modelFile(module: IRModule, index: ModuleIndex): GeneratedFile | null {
  const shapes = [...index.entities, ...index.aggregates];
  if (shapes.length === 0) return null;

  const writer = banner();
  writeUses(writer, module, index, { serde: true, enums: true, valueObjects: true, errors: true, validation: true });

  for (const declaration of shapes) {
    const kindLabel = declaration.kind === 'aggregate' ? 'Aggregate root' : 'Entity';
    const selfFields = new Set(declaration.fields.map((f) => f.name));
    const emitter = new RustEmitter(index, { errorEnum: errorEnum(module), selfFields });

    docComment(writer, declaration.description ?? `${kindLabel} ${declaration.name}, identified by ${declaration.identity.join(', ')}.`);
    writer.line('#[derive(Debug, Clone, Serialize, Deserialize)]');
    writer.line(`pub struct ${pascalCase(declaration.name)} {`);
    writer.block(() => writeFields(writer, declaration.fields, emitter));
    writer.line('}');
    writer.blank();

    writer.line(`impl ${pascalCase(declaration.name)} {`);
    writer.block(() => {
      writer.line('/// Re-checks every rule declared on this type. Call after any change.');
      writer.line('pub fn check_invariants(&self) -> Result<(), ValidationError> {');
      writer.block(() => {
        writeConstraintChecks(writer, declaration.name, declaration.fields, 'self', emitter);
        writeInvariantChecks(writer, declaration.name, declaration.invariants, index, declaration.fields);
        writer.line('Ok(())');
      });
      writer.line('}');

      const operations = declaration.kind === 'aggregate' ? declaration.operations : [];
      for (const operation of operations) {
        writer.blank();
        signatureDoc(writer, operation);
        const receiver = mutatesSelf(operation.body) || nativeFor(operation, 'rust') ? '&mut self' : '&self';
        const parameters = [receiver, ...operation.parameters.map((p) => `${emitter.identifier(p.name)}: ${emitter.typeName(p.type)}`)];
        writer.line(`pub fn ${emitter.methodName(operation.phrase)}(${parameters.join(', ')}) -> ${emitter.resultType(operation.returns)} {`);
        writer.block(() => emitter.emitOperationImplementation(writer, operation, true));
        writer.line('}');
      }
    });
    writer.line('}');
    writer.blank();
  }
  return file(modulePath('domain', module, 'model'), writer.toString());
}

/**
 * One enum per module. Checked errors become variants carrying their declared
 * fields; unchecked ones stay out because they abort instead of being handled.
 */
function errorsFile(module: IRModule, index: ModuleIndex): GeneratedFile {
  const writer = banner();
  writeUses(writer, module, index, { enums: true, valueObjects: true, validation: true, domainError: true });

  const emitter = new RustEmitter(index, { errorEnum: errorEnum(module) });
  const checked = index.errors.filter((e) => e.checked);
  const name = errorEnum(module);

  docComment(writer, `Every checked error the ${module.name} module can return.`);
  writer.line('#[derive(Debug, thiserror::Error)]');
  writer.line(`pub enum ${name} {`);
  writer.block(() => {
    for (const declaration of checked) {
      docComment(writer, declaration.description);
      writer.line(`#[error(${quote(messageTemplate(declaration.message, declaration.fields))})]`);
      if (declaration.fields.length === 0) writer.line(`${pascalCase(declaration.name)},`);
      else {
        writer.line(`${pascalCase(declaration.name)} {`);
        writer.block(() => writeFields(writer, declaration.fields, emitter, ''));
        writer.line('},');
      }
    }
    writer.line('/// A declared constraint or invariant did not hold.');
    writer.line('#[error(transparent)]');
    writer.line('Validation(#[from] ValidationError),');
    writer.line('/// Anything the surrounding infrastructure failed at.');
    writer.line('#[error("unexpected failure: {0}")]');
    writer.line('Unexpected(String),');
  });
  writer.line('}');
  writer.blank();

  writer.line(`impl ${name} {`);
  writer.block(() => {
    writer.line('/// HTTP status declared for this error in the .hadl source.');
    writer.line('pub fn status(&self) -> u16 {');
    writer.block(() => {
      writer.line('match self {');
      writer.block(() => {
        for (const declaration of checked) {
          writer.line(`${variantPattern(declaration.name, declaration.fields.length)} => ${declaration.status ?? 400},`);
        }
        writer.line('Self::Validation(_) => 422,');
        writer.line('Self::Unexpected(_) => 500,');
      });
      writer.line('}');
    });
    writer.line('}');
    writer.blank();
    writer.line('/// Stable machine-readable code, mirroring the HADL error name.');
    writer.line('pub fn code(&self) -> &\'static str {');
    writer.block(() => {
      writer.line('match self {');
      writer.block(() => {
        for (const declaration of checked) {
          writer.line(`${variantPattern(declaration.name, declaration.fields.length)} => "${screamingSnakeCase(declaration.name)}",`);
        }
        writer.line('Self::Validation(_) => "VALIDATION_FAILED",');
        writer.line('Self::Unexpected(_) => "UNEXPECTED",');
      });
      writer.line('}');
    });
    writer.line('}');
  });
  writer.line('}');
  writer.blank();

  writer.line(`impl DomainError for ${name} {`);
  writer.block(() => {
    writer.line(`fn status(&self) -> u16 {`);
    writer.block(() => writer.line(`${name}::status(self)`));
    writer.line('}');
    writer.blank();
    writer.line(`fn code(&self) -> &'static str {`);
    writer.block(() => writer.line(`${name}::code(self)`));
    writer.line('}');
  });
  writer.line('}');

  const unchecked = index.errors.filter((e) => !e.checked);
  if (unchecked.length > 0) {
    writer.blank();
    writer.lines_(comment(`Unchecked in the .hadl source, so they panic instead of joining this enum: ${unchecked.map((e) => e.name).join(', ')}.`));
  }
  return file(modulePath('domain', module, 'errors'), writer.toString());
}

function messagesFile(module: IRModule, index: ModuleIndex): GeneratedFile | null {
  const shapes = [...index.commands, ...index.events, ...index.dtos, ...index.queries];
  if (shapes.length === 0) return null;

  const writer = banner();
  writeUses(writer, module, index, { serde: true, enums: true, valueObjects: true });

  const emitter = new RustEmitter(index, { errorEnum: errorEnum(module) });
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
    writer.line('#[derive(Debug, Clone, Serialize, Deserialize)]');
    writer.line(`pub struct ${pascalCase(declaration.name)} {`);
    writer.block(() => writeFields(writer, declaration.fields, emitter));
    writer.line('}');
    writer.blank();
    if (declaration.kind === 'event') {
      writer.line(`pub const ${screamingSnakeCase(declaration.name)}_TOPIC: &str = "${declaration.topic ?? kebabCase(declaration.name)}";`);
      writer.blank();
    }
  }
  return file(modulePath('domain', module, 'messages'), writer.toString());
}

// ---------------------------------------------------------------------------
// Application layer
// ---------------------------------------------------------------------------

function portsFile(module: IRModule, index: ModuleIndex): GeneratedFile | null {
  if (index.ports.length === 0) return null;
  const writer = banner();
  writeUses(writer, module, index, { enums: true, valueObjects: true, model: true, messages: true, errors: true });

  const emitter = new RustEmitter(index, { errorEnum: errorEnum(module) });
  for (const port of index.ports) {
    docComment(
      writer,
      port.description ??
        (port.direction === 'inbound'
          ? 'Inbound port: a use case the outside world can drive.'
          : 'Outbound port: something the domain drives. Implemented by an adapter.'),
    );
    writer.line('#[async_trait::async_trait]');
    writer.line(`pub trait ${pascalCase(port.name)}: Send + Sync {`);
    writer.block(() => {
      port.operations.forEach((operation, position) => {
        if (position > 0) writer.blank();
        signatureDoc(writer, operation);
        writer.line(`async fn ${signature(operation, emitter)};`);
      });
    });
    writer.line('}');
    writer.blank();
  }
  return file(modulePath('application', module, 'ports'), writer.toString());
}

function servicesFile(module: IRModule, index: ModuleIndex): GeneratedFile | null {
  if (index.services.length === 0) return null;
  const writer = banner();
  writeUses(writer, module, index, {
    enums: true,
    valueObjects: true,
    model: true,
    messages: true,
    errors: true,
    ports: true,
    events: true,
    arc: true,
  });

  for (const service of index.services) {
    const portFields = new Map(service.uses.map((name) => [name, snakeCase(name)]));
    const emitter = new RustEmitter(index, { errorEnum: errorEnum(module), portFields });

    docComment(writer, service.description ?? `Application service ${service.name}.`);
    writer.line(`pub struct ${pascalCase(service.name)} {`);
    writer.block(() => {
      for (const name of service.uses) writer.line(`${snakeCase(name)}: Arc<dyn ${pascalCase(name)}>,`);
      writer.line('event_publisher: Arc<dyn EventPublisher>,');
    });
    writer.line('}');
    writer.blank();

    writer.line(`impl ${pascalCase(service.name)} {`);
    writer.block(() => {
      const injected = [
        ...service.uses.map((name) => `${snakeCase(name)}: Arc<dyn ${pascalCase(name)}>`),
        'event_publisher: Arc<dyn EventPublisher>',
      ];
      writer.line(`pub fn new(${injected.join(', ')}) -> Self {`);
      writer.block(() => writer.line(`Self { ${[...service.uses.map((n) => snakeCase(n)), 'event_publisher'].join(', ')} }`));
      writer.line('}');

      for (const operation of service.operations) {
        writer.blank();
        signatureDoc(writer, operation);
        writer.line(`pub async fn ${signature(operation, emitter)} {`);
        writer.block(() => emitter.emitOperationImplementation(writer, operation, true));
        writer.line('}');
      }
    });
    writer.line('}');
    writer.blank();

    const port = service.implements ? index.typed(service.implements, 'port') : undefined;
    if (port) {
      writer.line('#[async_trait::async_trait]');
      writer.line(`impl ${pascalCase(port.name)} for ${pascalCase(service.name)} {`);
      writer.block(() => {
        port.operations.forEach((operation, position) => {
          if (position > 0) writer.blank();
          const own = service.operations.find((o) => normalisePhrase(o.phrase) === normalisePhrase(operation.phrase));
          writer.line(`async fn ${signature(operation, emitter)} {`);
          writer.block(() => {
            if (own) {
              const args = operation.parameters.map((p) => emitter.identifier(p.name));
              writer.line(`${pascalCase(service.name)}::${emitter.methodName(operation.phrase)}(self${args.map((a) => `, ${a}`).join('')}).await`);
            } else {
              writer.line(`unimplemented!("${operation.phrase} has no generated implementation; write it here")`);
            }
          });
          writer.line('}');
        });
      });
      writer.line('}');
      writer.blank();
    }
  }
  return file(modulePath('application', module, 'services'), writer.toString());
}

// ---------------------------------------------------------------------------
// Infrastructure layer
// ---------------------------------------------------------------------------

function adaptersFile(module: IRModule, index: ModuleIndex, diagnostics: Diagnostic[]): GeneratedFile | null {
  if (index.adapters.length === 0) return null;
  const writer = banner();
  writeUses(writer, module, index, {
    enums: true,
    valueObjects: true,
    model: true,
    messages: true,
    errors: true,
    ports: true,
    sqlx: index.adapters.some((a) => a.technology === 'sql'),
  });

  const emitter = new RustEmitter(index, { errorEnum: errorEnum(module) });
  for (const adapter of index.adapters) {
    const port = index.typed(adapter.implements, 'port');
    if (!port) continue;
    const name = pascalCase(adapter.name);

    docComment(writer, adapter.description ?? `${adapter.technology} adapter for ${port.name}.`);
    if (adapter.technology === 'sql') writeSqlStruct(writer, name, adapter, port, module);
    else if (adapter.technology === 'in-memory') writeInMemoryStruct(writer, name, port, index, emitter);
    else {
      writer.line(`pub struct ${name};`);
      writer.blank();
    }

    writer.line('#[async_trait::async_trait]');
    writer.line(`impl ${pascalCase(port.name)} for ${name} {`);
    writer.block(() => {
      port.operations.forEach((operation, position) => {
        if (position > 0) writer.blank();
        signatureDoc(writer, operation);
        writer.line(`async fn ${signature(operation, emitter)} {`);
        writer.block(() => {
          const declared = declaredImplementation(adapter, operation.phrase);
          if (declared) emitter.emitOperationImplementation(writer, declared, true);
          else if (!writeAdapterBody(writer, adapter, operation, index, emitter)) {
            diagnostics.push(placeholderDiagnostic(adapter, operation.phrase, 'rust'));
          }
        });
        writer.line('}');
      });
    });
    writer.line('}');
    writer.blank();
  }
  return file(modulePath('infrastructure', module, 'adapters'), writer.toString());
}

function writeSqlStruct(writer: CodeWriter, name: string, adapter: IRAdapterDecl, port: IRPortDecl, module: IRModule): void {
  const table = String(adapter.config['table'] ?? tableName(guessEntity(port.name)));
  const schema = adapter.config['schema'];
  writer.line(`pub struct ${name} {`);
  writer.block(() => writer.line('pool: sqlx::PgPool,'));
  writer.line('}');
  writer.blank();
  writer.line(`impl ${name} {`);
  writer.block(() => {
    writer.line(`const TABLE: &'static str = "${schema ? `${String(schema)}.` : ''}${table}";`);
    writer.blank();
    writer.line('pub fn new(pool: sqlx::PgPool) -> Self {');
    writer.block(() => writer.line('Self { pool }'));
    writer.line('}');
    writer.blank();
    writer.line('/// Driver failures are infrastructure noise, not part of the domain contract.');
    writer.line(`fn failed(error: sqlx::Error) -> ${errorEnum(module)} {`);
    writer.block(() => writer.line(`${errorEnum(module)}::Unexpected(error.to_string())`));
    writer.line('}');
  });
  writer.line('}');
  writer.blank();
}

function writeInMemoryStruct(writer: CodeWriter, name: string, port: IRPortDecl, index: ModuleIndex, emitter: RustEmitter): void {
  const stored = storedType(port, index, emitter);
  writer.line(`pub struct ${name} {`);
  writer.block(() => writer.line(`rows: tokio::sync::RwLock<std::collections::HashMap<String, ${stored}>>,`));
  writer.line('}');
  writer.blank();
  writer.line(`impl ${name} {`);
  writer.block(() => {
    writer.line('pub fn new() -> Self {');
    writer.block(() => writer.line('Self { rows: tokio::sync::RwLock::new(std::collections::HashMap::new()) }'));
    writer.line('}');
  });
  writer.line('}');
  writer.blank();
  writer.line(`impl Default for ${name} {`);
  writer.block(() => {
    writer.line('fn default() -> Self {');
    writer.block(() => writer.line('Self::new()'));
    writer.line('}');
  });
  writer.line('}');
  writer.blank();
}

/** Recognised repository phrases get a real implementation; anything else is left to the author. */
function writeAdapterBody(
  writer: CodeWriter,
  adapter: IRAdapterDecl,
  operation: IROperationSignature,
  index: ModuleIndex,
  emitter: RustEmitter,
): boolean {
  const phrase = normalisePhrase(operation.phrase);
  const first = operation.parameters[0];
  const argument = first ? emitter.identifier(first.name) : 'id';
  const failure = notFoundExpression(operation, index, emitter, argument);
  const element = elementName(emitter.typeName(emitter.okType(operation.returns)));

  if (adapter.technology === 'sql') {
    if (/^(find|get|read|load)\b.*\bby id$/.test(phrase)) {
      writer.line('let sql = format!("SELECT data FROM {} WHERE id = $1", Self::TABLE);');
      writer.line(`let row = sqlx::query(&sql).bind(${argument}).fetch_optional(&self.pool).await.map_err(Self::failed)?;`);
      writer.line('let Some(row) = row else {');
      writer.block(() => writer.line(`return ${failure};`));
      writer.line('};');
      writer.line('let data: serde_json::Value = row.try_get("data").map_err(Self::failed)?;');
      writer.line(`serde_json::from_value(data).map_err(|error| ${emitter.errorEnum}::Unexpected(error.to_string()))`);
      return true;
    }
    if (/^(save|store|persist|upsert)\b/.test(phrase)) {
      writer.line(`let data = serde_json::to_value(&${argument}).map_err(|error| ${emitter.errorEnum}::Unexpected(error.to_string()))?;`);
      writer.line('let sql = format!(');
      writer.block(() => {
        writer.line('"INSERT INTO {} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",');
        writer.line('Self::TABLE,');
      });
      writer.line(');');
      writer.line(`sqlx::query(&sql).bind(${argument}.${identityOf(operation, index, emitter)}).bind(data).execute(&self.pool).await.map_err(Self::failed)?;`);
      writer.line('Ok(())');
      return true;
    }
    if (/^(list|find all|search)\b/.test(phrase)) {
      if (first) {
        writer.line(`let sql = format!("SELECT data FROM {} WHERE ${argument} = $1", Self::TABLE);`);
        writer.line(`let rows = sqlx::query(&sql).bind(${argument}).fetch_all(&self.pool).await.map_err(Self::failed)?;`);
      } else {
        writer.line('let sql = format!("SELECT data FROM {}", Self::TABLE);');
        writer.line('let rows = sqlx::query(&sql).fetch_all(&self.pool).await.map_err(Self::failed)?;');
      }
      writer.line(`let mut found: Vec<${element}> = Vec::with_capacity(rows.len());`);
      writer.line('for row in &rows {');
      writer.block(() => {
        writer.line('let data: serde_json::Value = row.try_get("data").map_err(Self::failed)?;');
        writer.line(`found.push(serde_json::from_value(data).map_err(|error| ${emitter.errorEnum}::Unexpected(error.to_string()))?);`);
      });
      writer.line('}');
      writer.line('Ok(found)');
      return true;
    }
    if (/^(delete|remove)\b.*\bby id$/.test(phrase)) {
      writer.line('let sql = format!("DELETE FROM {} WHERE id = $1", Self::TABLE);');
      writer.line(`sqlx::query(&sql).bind(${argument}).execute(&self.pool).await.map_err(Self::failed)?;`);
      writer.line('Ok(())');
      return true;
    }
  }

  if (adapter.technology === 'in-memory') {
    if (/^(find|get|read|load)\b.*\bby id$/.test(phrase)) {
      writer.line('let rows = self.rows.read().await;');
      writer.line(`match rows.get(&${argument}.to_string()) {`);
      writer.block(() => {
        writer.line('Some(found) => Ok(found.clone()),');
        writer.line(`None => ${failure},`);
      });
      writer.line('}');
      return true;
    }
    if (/^(save|store|persist|upsert)\b/.test(phrase)) {
      writer.line('let mut rows = self.rows.write().await;');
      writer.line(`rows.insert(${argument}.${identityOf(operation, index, emitter)}.to_string(), ${argument});`);
      writer.line('Ok(())');
      return true;
    }
    if (/^(list|find all|search)\b/.test(phrase)) {
      writer.line('let rows = self.rows.read().await;');
      writer.line('Ok(rows.values().cloned().collect())');
      return true;
    }
    if (/^(delete|remove)\b.*\bby id$/.test(phrase)) {
      writer.line('let mut rows = self.rows.write().await;');
      writer.line(`rows.remove(&${argument}.to_string());`);
      writer.line('Ok(())');
      return true;
    }
  }

  writer.line(`unimplemented!("${placeholderMessage(operation.phrase, adapter.technology)}")`);
  return false;
}

// ---------------------------------------------------------------------------
// Interfaces layer
// ---------------------------------------------------------------------------

function routesFile(module: IRModule, index: ModuleIndex): GeneratedFile | null {
  if (index.endpoints.length === 0) return null;
  const writer = banner();
  const methods = [...new Set(index.endpoints.map((e) => e.method.toLowerCase()))].sort();
  writer.line('use axum::extract::{Path, State};');
  writer.line('use axum::response::IntoResponse;');
  writer.line(`use axum::routing::{${methods.join(', ')}};`);
  writer.line('use axum::{Json, Router};');
  writeUses(writer, module, index, { enums: true, valueObjects: true, model: true, messages: true, errors: true, services: true, arc: true });

  const emitter = new RustEmitter(index, { errorEnum: errorEnum(module) });
  const services = [...new Set(index.endpoints.map((e) => e.handler.service))];

  docComment(writer, `Services the ${module.name} routes resolve their handlers against.`);
  writer.line('#[derive(Clone)]');
  writer.line('pub struct AppState {');
  writer.block(() => {
    for (const name of services) writer.line(`pub ${snakeCase(name)}: Arc<${pascalCase(name)}>,`);
  });
  writer.line('}');
  writer.blank();

  writer.line('/// Checked errors answer with the status declared in the .hadl source.');
  writer.line(`impl IntoResponse for ${errorEnum(module)} {`);
  writer.block(() => {
    writer.line('fn into_response(self) -> axum::response::Response {');
    writer.block(() => {
      writer.line('let status = axum::http::StatusCode::from_u16(self.status())');
      writer.block(() => writer.line('.unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR);'));
      writer.line('let body = Json(serde_json::json!({ "code": self.code(), "message": self.to_string() }));');
      writer.line('(status, body).into_response()');
    });
    writer.line('}');
  });
  writer.line('}');
  writer.blank();

  for (const endpoint of index.endpoints) writeHandlerFn(writer, endpoint, module, index, emitter);

  writer.line('/// Mounts every endpoint declared in this module.');
  writer.line('pub fn routes(state: AppState) -> Router {');
  writer.block(() => {
    writer.line('Router::new()');
    writer.block(() => {
      for (const endpoint of index.endpoints) {
        writer.line(`.route("${axumPath(endpoint.path)}", ${endpoint.method.toLowerCase()}(${snakeCase(endpoint.name)}))`);
      }
      writer.line('.with_state(state)');
    });
  });
  writer.line('}');
  return file(modulePath('interfaces', module, 'routes'), writer.toString());
}

function writeHandlerFn(writer: CodeWriter, endpoint: IREndpointDecl, module: IRModule, index: ModuleIndex, emitter: RustEmitter): void {
  const service = index.typed(endpoint.handler.service, 'service');
  const operation = service?.operations.find((o) => normalisePhrase(o.phrase) === normalisePhrase(endpoint.handler.operation));
  const params = pathParameters(endpoint, operation, emitter);
  const request = endpoint.request && endpoint.request.kind === 'named' ? pascalCase(endpoint.request.name) : null;
  const bodyParameter = operation?.parameters.find(
    (p) => p.type.kind === 'named' && endpoint.request?.kind === 'named' && p.type.name === endpoint.request.name,
  );
  const bodyBinding = bodyParameter ? emitter.identifier(bodyParameter.name) : 'body';
  const success = endpoint.responses.find((r) => r.status < 400);

  writer.line(`/// ${endpoint.method} ${endpoint.path}${endpoint.auth !== 'none' ? ` (${endpoint.auth})` : ''}`);
  writer.line(`async fn ${snakeCase(endpoint.name)}(`);
  writer.block(() => {
    writer.line('State(state): State<AppState>,');
    if (params.length === 1) writer.line(`Path(${params[0]!.binding}): Path<${params[0]!.type}>,`);
    else if (params.length > 1) {
      writer.line(`Path((${params.map((p) => p.binding).join(', ')})): Path<(${params.map((p) => p.type).join(', ')})>,`);
    }
    // Axum requires the body extractor last.
    if (request) writer.line(`Json(${bodyBinding}): Json<${request}>,`);
  });
  writer.line(`) -> Result<axum::response::Response, ${errorEnum(module)}> {`);
  writer.block(() => {
    const args = (operation?.parameters ?? []).map((parameter) => {
      if (bodyParameter && parameter.name === bodyParameter.name) return bodyBinding;
      const match = params.find((p) => p.name === emitter.identifier(parameter.name));
      return match && !match.binding.startsWith('_') ? match.binding : 'Default::default()';
    });
    const call = `state.${snakeCase(endpoint.handler.service)}.${emitter.methodName(endpoint.handler.operation)}(${args.join(', ')}).await?`;
    if (success?.body) {
      writer.line(`let result = ${call};`);
      writer.line(`Ok((${statusCode(success.status)}, Json(result)).into_response())`);
    } else {
      writer.line(`${call};`);
      writer.line(`Ok(${statusCode(success?.status ?? 204)}.into_response())`);
    }
  });
  writer.line('}');
  writer.blank();
}

function handlersFile(module: IRModule, index: ModuleIndex): GeneratedFile | null {
  if (index.handlers.length === 0) return null;
  const writer = banner();
  writeUses(writer, module, index, {
    enums: true,
    valueObjects: true,
    model: true,
    messages: true,
    errors: true,
    ports: true,
    events: true,
    arc: true,
  });

  for (const handler of index.handlers) {
    const portFields = new Map(handler.uses.map((name) => [name, snakeCase(name)]));
    const emitter = new RustEmitter(index, { errorEnum: errorEnum(module), portFields });
    const payload = index.get(handler.on);
    const payloadType = payload && 'fields' in payload ? pascalCase(payload.name) : 'serde_json::Value';

    docComment(writer, handler.description ?? `Reacts to ${handler.on}. Delivery: ${handler.delivery}, up to ${handler.retries} retries.`);
    writer.line(`pub struct ${pascalCase(handler.name)} {`);
    writer.block(() => {
      for (const name of handler.uses) writer.line(`${snakeCase(name)}: Arc<dyn ${pascalCase(name)}>,`);
      writer.line('event_publisher: Arc<dyn EventPublisher>,');
    });
    writer.line('}');
    writer.blank();

    writer.line(`impl ${pascalCase(handler.name)} {`);
    writer.block(() => {
      writer.line(`pub const TRIGGER: &'static str = "${handler.on}";`);
      writer.line(`pub const RETRIES: u32 = ${handler.retries};`);
      writer.blank();
      const injected = [
        ...handler.uses.map((name) => `${snakeCase(name)}: Arc<dyn ${pascalCase(name)}>`),
        'event_publisher: Arc<dyn EventPublisher>',
      ];
      writer.line(`pub fn new(${injected.join(', ')}) -> Self {`);
      writer.block(() => writer.line(`Self { ${[...handler.uses.map((n) => snakeCase(n)), 'event_publisher'].join(', ')} }`));
      writer.line('}');
      writer.blank();
      writer.line(`pub async fn handle(&self, event: ${payloadType}) -> Result<(), ${errorEnum(module)}> {`);
      writer.block(() => emitter.emitOperationBody(writer, handler.body, { kind: 'primitive', name: 'nothing' }, true));
      writer.line('}');
    });
    writer.line('}');
    writer.blank();
  }
  return file(modulePath('interfaces', module, 'handlers'), writer.toString());
}

// ---------------------------------------------------------------------------
// Module trees
// ---------------------------------------------------------------------------

/** One `mod.rs` per layer directory of this module, re-exporting what was emitted. */
function moduleMods(module: IRModule, files: readonly GeneratedFile[]): GeneratedFile[] {
  return LAYERS.map((layer) => {
    const prefix = `src/${layer}/${snakeCase(module.name)}/`;
    const children = files
      .filter((f) => f.path.startsWith(prefix))
      .map((f) => f.path.slice(prefix.length).replace(/\.rs$/, ''))
      .sort();

    const writer = banner();
    if (children.length === 0) writer.line(`// no ${layer} code declared for this module.`);
    else {
      for (const child of children) writer.line(`pub mod ${child};`);
      writer.blank();
      for (const child of children) writer.line(`pub use ${child}::*;`);
    }
    return file(`${prefix}mod.rs`, writer.toString());
  });
}

function layerMods(context: GenerationContext): GeneratedFile[] {
  return LAYERS.map((layer) => {
    const writer = banner();
    for (const module of context.project.modules) writer.line(`pub mod ${snakeCase(module.name)};`);
    return file(`src/${layer}/mod.rs`, writer.toString());
  });
}

// ---------------------------------------------------------------------------
// Project-level files
// ---------------------------------------------------------------------------

function cargoToml(context: GenerationContext): GeneratedFile {
  const crate = snakeCase(context.project.name);
  const lines = [
    `# ${GENERATED_BANNER}`,
    '',
    '[package]',
    `name = "${crate}"`,
    'version = "0.1.0"',
    'edition = "2021"',
    '',
    '[lib]',
    `name = "${crate}"`,
    'path = "src/lib.rs"',
    '',
    '[[bin]]',
    `name = "${crate}"`,
    'path = "src/main.rs"',
    '',
    '[dependencies]',
    'axum = "0.8"',
    'tokio = { version = "1", features = ["full"] }',
    'serde = { version = "1", features = ["derive"] }',
    'serde_json = "1"',
    'thiserror = "2"',
    'async-trait = "0.1"',
    'uuid = { version = "1", features = ["v4", "serde"] }',
    'chrono = { version = "0.4", features = ["serde"] }',
    'sqlx = { version = "0.8", features = ["runtime-tokio", "postgres", "uuid", "chrono", "json"] }',
    'rust_decimal = { version = "1", features = ["serde"] }',
    '',
  ];
  return file(layout.rootPath('Cargo.toml'), `${lines.join('\n')}\n`);
}

function libFile(context: GenerationContext): GeneratedFile {
  const writer = banner();
  for (const layer of LAYERS) writer.line(`pub mod ${layer};`);
  writer.line('pub mod shared;');
  void context;
  return file(layout.entryPoint('lib'), writer.toString());
}

function mainFile(context: GenerationContext): GeneratedFile {
  const writer = banner();
  const crate = snakeCase(context.project.name);
  const port = context.project.modules.find((m) => m.infrastructure)?.infrastructure?.port ?? 8080;
  const routed = context.project.modules.filter((m) => indexModule(m).endpoints.length > 0);

  writer.line('use axum::Router;');
  writer.blank();
  writer.line('#[tokio::main]');
  writer.line('async fn main() {');
  writer.block(() => {
    writer.line(`let port: u16 = std::env::var("PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(${port});`);
    writer.blank();
    writer.line('// Wire your adapters here, then merge each module router.');
    for (const module of routed) {
      writer.line(`// use ${crate}::interfaces::${snakeCase(module.name)}::routes::{routes, AppState};`);
      writer.line(`// let app = app.merge(routes(AppState { /* services */ }));`);
    }
    writer.line('let app = Router::new().route("/health", axum::routing::get(|| async { "ok" }));');
    writer.blank();
    writer.line('let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.expect("failed to bind");');
    writer.line('println!("listening on {port}");');
    writer.line('axum::serve(listener, app).await.expect("server stopped");');
  });
  writer.line('}');
  return file(layout.entryPoint('main'), writer.toString());
}

function sharedMod(): GeneratedFile {
  const writer = banner();
  writer.line('pub mod errors;');
  writer.line('pub mod events;');
  writer.line('pub mod validation;');
  return file(layout.sharedPath('mod'), writer.toString());
}

function sharedErrors(): GeneratedFile {
  const writer = banner();
  writer.lines_(
    comment(
      'Every module owns an error enum. This trait is the little that the HTTP and messaging layers need to know about all of them, so those layers stay independent of any single module.',
      '/// ',
    ),
  );
  writer.line('pub trait DomainError {');
  writer.block(() => {
    writer.line('/// HTTP status declared for the error in the .hadl source.');
    writer.line('fn status(&self) -> u16;');
    writer.line('/// Stable machine-readable code, mirroring the HADL error name.');
    writer.line("fn code(&self) -> &'static str;");
  });
  writer.line('}');
  return file(layout.sharedPath('errors'), writer.toString());
}

function sharedEvents(): GeneratedFile {
  const writer = banner();
  writer.line('/// Outbound port for domain events. The IaC layer wires a broker to it.');
  writer.line('#[async_trait::async_trait]');
  writer.line('pub trait EventPublisher: Send + Sync {');
  writer.block(() => writer.line('async fn publish(&self, topic: &str, payload: serde_json::Value);'));
  writer.line('}');
  writer.blank();
  writer.line('/// Development implementation: prints instead of publishing.');
  writer.line('pub struct ConsoleEventPublisher;');
  writer.blank();
  writer.line('#[async_trait::async_trait]');
  writer.line('impl EventPublisher for ConsoleEventPublisher {');
  writer.block(() => {
    writer.line('async fn publish(&self, topic: &str, payload: serde_json::Value) {');
    writer.block(() => writer.line('println!("{}", serde_json::json!({ "topic": topic, "payload": payload }));'));
    writer.line('}');
  });
  writer.line('}');
  return file(layout.sharedPath('events'), writer.toString());
}

function sharedValidation(): GeneratedFile {
  const writer = banner();
  writer.line('/// Raised when a declared constraint or invariant does not hold.');
  writer.line('#[derive(Debug, Clone, PartialEq, thiserror::Error)]');
  writer.line('pub enum ValidationError {');
  writer.block(() => {
    writer.line('#[error("{shape}.{field} violates {rule}")]');
    writer.line('Constraint { shape: String, field: String, rule: String },');
    writer.line('#[error("{shape}: {rule}")]');
    writer.line('Invariant { shape: String, rule: String },');
  });
  writer.line('}');
  writer.blank();
  writer.line('impl ValidationError {');
  writer.block(() => {
    writer.line('pub fn constraint(shape: &str, field: &str, rule: &str) -> Self {');
    writer.block(() =>
      writer.line('Self::Constraint { shape: shape.to_string(), field: field.to_string(), rule: rule.to_string() }'),
    );
    writer.line('}');
    writer.blank();
    writer.line('pub fn invariant(shape: &str, rule: &str) -> Self {');
    writer.block(() => writer.line('Self::Invariant { shape: shape.to_string(), rule: rule.to_string() }'));
    writer.line('}');
  });
  writer.line('}');
  return file(layout.sharedPath('validation'), writer.toString());
}

function dotEnvExample(context: GenerationContext): GeneratedFile {
  const lines = ['# Generated from the infrastructure blocks of the .hadl sources.'];
  for (const module of context.project.modules) {
    const infrastructure = module.infrastructure;
    if (!infrastructure) continue;
    lines.push('', `# ${module.name}`);
    lines.push(`PORT=${infrastructure.port}`);
    lines.push(`RUST_LOG=${infrastructure.observability.logLevel}`);
    for (const [key, value] of Object.entries(infrastructure.environment)) lines.push(`${key}=${value}`);
    for (const secret of infrastructure.secrets) lines.push(`${secret}=`);
    for (const database of infrastructure.databases) {
      lines.push(`${screamingSnakeCase(database.name)}_URL=${database.engine}://localhost/${database.name}`);
    }
    for (const broker of infrastructure.brokers) lines.push(`${screamingSnakeCase(broker.name)}_BROKER_URL=`);
  }
  return file('.env.example', `${lines.join('\n')}\n`);
}

function readme(context: GenerationContext): GeneratedFile {
  const crate = snakeCase(context.project.name);
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
    '| `src/application` | domain | port traits and services |',
    '| `src/infrastructure` | application | adapters that implement outbound ports |',
    '| `src/interfaces` | application | Axum routes and message handlers |',
    '| `src/shared` | nothing | validation, event publishing, the `DomainError` trait |',
    '',
    '## Errors',
    '',
    'Checked errors are variants of a per-module `thiserror` enum and travel as `Result`.',
    'Unchecked errors are defects, so they `panic!`.',
    '',
    '## Bounded contexts',
    '',
    ...context.project.contexts.map((c) => `- **${c.name}** (${c.kind}): ${c.modules.join(', ')}`),
    '',
    '## Running',
    '',
    '```bash',
    'cargo check',
    `cargo run --bin ${crate}`,
    '```',
    '',
  ];
  return file('README.md', `${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

function signature(operation: IROperationSignature, emitter: RustEmitter): string {
  const parameters = ['&self', ...operation.parameters.map((p) => `${emitter.identifier(p.name)}: ${emitter.typeName(p.type)}`)];
  return `${emitter.methodName(operation.phrase)}(${parameters.join(', ')}) -> ${emitter.resultType(operation.returns)}`;
}

function writeFields(writer: CodeWriter, fields: readonly IRField[], emitter: RustEmitter, visibility = 'pub '): void {
  for (const field of fields) {
    const parts: string[] = [];
    if (field.description) parts.push(field.description);
    if (field.derived) parts.push('Derived: recomputed rather than stored.');
    if (parts.length > 0) docComment(writer, parts.join(' '));
    writer.line(`${visibility}${emitter.identifier(field.name)}: ${fieldType(field, emitter)},`);
  }
}

/** Optional fields become `Option<T>` even when the declared type is bare. */
function fieldType(field: IRField, emitter: RustEmitter): string {
  const rendered = emitter.typeName(field.type);
  return field.required || field.type.kind === 'optional' ? rendered : `Option<${rendered}>`;
}

function constructorParameters(fields: readonly IRField[], emitter: RustEmitter): string {
  return fields.map((f) => `${emitter.identifier(f.name)}: ${fieldType(f, emitter)}`).join(', ');
}

function writeConstraintChecks(
  writer: CodeWriter,
  shape: string,
  fields: readonly IRField[],
  receiver: string,
  emitter: RustEmitter,
): void {
  for (const field of fields) {
    const name = emitter.identifier(field.name);
    const access = `${receiver}.${name}`;
    const size = sizeExpression(field, access);
    for (const constraint of field.constraints) {
      switch (constraint.kind) {
        case 'min':
          writer.line(`if ${access} < ${numeric(field.type, constraint.value)} { return Err(ValidationError::constraint("${shape}", "${name}", "min ${constraint.value}")); }`);
          break;
        case 'max':
          writer.line(`if ${access} > ${numeric(field.type, constraint.value)} { return Err(ValidationError::constraint("${shape}", "${name}", "max ${constraint.value}")); }`);
          break;
        case 'min-length':
          writer.line(`if ${size} < ${constraint.value} { return Err(ValidationError::constraint("${shape}", "${name}", "min length ${constraint.value}")); }`);
          break;
        case 'max-length':
          writer.line(`if ${size} > ${constraint.value} { return Err(ValidationError::constraint("${shape}", "${name}", "max length ${constraint.value}")); }`);
          break;
        case 'length':
          writer.line(`if ${size} != ${constraint.value} { return Err(ValidationError::constraint("${shape}", "${name}", "length ${constraint.value}")); }`);
          break;
        case 'pattern':
          writer.line(`// ${name} declares pattern "${constraint.value}"; add a regex check here.`);
          break;
        default:
          break;
      }
    }
  }
}

function writeInvariantChecks(
  writer: CodeWriter,
  shape: string,
  invariants: readonly IRInvariant[],
  index: ModuleIndex,
  fields: readonly IRField[],
): void {
  if (invariants.length === 0) return;
  // Invariants read as bare field names in the source; inside the type they are `self`/`value` members.
  const emitter = new RustEmitter(index, { selfFields: new Set(fields.map((f) => f.name)) });
  for (const invariant of invariants) {
    writer.line(`if !(${emitter.expression(invariant.condition)}) { return Err(ValidationError::invariant("${shape}", ${quote(invariant.description)})); }`);
  }
}

/** `min`/`max` compare against the field's own numeric type. */
function numeric(type: IRType, value: number): string {
  const inner = type.kind === 'optional' ? type.of : type;
  if (inner.kind === 'primitive' && inner.name === 'decimal') {
    return Number.isInteger(value)
      ? `rust_decimal::Decimal::from(${value})`
      : `rust_decimal::Decimal::try_from(${value}f64).unwrap_or_default()`;
  }
  return String(value);
}

/** Text is measured in characters, collections in elements. */
function sizeExpression(field: IRField, access: string): string {
  const inner = field.type.kind === 'optional' ? field.type.of : field.type;
  if (inner.kind === 'primitive' && (inner.name === 'text' || inner.name === 'uuid')) return `${access}.chars().count()`;
  return `${access}.len()`;
}

/**
 * Whether the method needs `&mut self`.
 *
 * Read off the statements, which is why a body written as a Rust block gets
 * `&mut self` regardless: there are no statements to read, and a block that
 * assigns to a field would not compile behind a shared borrow. The cost of
 * guessing wrong this way is a borrow stricter than necessary; the cost of
 * guessing the other way is code that does not build.
 */
function mutatesSelf(body: readonly IRStatement[]): boolean {
  return body.some((statement) => {
    switch (statement.kind) {
      case 'set':
      case 'append':
      case 'remove':
        return true;
      case 'when':
        return mutatesSelf(statement.then) || mutatesSelf(statement.otherwise);
      case 'for-each':
        return mutatesSelf(statement.body);
      default:
        return false;
    }
  });
}

function notFoundExpression(
  operation: IROperationSignature,
  index: ModuleIndex,
  emitter: RustEmitter,
  argument: string,
): string {
  const errorName = operation.throws[0];
  if (!errorName) return 'Ok(Default::default())';
  const declaration = index.typed(errorName, 'error');
  const firstField = declaration?.fields[0];
  const payload = firstField ? ` { ${emitter.identifier(firstField.name)}: ${argument} }` : '';
  return `Err(${emitter.errorEnum}::${pascalCase(errorName)}${payload})`;
}

/** Identity field of the shape a repository stores; defaults to `id`. */
function identityOf(operation: IROperationSignature, index: ModuleIndex, emitter: RustEmitter): string {
  const parameter = operation.parameters[0];
  if (parameter?.type.kind === 'named') {
    const declaration = index.get(parameter.type.name);
    if (declaration && (declaration.kind === 'entity' || declaration.kind === 'aggregate')) {
      const identity = declaration.identity[0];
      if (identity) return emitter.identifier(identity);
    }
  }
  return 'id';
}

function storedType(port: IRPortDecl, index: ModuleIndex, emitter: RustEmitter): string {
  const saved = port.operations.find((o) => /^(save|store|persist|upsert)\b/.test(normalisePhrase(o.phrase)));
  const savedType = saved?.parameters[0]?.type;
  if (savedType) return emitter.typeName(savedType);
  const found = port.operations.find((o) => /^(find|get|read|load)\b/.test(normalisePhrase(o.phrase)));
  if (found) return elementName(emitter.typeName(emitter.okType(found.returns)));
  void index;
  return 'serde_json::Value';
}

function pathParameters(
  endpoint: IREndpointDecl,
  operation: IROperation | undefined,
  emitter: RustEmitter,
): Array<{ name: string; binding: string; type: string }> {
  const names = [...endpoint.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? '');
  return names.map((raw) => {
    const name = emitter.identifier(raw);
    const parameter = operation?.parameters.find((p) => emitter.identifier(p.name) === name);
    // Unbound path segments still have to be extracted, so they get an ignored binding.
    return parameter
      ? { name, binding: name, type: emitter.typeName(parameter.type) }
      : { name, binding: `_${name}`, type: 'String' };
  });
}

function axumPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_match, name: string) => `{${snakeCase(name)}}`);
}

const NAMED_STATUSES: Record<number, string> = {
  200: 'OK',
  201: 'CREATED',
  202: 'ACCEPTED',
  204: 'NO_CONTENT',
};

function statusCode(status: number): string {
  const named = NAMED_STATUSES[status];
  return named
    ? `axum::http::StatusCode::${named}`
    : `axum::http::StatusCode::from_u16(${status}).unwrap_or(axum::http::StatusCode::OK)`;
}

/** `"no order exists with id {orderId}"` becomes a `thiserror` format string. */
function messageTemplate(message: string, fields: readonly IRField[]): string {
  const known = new Set(fields.map((f) => f.name));
  return message.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => (known.has(name) ? `{${snakeCase(name)}}` : match));
}

function variantPattern(name: string, fieldCount: number): string {
  return fieldCount === 0 ? `Self::${pascalCase(name)}` : `Self::${pascalCase(name)} { .. }`;
}

function elementName(rendered: string): string {
  return rendered.replace(/^Vec<(.*)>$/, '$1').replace(/^Option<(.*)>$/, '$1');
}

function guessEntity(portName: string): string {
  return portName.replace(/(Repository|Store|Gateway|Adapter)$/, '');
}

function errorEnum(module: IRModule): string {
  return `${pascalCase(module.name)}Error`;
}

function modulePath(layer: RustLayer, module: IRModule, fileName: string): string {
  return `src/${layer}/${snakeCase(module.name)}/${snakeCase(fileName)}.rs`;
}

interface UseFlags {
  serde?: boolean;
  arc?: boolean;
  sqlx?: boolean;
  enums?: boolean;
  valueObjects?: boolean;
  model?: boolean;
  messages?: boolean;
  errors?: boolean;
  ports?: boolean;
  services?: boolean;
  validation?: boolean;
  events?: boolean;
  domainError?: boolean;
}

function writeUses(writer: CodeWriter, module: IRModule, index: ModuleIndex, flags: UseFlags): void {
  const name = snakeCase(module.name);
  const lines: string[] = [];
  if (flags.arc) lines.push('use std::sync::Arc;');
  if (flags.serde) lines.push('use serde::{Deserialize, Serialize};');
  if (flags.sqlx) lines.push('use sqlx::Row;');
  if (flags.enums && index.enums.length > 0) lines.push(`use crate::domain::${name}::enums::*;`);
  if (flags.valueObjects && index.valueObjects.length > 0) lines.push(`use crate::domain::${name}::value_objects::*;`);
  if (flags.model && index.entities.length + index.aggregates.length > 0) lines.push(`use crate::domain::${name}::model::*;`);
  if (flags.messages && index.commands.length + index.events.length + index.dtos.length + index.queries.length > 0) {
    lines.push(`use crate::domain::${name}::messages::*;`);
  }
  if (flags.errors) lines.push(`use crate::domain::${name}::errors::${errorEnum(module)};`);
  if (flags.ports && index.ports.length > 0) lines.push(`use crate::application::${name}::ports::*;`);
  if (flags.services && index.services.length > 0) lines.push(`use crate::application::${name}::services::*;`);
  if (flags.domainError) lines.push('use crate::shared::errors::DomainError;');
  if (flags.events) lines.push('use crate::shared::events::EventPublisher;');
  if (flags.validation) lines.push('use crate::shared::validation::ValidationError;');
  if (lines.length === 0) return;
  writer.lines_(lines);
  writer.blank();
}

function banner(): CodeWriter {
  const writer = new CodeWriter();
  writer.line(`// ${GENERATED_BANNER}`);
  writer.blank();
  return writer;
}

function docComment(writer: CodeWriter, text: string | undefined): void {
  if (!text) return;
  for (const line of comment(text, '/// ')) writer.line(line);
}

function signatureDoc(writer: CodeWriter, operation: IROperationSignature): void {
  if (operation.description) docComment(writer, operation.description);
  writer.line(`/// Declared in HADL as "${operation.phrase}".`);
  for (const name of operation.throws) writer.line(`/// Returns \`${pascalCase(name)}\` when the rule it names is broken.`);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

export function generateForModule(module: IRModule, context: GenerationContext): GenerationResult {
  return rustGenerator.generate(module, context);
}
