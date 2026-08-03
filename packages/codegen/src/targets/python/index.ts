/**
 * Python / FastAPI backend.
 *
 * Emits a hexagonal project: Pydantic models carrying their own rules, ports as
 * protocols, async services that depend on them, adapters that implement them,
 * and a thin FastAPI layer that maps checked errors to status codes.
 */
import {
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
  titleCase,
  unwrap,
  type CodeGenerator,
  type GeneratedFile,
  type GenerationContext,
  type IRAdapterDecl,
  type IREndpointDecl,
  type IRField,
  type IRInvariant,
  type IRModule,
  type IROperation,
  type IROperationSignature,
  type IRStatement,
  type IRType,
  type ModuleIndex,
} from '@haic/core';
import { ProjectLayout, type Layer } from '../../shared/layout.js';
import { PythonEmitter, attributeName, methodName, pythonName } from './emitter.js';

const layout = new ProjectLayout({ sourceRoot: 'app', extension: '.py', directoryCase: snakeCase });

export const pythonGenerator: CodeGenerator = {
  id: 'python',
  displayName: 'Python',
  framework: 'FastAPI',
  verifyCommand: ['python', '-m', 'compileall', '-q', 'app'],

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
    ].filter((f): f is GeneratedFile => f !== null);

    void context;
    return { files: [...files, ...packageMarkers(files)], diagnostics: [] };
  },

  generateProject(context) {
    return {
      files: [
        pyproject(context),
        mainFile(context),
        sharedErrors(),
        sharedEvents(),
        sharedValidation(),
        ...rootPackages(),
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

function enumsFile(module: IRModule, index: ModuleIndex): GeneratedFile | null {
  if (index.enums.length === 0) return null;

  const blocks = index.enums.map((declaration) => {
    const writer = pyWriter();
    writer.line(`class ${pascalCase(declaration.name)}(str, Enum):`);
    writer.block(() => {
      docstring(writer, declaration.description ?? `${titleCase(declaration.name)} as declared in HADL.`);
      writer.blank();
      for (const value of declaration.values) {
        if (value.description) writer.line(`# ${value.description}`);
        writer.line(`${screamingSnakeCase(value.name)} = "${value.name}"`);
      }
    });
    return writer.toString();
  });

  return pythonFile(modulePath('domain', module, 'enums'), `Enumerations of the ${module.name} module.`, [], blocks);
}

function valueObjectsFile(module: IRModule, index: ModuleIndex): GeneratedFile | null {
  if (index.valueObjects.length === 0) return null;

  const blocks = index.valueObjects.map((declaration) => {
    const emitter = new PythonEmitter(index, new Map(), attributeNames(declaration.fields));
    const writer = pyWriter();
    writer.line(`class ${pascalCase(declaration.name)}(BaseModel):`);
    writer.block(() => {
      docstring(writer, declaration.description ?? `Value object ${declaration.name}. Compared by value, never by identity.`);
      writer.blank();
      writer.line('model_config = ConfigDict(frozen=True)');
      writer.blank();
      for (const field of declaration.fields) writer.line(fieldDeclaration(field, emitter));
      emitFieldValidators(writer, declaration.name, declaration.fields, emitter);
      if (declaration.invariants.length > 0) {
        writer.blank();
        writer.line('@model_validator(mode="after")');
        writer.line('def _check_invariants(self) -> Self:');
        writer.block(() => {
          emitInvariants(writer, declaration.name, declaration.invariants, emitter);
          writer.line('return self');
        });
      }
    });
    return writer.toString();
  });

  return pythonFile(
    modulePath('domain', module, 'value_objects'),
    `Value objects of the ${module.name} module. Declared constraints stay on the fields so they reach the OpenAPI schema.`,
    moduleImports(module, index, { enums: true, validation: true }),
    blocks,
  );
}

function modelFile(module: IRModule, index: ModuleIndex): GeneratedFile | null {
  const shapes = [...index.entities, ...index.aggregates];
  if (shapes.length === 0) return null;

  const blocks = shapes.map((declaration) => {
    const emitter = new PythonEmitter(index, new Map(), attributeNames(declaration.fields));
    const writer = pyWriter();
    const kindLabel = declaration.kind === 'aggregate' ? 'Aggregate root' : 'Entity';
    writer.line(`class ${pascalCase(declaration.name)}(BaseModel):`);
    writer.block(() => {
      docstring(
        writer,
        declaration.description ?? `${kindLabel} ${declaration.name}, identified by ${declaration.identity.join(', ')}.`,
      );
      writer.blank();
      for (const field of declaration.fields) writer.line(fieldDeclaration(field, emitter));
      emitFieldValidators(writer, declaration.name, declaration.fields, emitter);

      if (declaration.invariants.length > 0) {
        writer.blank();
        writer.line('@model_validator(mode="after")');
        writer.line('def _check_on_build(self) -> Self:');
        writer.block(() => {
          writer.line('self.check_invariants()');
          writer.line('return self');
        });
      }

      writer.blank();
      writer.line('def check_invariants(self) -> None:');
      writer.block(() => {
        docstring(
          writer,
          declaration.invariants.length > 0
            ? 'Re-checks every rule declared on this type. Call it after any change.'
            : 'No invariant is declared on this type yet.',
        );
        emitInvariants(writer, declaration.name, declaration.invariants, emitter);
      });

      for (const operation of declaration.kind === 'aggregate' ? declaration.operations : []) {
        writer.blank();
        emitOperation(writer, emitter, operation, false);
      }
    });
    return writer.toString();
  });

  return pythonFile(
    modulePath('domain', module, 'model'),
    `Entities and aggregate roots of the ${module.name} module.`,
    moduleImports(module, index, { enums: true, valueObjects: true, errors: true, validation: true }),
    blocks,
  );
}

function errorsFile(module: IRModule, index: ModuleIndex): GeneratedFile | null {
  if (index.errors.length === 0) return null;

  const emitter = new PythonEmitter(index);
  const blocks = index.errors.map((declaration) => {
    const writer = pyWriter();
    const base = declaration.checked ? 'CheckedError' : 'UncheckedError';
    writer.line(`class ${pascalCase(declaration.name)}(${base}):`);
    writer.block(() => {
      docstring(
        writer,
        declaration.description ??
          (declaration.checked
            ? 'Checked: part of the operation contract, callers are expected to handle it.'
            : 'Unchecked: signals a bug. Do not catch it to keep going.'),
      );
      writer.blank();
      writer.line(`code: ClassVar[str] = "${screamingSnakeCase(declaration.name)}"`);
      writer.line(`status: ClassVar[int] = ${declaration.status ?? (declaration.checked ? 400 : 500)}`);
      writer.blank();
      const parameters = declaration.fields.map((f) => `${pythonName(f.name)}: ${emitter.typeName(f.type)}`);
      writer.line(`def __init__(self${parameters.length > 0 ? `, *, ${parameters.join(', ')}` : ''}) -> None:`);
      writer.block(() => {
        for (const field of declaration.fields) writer.line(`self.${pythonName(field.name)} = ${pythonName(field.name)}`);
        writer.line(`super().__init__(${messageExpression(declaration.message, declaration.fields)})`);
      });
    });
    return writer.toString();
  });

  return pythonFile(
    modulePath('domain', module, 'errors'),
    `Errors of the ${module.name} module.`,
    moduleImports(module, index, { errorBases: true }),
    blocks,
  );
}

function messagesFile(module: IRModule, index: ModuleIndex): GeneratedFile | null {
  const shapes = [...index.commands, ...index.events, ...index.dtos, ...index.queries];
  if (shapes.length === 0) return null;

  const emitter = new PythonEmitter(index);
  const blocks: string[] = [];
  for (const declaration of shapes) {
    const writer = pyWriter();
    writer.line(`class ${pascalCase(declaration.name)}(BaseModel):`);
    writer.block(() => {
      docstring(writer, declaration.description ?? messageRole(declaration));
      writer.blank();
      for (const field of declaration.fields) writer.line(fieldDeclaration(field, emitter));
    });
    blocks.push(writer.toString());

    if (declaration.kind === 'event') {
      const topic = pyWriter();
      topic.line(`${screamingSnakeCase(declaration.name)}_TOPIC = "${declaration.topic ?? kebabCase(declaration.name)}"`);
      blocks.push(topic.toString());
    }
  }

  return pythonFile(
    modulePath('domain', module, 'messages'),
    `Commands, events and DTOs of the ${module.name} module.`,
    moduleImports(module, index, { enums: true, valueObjects: true }),
    blocks,
  );
}

// ---------------------------------------------------------------------------
// Application layer
// ---------------------------------------------------------------------------

function portsFile(module: IRModule, index: ModuleIndex): GeneratedFile | null {
  if (index.ports.length === 0) return null;

  const emitter = new PythonEmitter(index);
  const blocks = index.ports.map((port) => {
    const writer = pyWriter();
    writer.line(`class ${pascalCase(port.name)}(Protocol):`);
    writer.block(() => {
      docstring(
        writer,
        port.description ??
          (port.direction === 'inbound'
            ? 'Inbound port: a use case the outside world can drive.'
            : 'Outbound port: something the domain drives. Implemented by an adapter.'),
      );
      for (const operation of port.operations) {
        writer.blank();
        writer.line(`async def ${methodName(operation.phrase)}(${parameterList(operation, emitter)}) -> ${emitter.typeName(operation.returns)}:`);
        writer.block(() => {
          docstring(writer, signatureDoc(operation));
          writer.line('...');
        });
      }
    });
    return writer.toString();
  });

  return pythonFile(
    modulePath('application', module, 'ports'),
    `Ports of the ${module.name} module. Adapters satisfy them structurally.`,
    moduleImports(module, index, { enums: true, valueObjects: true, model: true, messages: true }),
    blocks,
  );
}

function servicesFile(module: IRModule, index: ModuleIndex): GeneratedFile | null {
  if (index.services.length === 0) return null;

  const blocks = index.services.map((service) => {
    const emitter = new PythonEmitter(index, portAttributes(service.uses));
    const writer = pyWriter();
    const implemented = service.implements ? index.typed(service.implements, 'port') : undefined;
    writer.line(`class ${pascalCase(service.name)}${implemented ? `(${pascalCase(implemented.name)})` : ''}:`);
    writer.block(() => {
      docstring(writer, service.description ?? `Application service ${service.name}.`);
      writer.blank();
      emitInjection(writer, service.uses);
      for (const operation of service.operations) {
        writer.blank();
        emitOperation(writer, emitter, operation, true);
      }
    });
    return writer.toString();
  });

  return pythonFile(
    modulePath('application', module, 'services'),
    `Application services of the ${module.name} module.`,
    moduleImports(module, index, {
      enums: true,
      valueObjects: true,
      model: true,
      messages: true,
      errors: true,
      ports: true,
      events: true,
    }),
    blocks,
  );
}

// ---------------------------------------------------------------------------
// Infrastructure layer
// ---------------------------------------------------------------------------

function adaptersFile(module: IRModule, index: ModuleIndex): GeneratedFile | null {
  if (index.adapters.length === 0) return null;

  const emitter = new PythonEmitter(index);
  const blocks: string[] = [];
  if (index.adapters.some((a) => a.technology === 'sql')) blocks.push(sqlClientProtocol());

  for (const adapter of index.adapters) {
    const port = index.typed(adapter.implements, 'port');
    if (!port) continue;

    const writer = pyWriter();
    writer.line(`class ${pascalCase(adapter.name)}(${pascalCase(port.name)}):`);
    writer.block(() => {
      docstring(writer, adapter.description ?? `${adapter.technology} adapter for ${port.name}.`);
      writer.blank();
      if (adapter.technology === 'sql') {
        writer.line(`_table = "${sqlTable(adapter, port.name)}"`);
        writer.blank();
        writer.line('def __init__(self, client: SqlClient) -> None:');
        writer.block(() => writer.line('self._client = client'));
      } else if (adapter.technology === 'in-memory') {
        writer.line('def __init__(self) -> None:');
        writer.block(() => writer.line('self._rows: dict[str, Any] = {}'));
      }

      for (const operation of port.operations) {
        writer.blank();
        writer.line(`async def ${methodName(operation.phrase)}(${parameterList(operation, emitter)}) -> ${emitter.typeName(operation.returns)}:`);
        writer.block(() => {
          docstring(writer, signatureDoc(operation));
          emitAdapterBody(writer, adapter, operation, emitter, index);
        });
      }
    });
    blocks.push(writer.toString());
  }

  return pythonFile(
    modulePath('infrastructure', module, 'adapters'),
    `Adapters of the ${module.name} module.`,
    moduleImports(module, index, { enums: true, valueObjects: true, model: true, messages: true, errors: true, ports: true }),
    blocks,
  );
}

function sqlClientProtocol(): string {
  const writer = pyWriter();
  writer.line('class SqlClient(Protocol):');
  writer.block(() => {
    docstring(writer, 'The little a SQL driver must offer. An asyncpg connection or pool satisfies it as-is.');
    for (const signature of [
      'async def fetch(self, query: str, *args: Any) -> list[Any]:',
      'async def fetchrow(self, query: str, *args: Any) -> Any | None:',
      'async def execute(self, query: str, *args: Any) -> Any:',
    ]) {
      writer.blank();
      writer.line(signature);
      writer.block(() => writer.line('...'));
    }
  });
  return writer.toString();
}

/** Recognised repository phrases get real SQL; anything else is left to the author. */
function emitAdapterBody(
  writer: CodeWriter,
  adapter: IRAdapterDecl,
  operation: IROperationSignature,
  emitter: PythonEmitter,
  index: ModuleIndex,
): void {
  const declared = adapter.operations.find((o) => normalisePhrase(o.phrase) === normalisePhrase(operation.phrase));
  if (declared && (declared.body.length > 0 || declared.native.length > 0)) {
    writer.line(renderBody(emitter, declared, declared.parameters.map((p) => p.name)));
    return;
  }

  const phrase = operation.phrase.toLowerCase();
  const first = operation.parameters[0];
  const model = modelClass(operation.returns);
  const argument = first ? pythonName(first.name) : null;
  const column = first ? snakeCase(first.name) : 'id';
  const missing = operation.throws[0];

  if (adapter.technology === 'sql' && argument) {
    if (model && /^(find|get|read|load)\b.*\bby id$/.test(phrase)) {
      writer.line(`row = await self._client.fetchrow(f"SELECT data FROM {self._table} WHERE ${column} = $1", ${argument})`);
      emitMissingRow(writer, 'row', missing, argument, index);
      writer.line(`return ${model}.model_validate_json(row["data"])`);
      return;
    }
    if (/^(save|store|persist|upsert)\b/.test(phrase)) {
      writer.line('await self._client.execute(');
      writer.block(() => {
        writer.line('f"INSERT INTO {self._table} (id, data) VALUES ($1, $2)"');
        writer.line('" ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",');
        writer.line(`${argument}.${identityAttribute(index, first!.type)},`);
        writer.line(`${argument}.model_dump_json(),`);
      });
      writer.line(')');
      return;
    }
    if (model && /^(list|find all|search)\b/.test(phrase)) {
      writer.line(`rows = await self._client.fetch(f"SELECT data FROM {self._table} WHERE ${column} = $1", ${argument})`);
      writer.line(`return [${model}.model_validate_json(row["data"]) for row in rows]`);
      return;
    }
    if (/^(delete|remove)\b/.test(phrase)) {
      writer.line(`await self._client.execute(f"DELETE FROM {self._table} WHERE ${column} = $1", ${argument})`);
      return;
    }
  }

  if (adapter.technology === 'in-memory' && argument) {
    if (/^(find|get|read|load)\b.*\bby id$/.test(phrase)) {
      writer.line(`row = self._rows.get(str(${argument}))`);
      emitMissingRow(writer, 'row', missing, argument, index);
      writer.line('return row');
      return;
    }
    if (/^(save|store|persist|upsert)\b/.test(phrase)) {
      writer.line(`self._rows[str(${argument}.${identityAttribute(index, first!.type)})] = ${argument}`);
      return;
    }
    if (/^(delete|remove)\b/.test(phrase)) {
      writer.line(`self._rows.pop(str(${argument}), None)`);
      return;
    }
  }
  if (adapter.technology === 'in-memory' && /^(list|find all|search)\b/.test(phrase)) {
    writer.line('return list(self._rows.values())');
    return;
  }

  writer.line(`raise NotImplementedError("${operation.phrase} has no generated implementation; write it here.")`);
}

function emitMissingRow(writer: CodeWriter, variable: string, error: string | undefined, argument: string, index: ModuleIndex): void {
  writer.line(`if ${variable} is None:`);
  writer.block(() => {
    if (error) writer.line(`raise ${pascalCase(error)}(${errorField(index, error)}=${argument})`);
    else writer.line('return None');
  });
}

// ---------------------------------------------------------------------------
// Interface layer
// ---------------------------------------------------------------------------

function routesFile(module: IRModule, index: ModuleIndex): GeneratedFile | null {
  if (index.endpoints.length === 0) return null;

  const emitter = new PythonEmitter(index);
  const blocks: string[] = [];

  const router = pyWriter();
  router.line(`router = APIRouter(tags=["${kebabCase(module.name)}"])`);
  for (const scheme of securitySchemes(index.endpoints)) router.line(scheme);
  blocks.push(router.toString());

  for (const service of [...new Set(index.endpoints.map((e) => e.handler.service))]) {
    const writer = pyWriter();
    writer.line(`def ${providerName(service)}() -> ${pascalCase(service)}:`);
    writer.block(() => {
      docstring(writer, `Placeholder dependency. Override it in app.main once ${service} has its adapters.`);
      writer.line(`raise NotImplementedError("bind ${pascalCase(service)} through app.dependency_overrides")`);
    });
    blocks.push(writer.toString());
  }

  for (const endpoint of index.endpoints) blocks.push(endpointFunction(endpoint, index, emitter));

  return pythonFile(
    modulePath('interface', module, 'routes'),
    `HTTP routes of the ${module.name} module.`,
    moduleImports(module, index, { enums: true, valueObjects: true, model: true, messages: true, services: true }),
    blocks,
  );
}

function endpointFunction(endpoint: IREndpointDecl, index: ModuleIndex, emitter: PythonEmitter): string {
  const operation = index.resolvePhrase(endpoint.handler.operation)[0]?.operation;
  const success = endpoint.responses.find((r) => r.status < 400) ?? endpoint.responses[0];
  const failures = endpoint.responses.filter((r) => r.status >= 400);
  const returns = operation ? emitter.typeName(operation.returns) : success?.body ? emitter.typeName(success.body) : 'None';
  const scheme = SECURITY_SCHEMES[endpoint.auth];

  const parameters: string[] = [];
  const arguments_: string[] = [];
  for (const placeholder of pathPlaceholders(endpoint.path)) {
    const name = pythonName(placeholder);
    const parameter = operation?.parameters.find((p) => pythonName(p.name) === name);
    parameters.push(`${name}: ${parameter ? emitter.typeName(parameter.type) : requestFieldType(endpoint, index, emitter, placeholder)}`);
    if (parameter) arguments_.push(`${name}=${name}`);
  }
  for (const parameter of operation?.parameters ?? []) {
    const name = pythonName(parameter.name);
    if (parameters.some((p) => p.startsWith(`${name}:`))) continue;
    parameters.push(`${name}: ${emitter.typeName(parameter.type)}`);
    arguments_.push(`${name}=${name}`);
  }
  parameters.push(`service: Annotated[${pascalCase(endpoint.handler.service)}, Depends(${providerName(endpoint.handler.service)})]`);

  const writer = pyWriter();
  writer.line(`@router.${endpoint.method.toLowerCase()}(`);
  writer.block(() => {
    writer.line(`"${routePath(endpoint.path)}",`);
    writer.line(`status_code=${success?.status ?? 200},`);
    writer.line(`summary="${endpoint.handler.operation}",`);
    if (returns !== 'None') writer.line(`response_model=${returns},`);
    if (failures.length > 0) {
      writer.line('responses={');
      writer.block(() => {
        for (const failure of failures) {
          writer.line(`${failure.status}: {"description": "${failure.when ?? failure.description ?? 'error'}"},`);
        }
      });
      writer.line('},');
    }
    if (scheme) writer.line(`dependencies=[Depends(${scheme.variable})],`);
  });
  writer.line(')');
  writer.line(`async def ${snakeCase(endpoint.name)}(`);
  writer.block(() => {
    for (const parameter of parameters) writer.line(`${parameter},`);
  });
  writer.line(`) -> ${returns}:`);
  writer.block(() => {
    docstring(writer, `${endpoint.method} ${endpoint.path}${endpoint.auth === 'none' ? '' : `, authenticated with ${endpoint.auth}`}.`);
    const call = `service.${methodName(endpoint.handler.operation)}(${arguments_.join(', ')})`;
    writer.line(returns === 'None' ? `await ${call}` : `return await ${call}`);
  });
  return writer.toString();
}

function handlersFile(module: IRModule, index: ModuleIndex): GeneratedFile | null {
  if (index.handlers.length === 0) return null;

  const blocks = index.handlers.map((handler) => {
    const emitter = new PythonEmitter(index, portAttributes(handler.uses));
    const payload = index.get(handler.on);
    const writer = pyWriter();
    writer.line(`class ${pascalCase(handler.name)}:`);
    writer.block(() => {
      docstring(
        writer,
        handler.description ?? `Reacts to ${handler.on}. Delivery: ${handler.delivery}, up to ${handler.retries} retries.`,
      );
      writer.blank();
      writer.line(`trigger: ClassVar[str] = "${handler.on}"`);
      writer.line(`retries: ClassVar[int] = ${handler.retries}`);
      writer.blank();
      emitInjection(writer, handler.uses);
      writer.blank();
      const event = payload && 'fields' in payload ? pascalCase(payload.name) : 'Any';
      writer.line(`async def handle(self, event: ${event}) -> None:`);
      writer.block(() => {
        docstring(writer, `Handles one ${handler.on} message.`);
        writer.line(renderStatements(emitter, handler.body, ['event']));
      });
    });
    return writer.toString();
  });

  return pythonFile(
    modulePath('interface', module, 'handlers'),
    `Message handlers of the ${module.name} module.`,
    moduleImports(module, index, {
      enums: true,
      valueObjects: true,
      model: true,
      messages: true,
      errors: true,
      ports: true,
      events: true,
    }),
    blocks,
  );
}

// ---------------------------------------------------------------------------
// Project-level files
// ---------------------------------------------------------------------------

function pyproject(context: GenerationContext): GeneratedFile {
  const lines = [
    `# ${GENERATED_BANNER}`,
    '[project]',
    `name = "${kebabCase(context.project.name)}"`,
    'version = "0.1.0"',
    ...(context.project.description ? [`description = ${JSON.stringify(context.project.description)}`] : []),
    'requires-python = ">=3.12"',
    'dependencies = [',
    '    "fastapi>=0.115",',
    '    "uvicorn[standard]>=0.32",',
    '    "pydantic>=2.10",',
    '    "asyncpg>=0.30",',
    ']',
    '',
    '[build-system]',
    'requires = ["hatchling"]',
    'build-backend = "hatchling.build"',
    '',
    '[tool.hatch.build.targets.wheel]',
    'packages = ["app"]',
  ];
  return file('pyproject.toml', `${lines.join('\n')}\n`);
}

function mainFile(context: GenerationContext): GeneratedFile {
  const modules = context.project.modules.filter((m) => indexModule(m).endpoints.length > 0);
  const port = context.project.modules.find((m) => m.infrastructure)?.infrastructure?.port ?? 8080;

  const body = pyWriter();
  body.line(`app = FastAPI(title=${JSON.stringify(context.project.name)}, version="0.1.0")`);
  body.line('install_error_handlers(app)');
  body.blank();
  body.line('# Wire your adapters here, then bind them with app.dependency_overrides[...] = lambda: service.');
  for (const module of modules) body.line(`app.include_router(${snakeCase(module.name)}_router)`);

  const entry = pyWriter();
  entry.line('def main() -> None:');
  entry.block(() => {
    docstring(entry, 'Runs the service with uvicorn. Production deployments should call the ASGI app directly.');
    entry.line('import uvicorn');
    entry.blank();
    entry.line(`uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "${port}")))`);
  });

  const guard = pyWriter();
  guard.line('if __name__ == "__main__":');
  guard.block(() => guard.line('main()'));

  const imports = modules.map((module) => ({
    module: dotted(modulePath('interface', module, 'routes')),
    names: [`router as ${snakeCase(module.name)}_router`],
  }));
  imports.push({ module: dotted(layout.sharedPath('errors')), names: ['install_error_handlers'] });

  return pythonFile(
    layout.entryPoint('main'),
    'FastAPI entry point: mounts every generated router and installs the error handlers.',
    imports,
    [body.toString(), entry.toString(), guard.toString()],
  );
}

function sharedErrors(): GeneratedFile {
  const base = pyWriter();
  base.line('class DomainError(Exception):');
  base.block(() => {
    docstring(base, 'Base of both families: a stable code, the HTTP status it maps to, and a rendered message.');
    base.blank();
    base.line('code: ClassVar[str] = "DOMAIN_ERROR"');
    base.line('status: ClassVar[int] = 500');
    base.blank();
    base.line('def __init__(self, message: str) -> None:');
    base.block(() => {
      base.line('super().__init__(message)');
      base.line('self.message = message');
    });
  });

  const checked = pyWriter();
  checked.line('class CheckedError(DomainError):');
  checked.block(() => docstring(checked, 'Part of an operation contract: every caller is expected to handle it.'));

  const unchecked = pyWriter();
  unchecked.line('class UncheckedError(DomainError, RuntimeError):');
  unchecked.block(() =>
    docstring(unchecked, 'Signals a defect, so it also reads as a RuntimeError. Catching it to keep going only hides the bug.'),
  );

  const install = pyWriter();
  install.line('def install_error_handlers(app: FastAPI) -> None:');
  install.block(() => {
    docstring(install, 'Renders domain errors and rejected models as JSON, using the status each one declares.');
    install.blank();
    install.line('async def handle_domain(_request: Request, error: Exception) -> JSONResponse:');
    install.block(() => {
      install.line('if not isinstance(error, DomainError):');
      install.block(() => install.line('raise error'));
      install.line('return JSONResponse(status_code=error.status, content={"code": error.code, "message": error.message})');
    });
    install.blank();
    install.line('async def handle_validation(_request: Request, error: Exception) -> JSONResponse:');
    install.block(() =>
      install.line('return JSONResponse(status_code=422, content={"code": "VALIDATION_FAILED", "message": str(error)})'),
    );
    install.blank();
    install.line('app.add_exception_handler(CheckedError, handle_domain)');
    install.line('app.add_exception_handler(UncheckedError, handle_domain)');
    install.line('app.add_exception_handler(ValidationError, handle_validation)');
  });

  return pythonFile(
    layout.sharedPath('errors'),
    'The two error families, mirroring HADL, and the FastAPI handlers that render them.',
    [],
    [base.toString(), checked.toString(), unchecked.toString(), install.toString()],
  );
}

function sharedEvents(): GeneratedFile {
  const port = pyWriter();
  port.line('class EventPublisher(Protocol):');
  port.block(() => {
    docstring(port, 'Outbound port for domain events. The IaC layer wires a broker to it.');
    port.blank();
    port.line('async def publish(self, topic: str, payload: BaseModel) -> None:');
    port.block(() => port.line('...'));
  });

  const development = pyWriter();
  development.line('class LoggingEventPublisher:');
  development.block(() => {
    docstring(development, 'Development implementation: prints instead of publishing.');
    development.blank();
    development.line('async def publish(self, topic: str, payload: BaseModel) -> None:');
    development.block(() => development.line('print(json.dumps({"topic": topic, "payload": payload.model_dump(mode="json")}))'));
  });

  return pythonFile(layout.sharedPath('events'), 'Outbound port for domain events.', [], [port.toString(), development.toString()]);
}

function sharedValidation(): GeneratedFile {
  const blocks = [
    ['ConstraintViolation', 'Raised when a declared field constraint does not hold.', ['shape', 'field', 'rule'], '{shape}.{field} violates {rule}'],
    ['InvariantViolation', 'Raised when a declared invariant does not hold.', ['shape', 'rule'], '{shape}: {rule}'],
  ] as const;

  return pythonFile(
    layout.sharedPath('validation'),
    'Validation failures. Both derive from ValueError so Pydantic folds them into its own ValidationError.',
    [],
    blocks.map(([name, summary, fields, template]) => {
      const writer = pyWriter();
      writer.line(`class ${name}(ValueError):`);
      writer.block(() => {
        docstring(writer, summary);
        writer.blank();
        writer.line(`def __init__(self, ${fields.map((f) => `${f}: str`).join(', ')}) -> None:`);
        writer.block(() => {
          writer.line(`super().__init__(f"${template}")`);
          for (const field of fields) writer.line(`self.${field} = ${field}`);
        });
      });
      return writer.toString();
    }),
  );
}

function rootPackages(): GeneratedFile[] {
  const roots: Array<[string, string]> = [
    ['app', 'Generated FastAPI application.'],
    ['app/domain', 'Domain layer: it depends on nothing.'],
    ['app/application', 'Application layer: ports and services.'],
    ['app/infrastructure', 'Infrastructure layer: adapters that implement the outbound ports.'],
    ['app/interfaces', 'Interface layer: HTTP routes and message handlers.'],
    ['app/shared', 'Cross-cutting building blocks.'],
  ];
  return roots.map(([path, summary]) => packageFile(`${path}/__init__.py`, summary));
}

function readme(context: GenerationContext): GeneratedFile {
  const lines = [
    `# ${context.project.name}`,
    '',
    'Generated from HADL sources. Edit the `.hadl` files and recompile; everything here is overwritten.',
    '',
    '## Layout',
    '',
    '| Package | Depends on | Holds |',
    '| --- | --- | --- |',
    '| `app/domain` | nothing | aggregates, entities, value objects, events, errors |',
    '| `app/application` | domain | ports and services |',
    '| `app/infrastructure` | application | adapters that implement outbound ports |',
    '| `app/interfaces` | application | FastAPI routes and message handlers |',
    '',
    '## Bounded contexts',
    '',
    ...context.project.contexts.map((c) => `- **${c.name}** (${c.kind}): ${c.modules.join(', ')}`),
    '',
    '## Running',
    '',
    '```bash',
    'python -m venv .venv && . .venv/bin/activate',
    'pip install -e .',
    'python -m compileall -q app',
    'uvicorn app.main:app --reload',
    '```',
    '',
    'Every router resolves its service through a placeholder dependency. Bind the real ones in `app/main.py`:',
    '',
    '```python',
    'app.dependency_overrides[get_place_order_service] = lambda: PlaceOrderService(repository, publisher)',
    '```',
    '',
  ];
  return file('README.md', `${lines.join('\n')}\n`);
}

function dotEnvExample(context: GenerationContext): GeneratedFile {
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
    for (const broker of infrastructure.brokers) lines.push(`${screamingSnakeCase(broker.name)}_BROKER_URL=`);
  }
  return file('.env.example', `${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

function emitOperation(writer: CodeWriter, emitter: PythonEmitter, operation: IROperation, asynchronous: boolean): void {
  const body = renderBody(emitter, operation, operation.parameters.map((p) => p.name));
  // Ports are awaited, so an operation that reaches one has to be a coroutine.
  const prefix = asynchronous || body.includes('await ') ? 'async ' : '';
  writer.line(`${prefix}def ${methodName(operation.phrase)}(${parameterList(operation, emitter)}) -> ${emitter.typeName(operation.returns)}:`);
  writer.block(() => {
    docstring(writer, signatureDoc(operation));
    writer.line(body);
  });
}

function renderBody(emitter: PythonEmitter, operation: IROperation, parameters: readonly string[]): string {
  return render(emitter, parameters, (writer) => emitter.emitImplementation(writer, operation));
}

function renderStatements(emitter: PythonEmitter, statements: readonly IRStatement[], parameters: readonly string[]): string {
  return render(emitter, parameters, (writer) => emitter.emitBlock(writer, statements));
}

function render(emitter: PythonEmitter, parameters: readonly string[], body: (writer: CodeWriter) => void): string {
  const writer = pyWriter();
  emitter.enterOperation(parameters);
  body(writer);
  return writer.toString().replace(/\n$/, '');
}

function emitInjection(writer: CodeWriter, uses: readonly string[]): void {
  const parameters = uses.map((name) => `, ${snakeCase(name)}: ${pascalCase(name)}`).join('');
  writer.line(`def __init__(self${parameters}, event_publisher: EventPublisher) -> None:`);
  writer.block(() => {
    for (const name of uses) writer.line(`self.${attributeName(name)} = ${snakeCase(name)}`);
    writer.line('self._event_publisher = event_publisher');
  });
}

function emitInvariants(writer: CodeWriter, shape: string, invariants: readonly IRInvariant[], emitter: PythonEmitter): void {
  emitter.enterOperation();
  for (const invariant of invariants) {
    writer.line(`if not ${grouped(emitter.expression(invariant.condition))}:`);
    writer.block(() => writer.line(`raise InvariantViolation("${shape}", ${JSON.stringify(invariant.description)})`));
  }
}

/** Combining operators already parenthesise themselves; `not` should not double that. */
function grouped(expression: string): string {
  if (!expression.startsWith('(') || !expression.endsWith(')')) return `(${expression})`;
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    if (expression[index] === '(') depth += 1;
    else if (expression[index] === ')' && (depth -= 1) === 0 && index < expression.length - 1) return `(${expression})`;
  }
  return expression;
}

/** `one of` is the only declared constraint Pydantic cannot express on the field itself. */
function emitFieldValidators(writer: CodeWriter, shape: string, fields: readonly IRField[], emitter: PythonEmitter): void {
  for (const field of fields) {
    const allowed = field.constraints.find((c) => c.kind === 'one-of');
    if (!allowed || allowed.kind !== 'one-of') continue;
    const name = pythonName(field.name);
    const values = allowed.values.map((v) => (typeof v === 'number' ? String(v) : JSON.stringify(v)));
    writer.blank();
    writer.line(`@field_validator("${name}")`);
    writer.line('@classmethod');
    writer.line(`def _check_${name}(cls, value: ${emitter.typeName(field.type)}) -> ${emitter.typeName(field.type)}:`);
    writer.block(() => {
      writer.line(`if value not in (${values.join(', ')}${values.length === 1 ? ',' : ''}):`);
      writer.block(() => writer.line(`raise ConstraintViolation("${shape}", "${name}", "one of ${values.join(', ')}")`));
      writer.line('return value');
    });
  }
}

function fieldDeclaration(field: IRField, emitter: PythonEmitter): string {
  const name = pythonName(field.name);
  const annotation = emitter.typeName(fieldType(field));
  const fallback = fieldDefault(field, emitter);
  const options = [...(fallback ? [fallback.argument] : []), ...fieldConstraints(field), ...fieldDescription(field)];

  if (options.length === 0) return `${name}: ${annotation}`;
  if (fallback && fallback.plain !== null && options.length === 1) return `${name}: ${annotation} = ${fallback.plain}`;
  return `${name}: ${annotation} = Field(${options.join(', ')})`;
}

/** Derived values are recomputed rather than supplied, so they are never required. */
function fieldType(field: IRField): IRType {
  return field.derived && field.type.kind !== 'optional' ? { kind: 'optional', of: field.type } : field.type;
}

function fieldDefault(field: IRField, emitter: PythonEmitter): { plain: string | null; argument: string } | null {
  const declared = field.constraints.find((c) => c.kind === 'default');
  if (declared && declared.kind === 'default') {
    const value = emitter.literal(declared.value, field.type);
    return { plain: value, argument: `default=${value}` };
  }
  const factories: Partial<Record<IRType['kind'], string>> = { list: 'list', set: 'set', map: 'dict' };
  const factory = factories[field.type.kind];
  if (factory) return { plain: null, argument: `default_factory=${factory}` };
  if (!field.required || field.derived) return { plain: 'None', argument: 'default=None' };
  return null;
}

function fieldConstraints(field: IRField): string[] {
  const options: string[] = [];
  for (const constraint of field.constraints) {
    switch (constraint.kind) {
      case 'min':
        options.push(`ge=${constraint.value}`);
        break;
      case 'max':
        options.push(`le=${constraint.value}`);
        break;
      case 'min-length':
        options.push(`min_length=${constraint.value}`);
        break;
      case 'max-length':
        options.push(`max_length=${constraint.value}`);
        break;
      case 'length':
        options.push(`min_length=${constraint.value}`, `max_length=${constraint.value}`);
        break;
      case 'pattern':
        options.push(`pattern=r"${constraint.value}"`);
        break;
      case 'immutable':
        options.push('frozen=True');
        break;
      default:
        break;
    }
  }
  return options;
}

function fieldDescription(field: IRField): string[] {
  const parts = [field.description, field.derived ? 'Derived: recomputed rather than stored.' : ''].filter(Boolean);
  return parts.length > 0 ? [`description=${JSON.stringify(parts.join(' '))}`] : [];
}

function parameterList(operation: IROperationSignature, emitter: PythonEmitter): string {
  if (operation.parameters.length === 0) return 'self';
  const parameters = operation.parameters.map(
    (p) => `${pythonName(p.name)}: ${emitter.typeName(p.type)}${p.required ? '' : ' = None'}`,
  );
  return ['self', '*', ...parameters].join(', ');
}

function signatureDoc(operation: IROperationSignature): string {
  const parts = [operation.description, `Declared in HADL as "${operation.phrase}".`];
  if (operation.throws.length > 0) parts.push(`Raises ${operation.throws.map((t) => pascalCase(t)).join(', ')}.`);
  return parts.filter(Boolean).join(' ');
}

/** `"no order exists with id {orderId}"` becomes an f-string over the constructor arguments. */
function messageExpression(message: string, fields: readonly IRField[]): string {
  const known = new Map(fields.map((f) => [f.name, pythonName(f.name)]));
  const placeholder = /\{[A-Za-z_][A-Za-z0-9_]*\}|[{}]/g;
  const matches = [...message.matchAll(placeholder)];
  if (!matches.some((match) => known.has(match[0].slice(1, -1)))) return JSON.stringify(message);

  const body = message.replace(placeholder, (match) => {
    const name = known.get(match.slice(1, -1));
    // Braces that name no field have to survive the f-string doubled.
    return name ? `{${name}}` : match.replace(/[{}]/g, (brace) => `${brace}${brace}`);
  });
  return `f${JSON.stringify(body)}`;
}

function messageRole(declaration: { kind: string; target?: string | null; source?: string | null; projects?: string | null }): string {
  if (declaration.kind === 'command') return `Command handled by ${declaration.target ?? 'the application layer'}.`;
  if (declaration.kind === 'event') return `Event emitted by ${declaration.source ?? 'the domain'}.`;
  return `Data transfer object${declaration.projects ? ` projecting ${declaration.projects}` : ''}.`;
}

function attributeNames(fields: readonly IRField[]): ReadonlySet<string> {
  return new Set(fields.map((f) => pythonName(f.name)));
}

function portAttributes(uses: readonly string[]): ReadonlyMap<string, string> {
  return new Map(uses.map((name) => [name, attributeName(name)]));
}

function providerName(service: string): string {
  return `get_${snakeCase(service)}`;
}

const SECURITY_SCHEMES: Record<string, { variable: string; construction: string } | undefined> = {
  bearer: { variable: 'bearer_scheme', construction: 'bearer_scheme = HTTPBearer()' },
  basic: { variable: 'basic_scheme', construction: 'basic_scheme = HTTPBasic()' },
  'api-key': { variable: 'api_key_scheme', construction: 'api_key_scheme = APIKeyHeader(name="X-API-Key")' },
};

function securitySchemes(endpoints: readonly IREndpointDecl[]): string[] {
  const used = [...new Set(endpoints.map((e) => e.auth))].map((auth) => SECURITY_SCHEMES[auth]);
  return used.filter((scheme): scheme is { variable: string; construction: string } => scheme !== undefined).map((s) => s.construction);
}

function pathPlaceholders(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? '');
}

function routePath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_, name: string) => `{${pythonName(name)}}`);
}

/** A path variable the handler does not take is still typed, from the request body when possible. */
function requestFieldType(endpoint: IREndpointDecl, index: ModuleIndex, emitter: PythonEmitter, placeholder: string): string {
  const request = endpoint.request ? unwrap(endpoint.request) : null;
  const declaration = request?.kind === 'named' ? index.get(request.name) : undefined;
  const fields = declaration && 'fields' in declaration ? declaration.fields : [];
  const field = fields.find((f) => pythonName(f.name) === pythonName(placeholder));
  return field ? emitter.typeName(field.type) : 'str';
}

function identityAttribute(index: ModuleIndex, type: IRType): string {
  const inner = unwrap(type);
  const declaration = inner.kind === 'named' ? index.get(inner.name) : undefined;
  const identity = declaration && 'identity' in declaration ? declaration.identity[0] : undefined;
  return pythonName(identity ?? 'id');
}

function errorField(index: ModuleIndex, errorName: string): string {
  return pythonName(index.typed(errorName, 'error')?.fields[0]?.name ?? 'id');
}

function modelClass(type: IRType): string | null {
  const inner = unwrap(type);
  if (inner.kind === 'named') return pascalCase(inner.name);
  if (inner.kind === 'list' || inner.kind === 'set') return modelClass(inner.of);
  return null;
}

function sqlTable(adapter: IRAdapterDecl, portName: string): string {
  const table = String(adapter.config['table'] ?? tableName(portName.replace(/(Repository|Store|Gateway|Adapter)$/, '')));
  const schema = adapter.config['schema'];
  return schema ? `${String(schema)}.${table}` : table;
}

// ---------------------------------------------------------------------------
// File assembly
// ---------------------------------------------------------------------------

interface ImportCandidate {
  module: string;
  names: string[];
}

interface ImportFlags {
  enums?: boolean;
  valueObjects?: boolean;
  model?: boolean;
  messages?: boolean;
  errors?: boolean;
  ports?: boolean;
  services?: boolean;
  validation?: boolean;
  errorBases?: boolean;
  events?: boolean;
}

function moduleImports(module: IRModule, index: ModuleIndex, flags: ImportFlags): ImportCandidate[] {
  const candidates: ImportCandidate[] = [];
  const add = (names: string[], path: string): void => {
    if (names.length > 0) candidates.push({ module: dotted(path), names });
  };

  if (flags.enums) add(index.enums.map((d) => pascalCase(d.name)), modulePath('domain', module, 'enums'));
  if (flags.valueObjects) add(index.valueObjects.map((d) => pascalCase(d.name)), modulePath('domain', module, 'value_objects'));
  if (flags.model) add([...index.entities, ...index.aggregates].map((d) => pascalCase(d.name)), modulePath('domain', module, 'model'));
  if (flags.messages) {
    add([...index.commands, ...index.events, ...index.dtos, ...index.queries].map((d) => pascalCase(d.name)), modulePath('domain', module, 'messages'));
  }
  if (flags.errors) add(index.errors.map((d) => pascalCase(d.name)), modulePath('domain', module, 'errors'));
  if (flags.ports) add(index.ports.map((d) => pascalCase(d.name)), modulePath('application', module, 'ports'));
  if (flags.services) add(index.services.map((d) => pascalCase(d.name)), modulePath('application', module, 'services'));
  if (flags.validation) add(['ConstraintViolation', 'InvariantViolation'], layout.sharedPath('validation'));
  if (flags.errorBases) add(['CheckedError', 'UncheckedError'], layout.sharedPath('errors'));
  if (flags.events) add(['EventPublisher'], layout.sharedPath('events'));
  return candidates;
}

/** Assembles a module: banner, docstring, the imports its body really uses, then the body. */
function pythonFile(path: string, summary: string, candidates: readonly ImportCandidate[], blocks: readonly string[]): GeneratedFile {
  const body = blocks.filter((block) => block.trim().length > 0).join('\n\n');
  const local = candidates
    .map((candidate) => ({ module: candidate.module, names: [...new Set(candidate.names)].filter((n) => mentions(body, boundName(n))) }))
    .filter((candidate) => candidate.names.length > 0)
    .map((candidate) => `from ${candidate.module} import ${[...candidate.names].sort().join(', ')}`)
    .sort();

  const header = pyWriter();
  header.line(`# ${GENERATED_BANNER}`);
  docstring(header, summary);
  for (const group of [stdlibImports(body), thirdPartyImports(body), local]) {
    if (group.length === 0) continue;
    header.blank();
    header.lines_(group);
  }
  return file(path, `${header.toString()}\n\n${body}`);
}

function packageFile(path: string, summary: string): GeneratedFile {
  const writer = pyWriter();
  writer.line(`# ${GENERATED_BANNER}`);
  docstring(writer, summary);
  return file(path, writer.toString());
}

/** Every generated directory needs an `__init__.py` before Python will import from it. */
function packageMarkers(files: readonly GeneratedFile[]): GeneratedFile[] {
  const directories = [...new Set(files.map((f) => f.path.slice(0, f.path.lastIndexOf('/'))))];
  return directories.map((directory) => {
    const segments = directory.split('/');
    const layer = segments[1] ?? 'app';
    const name = segments[2] ?? '';
    return packageFile(`${directory}/__init__.py`, `${titleCase(layer)} layer of the ${name} module.`);
  });
}

const STDLIB_MODULES = ['datetime', 'decimal', 'json', 'os', 're', 'uuid'];
const TYPING_NAMES = ['Annotated', 'Any', 'ClassVar', 'Protocol', 'Self'];
const THIRD_PARTY: ReadonlyArray<[string, string[]]> = [
  ['fastapi', ['APIRouter', 'Depends', 'FastAPI', 'Request']],
  ['fastapi.responses', ['JSONResponse']],
  ['fastapi.security', ['APIKeyHeader', 'HTTPBasic', 'HTTPBearer']],
  ['pydantic', ['BaseModel', 'ConfigDict', 'Field', 'ValidationError', 'field_validator', 'model_validator']],
];

function stdlibImports(body: string): string[] {
  const plain = STDLIB_MODULES.filter((name) => new RegExp(`\\b${name}\\.`).test(body)).map((name) => `import ${name}`);
  const grouped: string[] = [];
  if (mentions(body, 'Enum')) grouped.push('from enum import Enum');
  const typing = TYPING_NAMES.filter((name) => mentions(body, name));
  if (typing.length > 0) grouped.push(`from typing import ${typing.join(', ')}`);
  return [...plain.sort(), ...grouped.sort()];
}

function thirdPartyImports(body: string): string[] {
  return THIRD_PARTY.map(([module, names]) => ({ module, names: names.filter((name) => mentions(body, name)) }))
    .filter((entry) => entry.names.length > 0)
    .map((entry) => `from ${entry.module} import ${entry.names.join(', ')}`);
}

function mentions(body: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(body);
}

/** `router as orders_router` is used under its alias. */
function boundName(name: string): string {
  return name.split(' as ')[1] ?? name;
}

function docstring(writer: CodeWriter, text: string): void {
  const sanitized = text.replace(/"""/g, "'''").trim();
  const prefix = sanitized.includes('\\') ? 'r' : '';
  const lines = comment(sanitized, '', 108);
  const single = lines.length === 1 && !sanitized.endsWith('"');
  if (single) {
    writer.line(`${prefix}"""${lines[0]}"""`);
    return;
  }
  writer.line(`${prefix}"""${lines[0] ?? ''}`);
  for (const line of lines.slice(1)) writer.line(line);
  writer.line('"""');
}

function pyWriter(): CodeWriter {
  return new CodeWriter('    ');
}

function modulePath(layer: Layer, module: IRModule, fileName: string): string {
  const path = layout.path(layer, module, fileName);
  // `interfaces` reads better than `interface` as a Python package name.
  return layer === 'interface' ? path.replace('/interface/', '/interfaces/') : path;
}

function dotted(path: string): string {
  return path.replace(/\.py$/, '').replace(/\//g, '.');
}
