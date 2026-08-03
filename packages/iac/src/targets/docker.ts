/**
 * Docker target: one image per bounded context, one container per declared resource.
 *
 * The compose file is a mirror of the `## infrastructure` blocks. A project that
 * declares no broker gets no broker service; nothing is added "just in case".
 */
import {
  CodeWriter,
  GENERATED_BANNER,
  file,
  kebabCase,
  type CodegenTarget,
  type Diagnostic,
  type GeneratedFile,
  type InfrastructureGenerator,
} from '@haic/core';
import { IAC_CODE, noContextRequests, unsupportedEngine } from '../shared/diagnostics.js';
import {
  baseEnvironment,
  buildPlan,
  connectionVariable,
  credentialReference,
  unique,
  type ContextPlan,
  type Declared,
  type IRBroker,
  type IRCache,
  type IRDatabase,
  type IRObjectStore,
  type InfrastructurePlan,
} from '../shared/plan.js';
import { yamlDocument } from '../shared/yaml.js';

const NETWORK = 'hadl';
const PLATFORM = 'Docker';

export const dockerGenerator: InfrastructureGenerator = {
  id: 'docker',
  displayName: 'Docker Compose',
  verifyCommand: ['docker', 'compose', 'config'],

  generate(context) {
    const plan = buildPlan(context.project);
    const contexts = plan.targeting('docker');
    if (contexts.length === 0) return { files: [], diagnostics: [noContextRequests(PLATFORM, 'docker')] };

    const diagnostics: Diagnostic[] = [];
    const files: GeneratedFile[] = contexts.map((deployable) => dockerfile(deployable));
    files.push(composeFile(plan, contexts, diagnostics), dockerignore(contexts));
    return { files, diagnostics };
  },
};

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

interface ContainerRuntime {
  readonly builder: string;
  readonly runtime: string;
  /** Dependency installation and build, run in the throwaway build stage. */
  readonly build: readonly string[];
  /** Copies the built artefact into the final stage. */
  readonly install: readonly string[];
  readonly createUser: readonly string[];
  readonly command: string;
  /** Probe run by HEALTHCHECK, using a tool the runtime image already ships. */
  probe(port: number): string;
  readonly ignore: readonly string[];
}

const ALPINE_USER = ['RUN addgroup -S app && adduser -S -G app app'];
const DEBIAN_USER = ['RUN useradd --system --create-home --shell /usr/sbin/nologin app'];

const busyboxProbe = (port: number): string => `wget --quiet --spider http://127.0.0.1:${port}/health || exit 1`;

const RUNTIMES: Record<CodegenTarget, ContainerRuntime> = {
  typescript: {
    builder: 'node:22-alpine',
    runtime: 'node:22-alpine',
    build: ['COPY package.json package-lock.json* ./', 'RUN npm ci', 'COPY . .', 'RUN npm run build'],
    install: [
      'COPY --from=build --chown=app:app /app/node_modules ./node_modules',
      'COPY --from=build --chown=app:app /app/dist ./dist',
      'COPY --from=build --chown=app:app /app/package.json ./package.json',
    ],
    createUser: ALPINE_USER,
    command: 'CMD ["node", "dist/main.js"]',
    probe: busyboxProbe,
    ignore: ['node_modules', 'dist', 'coverage', '*.tsbuildinfo'],
  },
  java: {
    builder: 'maven:3.9-eclipse-temurin-21-alpine',
    runtime: 'eclipse-temurin:21-jre-alpine',
    build: ['COPY pom.xml ./', 'RUN mvn -B -q dependency:go-offline', 'COPY src ./src', 'RUN mvn -B -q -DskipTests package'],
    install: ['COPY --from=build --chown=app:app /app/target/*.jar ./service.jar'],
    createUser: ALPINE_USER,
    command: 'CMD ["java", "-jar", "/app/service.jar"]',
    probe: busyboxProbe,
    ignore: ['target', 'build', '.gradle', '.mvn'],
  },
  python: {
    builder: 'python:3.12-slim',
    runtime: 'python:3.12-slim',
    build: ['COPY requirements.txt ./', 'RUN pip install --no-cache-dir --prefix=/install -r requirements.txt'],
    install: ['COPY --from=build /install /usr/local', 'COPY --chown=app:app . .'],
    createUser: DEBIAN_USER,
    command: 'CMD ["python", "-m", "app.main"]',
    // python:slim carries no wget or curl, so the probe uses the interpreter itself.
    probe: (port) => `python -c 'import urllib.request as r; r.urlopen("http://127.0.0.1:${port}/health")' || exit 1`,
    ignore: ['__pycache__', '*.pyc', '.venv', '.mypy_cache', '.pytest_cache'],
  },
  go: {
    builder: 'golang:1.23-alpine',
    runtime: 'alpine:3.20',
    build: ['COPY go.mod go.sum* ./', 'RUN go mod download', 'COPY . .', 'RUN CGO_ENABLED=0 go build -o /out/service ./...'],
    install: ['COPY --from=build --chown=app:app /out/service ./service'],
    createUser: ALPINE_USER,
    command: 'CMD ["./service"]',
    probe: busyboxProbe,
    ignore: ['bin', 'vendor'],
  },
  rust: {
    builder: 'rust:1.82-alpine',
    runtime: 'alpine:3.20',
    build: [
      'RUN apk add --no-cache musl-dev',
      'COPY Cargo.toml Cargo.lock* ./',
      'COPY src ./src',
      'RUN cargo build --release',
    ],
    install: ['COPY --from=build --chown=app:app /app/target/release/service ./service'],
    createUser: ALPINE_USER,
    command: 'CMD ["./service"]',
    probe: busyboxProbe,
    ignore: ['target'],
  },
};

