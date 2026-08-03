/**
 * The `## infrastructure` section.
 *
 *   port 8080
 *   database ordersdb using postgres version 16 storage 50
 *   broker events using kafka topics OrderPlaced, OrderPaid
 *   cache sessions using redis
 *   storage invoices using s3
 *   secrets DB_PASSWORD, KAFKA_PASSWORD
 *   environment LOG_LEVEL = info, REGION = eu-west-1
 *   scaling min 2 max 10 cpu 70
 *   deploy to docker, kubernetes, terraform
 *
 * Values never appear here — only names. Secrets are resolved at deploy time.
 */
import { DEPLOY_TARGETS, type DeployTarget, type IRInfrastructure } from '@haic/core';
import type { ParseReporter } from './reporter.js';
import { readBody, type Section } from './section.js';

const DATABASE_ENGINES = ['postgres', 'mysql', 'mongodb', 'dynamodb', 'sqlite', 'redis'] as const;
const BROKER_ENGINES = ['kafka', 'rabbitmq', 'sqs', 'sns', 'eventbridge', 'nats'] as const;
const CACHE_ENGINES = ['redis', 'memcached', 'in-memory'] as const;
const STORE_ENGINES = ['s3', 'gcs', 'azure-blob', 'minio'] as const;

export function parseInfrastructure(section: Section, reporter: ParseReporter): IRInfrastructure {
  const infrastructure: IRInfrastructure = {
    port: 8080,
    databases: [],
    brokers: [],
    caches: [],
    objectStores: [],
    secrets: [],
    environment: {},
    scaling: { min: 1, max: 3, targetCpuPercent: 70 },
    deploy: [],
    observability: { metrics: true, tracing: true, logLevel: 'info' },
  };

  // Every meaningful line here is a setting; there is no prose in this block.
  const lines = section.body
    .filter((line) => line.text !== '' && !line.text.startsWith('//'))
    .map((line) => ({ ...line, text: line.text.replace(/^[-*]\s+/, '') }));

  for (const line of lines) {
    const text = line.text.trim();
    const span = section.file.spanOf(line);

    const port = /^port\s+(\d+)$/i.exec(text);
    if (port) {
      infrastructure.port = Number(port[1]);
      continue;
    }

    const database = /^database\s+(\w+)(?:\s+using\s+([\w-]+))?(?:\s+version\s+([\w.]+))?(?:\s+storage\s+(\d+))?(\s+multi\s*az)?$/i.exec(text);
    if (database) {
      const engine = (database[2] ?? 'postgres').toLowerCase();
      if (!(DATABASE_ENGINES as readonly string[]).includes(engine)) {
        reporter.error('HADL1501', `unknown database engine "${engine}"`, span, `supported engines: ${DATABASE_ENGINES.join(', ')}`);
        continue;
      }
      const entry: IRInfrastructure['databases'][number] = {
        name: database[1]!,
        engine: engine as (typeof DATABASE_ENGINES)[number],
        storageGb: database[4] ? Number(database[4]) : 20,
        multiAz: Boolean(database[5]),
      };
      if (database[3]) entry.version = database[3];
      infrastructure.databases.push(entry);
      continue;
    }

    const broker = /^broker\s+(\w+)(?:\s+using\s+([\w-]+))?(?:\s+topics?\s+(.*))?$/i.exec(text);
    if (broker) {
      const engine = (broker[2] ?? 'kafka').toLowerCase();
      if (!(BROKER_ENGINES as readonly string[]).includes(engine)) {
        reporter.error('HADL1502', `unknown broker engine "${engine}"`, span, `supported engines: ${BROKER_ENGINES.join(', ')}`);
        continue;
      }
      infrastructure.brokers.push({
        name: broker[1]!,
        engine: engine as (typeof BROKER_ENGINES)[number],
        topics: splitList(broker[3]),
      });
      continue;
    }

    const cache = /^cache\s+(\w+)(?:\s+using\s+([\w-]+))?$/i.exec(text);
    if (cache) {
      const engine = (cache[2] ?? 'redis').toLowerCase();
      if (!(CACHE_ENGINES as readonly string[]).includes(engine)) {
        reporter.error('HADL1503', `unknown cache engine "${engine}"`, span, `supported engines: ${CACHE_ENGINES.join(', ')}`);
        continue;
      }
      infrastructure.caches.push({ name: cache[1]!, engine: engine as (typeof CACHE_ENGINES)[number] });
      continue;
    }

    const store = /^storage\s+(\w+)(?:\s+using\s+([\w-]+))?(\s+public)?$/i.exec(text);
    if (store) {
      const engine = (store[2] ?? 's3').toLowerCase();
      if (!(STORE_ENGINES as readonly string[]).includes(engine)) {
        reporter.error('HADL1504', `unknown object store "${engine}"`, span, `supported stores: ${STORE_ENGINES.join(', ')}`);
        continue;
      }
      infrastructure.objectStores.push({ name: store[1]!, engine: engine as (typeof STORE_ENGINES)[number], public: Boolean(store[3]) });
      continue;
    }

    const secrets = /^secrets?\s+(.*)$/i.exec(text);
    if (secrets) {
      infrastructure.secrets.push(...splitList(secrets[1]));
      continue;
    }

    const environment = /^(?:environment|env)\s+(.*)$/i.exec(text);
    if (environment) {
      for (const pair of splitList(environment[1])) {
        const index = pair.indexOf('=');
        if (index < 0) {
          reporter.error('HADL1505', `expected "NAME = value" in environment entry "${pair}"`, span);
          continue;
        }
        infrastructure.environment[pair.slice(0, index).trim()] = pair.slice(index + 1).trim().replace(/^["']|["']$/g, '');
      }
      continue;
    }

    const scaling = /^scaling\s+(.*)$/i.exec(text);
    if (scaling) {
      const min = /\bmin\s+(\d+)/i.exec(scaling[1]!);
      const max = /\bmax\s+(\d+)/i.exec(scaling[1]!);
      const cpu = /\bcpu\s+(\d+)/i.exec(scaling[1]!);
      if (min) infrastructure.scaling.min = Number(min[1]);
      if (max) infrastructure.scaling.max = Number(max[1]);
      if (cpu) infrastructure.scaling.targetCpuPercent = Number(cpu[1]);
      if (infrastructure.scaling.max < infrastructure.scaling.min) {
        reporter.error('HADL1506', 'scaling max must be greater than or equal to min', span);
      }
      continue;
    }

    const deploy = /^deploy(?:\s+to)?\s+(.*)$/i.exec(text);
    if (deploy) {
      for (const target of splitList(deploy[1])) {
        const normalised = target.toLowerCase().replace(/\s+/g, '-');
        if (!(DEPLOY_TARGETS as readonly string[]).includes(normalised)) {
          reporter.error('HADL1507', `unknown deployment target "${target}"`, span, `supported targets: ${DEPLOY_TARGETS.join(', ')}`);
          continue;
        }
        infrastructure.deploy.push(normalised as DeployTarget);
      }
      continue;
    }

    const observability = /^observability\s+(.*)$/i.exec(text);
    if (observability) {
      const value = observability[1]!.toLowerCase();
      infrastructure.observability.metrics = !/\bmetrics\s+off\b/.test(value);
      infrastructure.observability.tracing = !/\btracing\s+off\b/.test(value);
      const level = /\blog\s+level\s+(debug|info|warn|error)\b/.exec(value);
      if (level) infrastructure.observability.logLevel = level[1] as 'debug' | 'info' | 'warn' | 'error';
      continue;
    }

    reporter.error(
      'HADL1508',
      `"${text}" is not a recognised infrastructure setting`,
      span,
      'valid settings: port, database, broker, cache, storage, secrets, environment, scaling, deploy, observability',
    );
  }

  return infrastructure;
}

function splitList(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