function dockerfile(plan: ContextPlan): GeneratedFile {
  const runtime = RUNTIMES[plan.language];
  const writer = new CodeWriter();
  writer.line(`# ${GENERATED_BANNER}`);
  writer.line(`# ${plan.context.name} (${plan.language}), listening on ${plan.port}.`);
  writer.line('# syntax=docker/dockerfile:1');
  writer.blank();

  writer.line(`FROM ${runtime.builder} AS build`);
  writer.line('WORKDIR /app');
  writer.lines_(runtime.build);
  writer.blank();

  writer.line(`FROM ${runtime.runtime} AS runtime`);
  writer.line('WORKDIR /app');
  writer.lines_(runtime.createUser);
  writer.lines_(runtime.install);
  for (const [name, value] of Object.entries(baseEnvironment(plan))) writer.line(`ENV ${name}=${value}`);
  writer.line('USER app');
  writer.line(`EXPOSE ${plan.port}`);
  writer.line(`HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 CMD ${runtime.probe(plan.port)}`);
  writer.line(runtime.command);
  return file(`docker/${plan.serviceName}/Dockerfile`, writer.toString());
}

function dockerignore(contexts: readonly ContextPlan[]): GeneratedFile {
  const languages = unique(contexts.map((plan) => plan.language));
  const entries = [
    '.git',
    '.gitignore',
    '.env',
    '.env.*',
    '.dockerignore',
    'docker-compose.yml',
    'docker',
    'charts',
    'terraform',
    ...languages.flatMap((language) => RUNTIMES[language].ignore),
  ];
  return file('.dockerignore', `# ${GENERATED_BANNER}\n${unique(entries).join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// Backing services
// ---------------------------------------------------------------------------

type ComposeService = Record<string, unknown>;

interface ComposeResource {
  /** Containers this resource needs, keyed by compose service name. */
  readonly services: Record<string, ComposeService>;
  readonly volumes: readonly string[];
  /** Connection string handed to the application, with credentials left as references. */
  readonly url: string;
}

/** A compose resource paired with the IR name that asked for it. */
interface ResolvedResource extends ComposeResource {
  readonly declaredName: string;
}

/**
 * Container catalogue. Each entry maps one declared engine to what it takes to
 * run it locally; an engine absent from a table is reported, never guessed at.
 */
const DATABASE_CONTAINERS: Partial<Record<IRDatabase['engine'], (database: IRDatabase) => ComposeResource>> = {
  postgres: (database) =>
    backingService(database.name, {
      image: `postgres:${database.version ?? '16'}-alpine`,
      environment: {
        POSTGRES_DB: database.name,
        POSTGRES_PASSWORD: credentialReference(database.name, 'PASSWORD'),
      },
      port: 5432,
      dataPath: '/var/lib/postgresql/data',
      url: `postgres://postgres:${credentialReference(database.name, 'PASSWORD')}@${kebabCase(database.name)}:5432/${database.name}`,
    }),
  mysql: (database) =>
    backingService(database.name, {
      image: `mysql:${database.version ?? '8'}`,
      environment: {
        MYSQL_DATABASE: database.name,
        MYSQL_ROOT_PASSWORD: credentialReference(database.name, 'PASSWORD'),
      },
      port: 3306,
      dataPath: '/var/lib/mysql',
      url: `mysql://root:${credentialReference(database.name, 'PASSWORD')}@${kebabCase(database.name)}:3306/${database.name}`,
    }),
  mongodb: (database) =>
    backingService(database.name, {
      image: `mongo:${database.version ?? '7'}`,
      environment: {
        MONGO_INITDB_DATABASE: database.name,
        MONGO_INITDB_ROOT_USERNAME: 'root',
        MONGO_INITDB_ROOT_PASSWORD: credentialReference(database.name, 'PASSWORD'),
      },
      port: 27017,
      dataPath: '/data/db',
      url: `mongodb://root:${credentialReference(database.name, 'PASSWORD')}@${kebabCase(database.name)}:27017/${database.name}?authSource=admin`,
    }),
  redis: (database) =>
    backingService(database.name, {
      image: `redis:${database.version ?? '7'}-alpine`,
      port: 6379,
      dataPath: '/data',
      url: `redis://${kebabCase(database.name)}:6379`,
    }),
  dynamodb: (database) =>
    backingService(database.name, {
      image: 'amazon/dynamodb-local:2.5.2',
      command: '-jar DynamoDBLocal.jar -sharedDb -dbPath /home/dynamodblocal/data',
      port: 8000,
      dataPath: '/home/dynamodblocal/data',
      url: `http://${kebabCase(database.name)}:8000`,
    }),
};

const CACHE_CONTAINERS: Partial<Record<IRCache['engine'], (cache: IRCache) => ComposeResource>> = {
  redis: (cache) =>
    backingService(cache.name, {
      image: 'redis:7-alpine',
      port: 6379,
      dataPath: '/data',
      url: `redis://${kebabCase(cache.name)}:6379`,
    }),
  memcached: (cache) =>
    backingService(cache.name, {
      image: 'memcached:1.6-alpine',
      port: 11211,
      url: `memcached://${kebabCase(cache.name)}:11211`,
    }),
};

const BROKER_CONTAINERS: Partial<Record<IRBroker['engine'], (broker: IRBroker) => ComposeResource>> = {
  kafka: (broker) => {
    const name = kebabCase(broker.name);
    const zookeeper = `${name}-zookeeper`;
    const volume = `${name}-data`;
    return {
      services: {
        [zookeeper]: {
          image: 'confluentinc/cp-zookeeper:7.6.1',
          environment: { ZOOKEEPER_CLIENT_PORT: 2181, ZOOKEEPER_TICK_TIME: 2000 },
          expose: [2181],
          networks: [NETWORK],
          restart: 'unless-stopped',
        },
        [name]: {
          image: 'confluentinc/cp-kafka:7.6.1',
          depends_on: [zookeeper],
          environment: {
            KAFKA_BROKER_ID: 1,
            KAFKA_ZOOKEEPER_CONNECT: `${zookeeper}:2181`,
            KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://${name}:9092`,
            KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'PLAINTEXT:PLAINTEXT',
            KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
            KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1,
          },
          expose: [9092],
          volumes: [`${volume}:/var/lib/kafka/data`],
          networks: [NETWORK],
          restart: 'unless-stopped',
        },
      },
      volumes: [volume],
      url: `kafka://${name}:9092`,
    };
  },
  rabbitmq: (broker) =>
    backingService(broker.name, {
      image: 'rabbitmq:3-management-alpine',
      environment: { RABBITMQ_DEFAULT_PASS: credentialReference(broker.name, 'PASSWORD') },
      port: 5672,
      dataPath: '/var/lib/rabbitmq',
      url: `amqp://guest:${credentialReference(broker.name, 'PASSWORD')}@${kebabCase(broker.name)}:5672`,
    }),
  nats: (broker) =>
    backingService(broker.name, {
      image: 'nats:2-alpine',
      port: 4222,
      url: `nats://${kebabCase(broker.name)}:4222`,
    }),
};

const OBJECT_STORE_CONTAINERS: Partial<Record<IRObjectStore['engine'], (store: IRObjectStore) => ComposeResource>> = {
  minio: (store) =>
    backingService(store.name, {
      image: 'minio/minio:RELEASE.2024-10-13T13-34-11Z',
      command: 'server /data --console-address ":9001"',
      environment: {
        MINIO_ROOT_USER: credentialReference(store.name, 'USER'),
        MINIO_ROOT_PASSWORD: credentialReference(store.name, 'PASSWORD'),
      },
      port: 9000,
      dataPath: '/data',
      url: `http://${kebabCase(store.name)}:9000`,
    }),
};

interface BackingServiceSpec {
  readonly image: string;
  readonly command?: string;
  readonly environment?: Record<string, string>;
  readonly port: number;
  readonly dataPath?: string;
  readonly url: string;
}

function backingService(name: string, spec: BackingServiceSpec): ComposeResource {
  const service = kebabCase(name);
  const volume = `${service}-data`;
  const definition: ComposeService = { image: spec.image };
  if (spec.command) definition['command'] = spec.command;
  if (spec.environment) definition['environment'] = spec.environment;
  definition['expose'] = [spec.port];
  if (spec.dataPath) definition['volumes'] = [`${volume}:${spec.dataPath}`];
  definition['networks'] = [NETWORK];
  definition['restart'] = 'unless-stopped';
  return { services: { [service]: definition }, volumes: spec.dataPath ? [volume] : [], url: spec.url };
}

// ---------------------------------------------------------------------------
// docker-compose.yml
// ---------------------------------------------------------------------------

function composeFile(
  plan: InfrastructurePlan,
  contexts: readonly ContextPlan[],
  diagnostics: Diagnostic[],
): GeneratedFile {
  const services: Record<string, ComposeService> = {};
  const volumes: Record<string, null> = {};

  for (const deployable of contexts) {
    const resolved = resourcesOf(deployable, diagnostics);
    for (const resource of resolved) {
      Object.assign(services, resource.services);
      for (const volume of resource.volumes) volumes[volume] = null;
    }
    services[deployable.serviceName] = applicationService(plan, deployable, resolved);
  }

  const compose: Record<string, unknown> = { name: plan.name, services };
  if (Object.keys(volumes).length > 0) compose['volumes'] = volumes;
  compose['networks'] = { [NETWORK]: { driver: 'bridge' } };

  return file(
    'docker-compose.yml',
    yamlDocument(compose, [
      'Only application ports are published; backing services talk over the bridge network.',
      'Every ${VARIABLE} is resolved from the environment. Secret values never live here.',
    ]),
  );
}

/** Resolves the containers a context needs, warning about engines Docker cannot run. */
function resourcesOf(plan: ContextPlan, diagnostics: Diagnostic[]): ResolvedResource[] {
  const resolved: ResolvedResource[] = [];

  const resolve = <T extends { name: string; engine: string }>(
    declared: Declared<T>,
    catalogue: Partial<Record<string, (spec: T) => ComposeResource>>,
    kind: string,
    code: string,
  ): void => {
    const build = catalogue[declared.spec.engine];
    if (!build) {
      diagnostics.push(unsupportedEngine(code, PLATFORM, kind, declared.spec.name, declared.spec.engine, declared.span));
      return;
    }
    resolved.push({ ...build(declared.spec), declaredName: declared.spec.name });
  };

  for (const database of plan.databases) {
    resolve(database, DATABASE_CONTAINERS, 'database', IAC_CODE.unsupportedDatabase);
  }
  for (const cache of plan.caches) {
    // An in-memory cache lives inside the process; there is nothing to run beside it.
    if (cache.spec.engine === 'in-memory') continue;
    resolve(cache, CACHE_CONTAINERS, 'cache', IAC_CODE.unsupportedCache);
  }
  for (const broker of plan.brokers) {
    resolve(broker, BROKER_CONTAINERS, 'broker', IAC_CODE.unsupportedBroker);
  }
  for (const store of plan.objectStores) {
    resolve(store, OBJECT_STORE_CONTAINERS, 'object store', IAC_CODE.unsupportedObjectStore);
  }
  return resolved;
}

function applicationService(
  plan: InfrastructurePlan,
  deployable: ContextPlan,
  resources: readonly ResolvedResource[],
): ComposeService {
  const dependencies = resources.flatMap((resource) => Object.keys(resource.services));
  const environment: Record<string, string | number> = { ...baseEnvironment(deployable) };
  for (const resource of resources) environment[connectionVariable(resource.declaredName)] = resource.url;

  const service: ComposeService = {
    build: { context: '.', dockerfile: `docker/${deployable.serviceName}/Dockerfile` },
    image: `${plan.name}/${deployable.serviceName}:latest`,
    // `required: false` keeps `docker compose config` working before anyone writes a .env.
    env_file: [{ path: '.env', required: false }],
    environment,
    ports: [{ target: deployable.port, published: deployable.port, protocol: 'tcp' }],
    networks: [NETWORK],
    restart: 'unless-stopped',
  };
  if (dependencies.length > 0) service['depends_on'] = dependencies;
  return service;
}
