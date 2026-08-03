/**
 * Terraform target: layered AWS modules under `terraform/`.
 *
 * Every resource comes from a declaration. `database ordersdb using postgres
 * version 16 storage 50` is the only reason an `aws_db_instance` with
 * `engine_version = "16"` and `allocated_storage = 50` exists in the output.
 * Sizes, regions and retention are variables with defaults; no credential and
 * no account id is ever written into a resource.
 */
import {
  file,
  kebabCase,
  screamingSnakeCase,
  type Diagnostic,
  type GeneratedFile,
  type InfrastructureGenerator,
} from '@haic/core';
import { IAC_CODE, noContextRequests, unsupportedEngine } from '../shared/diagnostics.js';
import {
  HclWriter,
  hclDocument,
  identifier,
  list,
  object,
  outputsDocument,
  quote,
  variablesDocument,
  type HclEntry,
  type HclOutput,
  type HclVariable,
} from '../shared/hcl.js';
import {
  baseEnvironment,
  buildPlan,
  unique,
  type ContextPlan,
  type Declared,
  type IRBroker,
  type IRCache,
  type IRDatabase,
  type IRObjectStore,
  type InfrastructurePlan,
} from '../shared/plan.js';

const PLATFORM = 'Terraform';
const DEFAULT_REGION = 'us-east-1';

export const terraformGenerator: InfrastructureGenerator = {
  id: 'terraform',
  displayName: 'Terraform (AWS)',
  verifyCommand: ['terraform', 'validate'],

  generate(context) {
    const plan = buildPlan(context.project);
    const contexts = plan.targeting('terraform');
    if (contexts.length === 0) return { files: [], diagnostics: [noContextRequests(PLATFORM, 'terraform')] };

    const diagnostics: Diagnostic[] = [];
    const data = dataResources(contexts, diagnostics);
    const files: GeneratedFile[] = [
      ...rootModule(plan, contexts, data),
      ...networkModule(),
      ...securityModule(contexts, data),
      // A project that declares no backing service gets no data module at all.
      ...(data.resources.length > 0 ? dataModule(data) : []),
      ...computeModule(contexts),
    ];
    return { files, diagnostics };
  },
};

/** Terraform resource labels: letters, digits and underscores. */
function tfName(name: string): string {
  return identifier(kebabCase(name)).replace(/-/g, '_');
}

// ---------------------------------------------------------------------------
// Declared resources -> AWS resources
// ---------------------------------------------------------------------------

/** Everything one declared resource contributes to the `data` module. */
interface DataResource {
  readonly declaredName: string;
  readonly write: (writer: HclWriter) => void;
  readonly variables: readonly HclVariable[];
  readonly outputs: readonly HclOutput[];
  /** Port the service reaches this resource on; drives the security group rules. */
  readonly port: number | null;
}

interface DataPlan {
  readonly resources: readonly DataResource[];
  /** IAM statements the task role needs, scoped to the declared resources. */
  readonly policies: readonly PolicyStatement[];
  readonly secrets: readonly string[];
}

interface PolicyStatement {
  readonly sid: string;
  readonly actions: readonly string[];
  /** Terraform expressions producing the allowed ARNs. */
  readonly resources: readonly string[];
}

const RELATIONAL_VARIABLES: HclVariable[] = [
  { name: 'backup_retention_days', type: 'number', description: 'How long automated backups are kept.', default: '7' },
  {
    name: 'skip_final_snapshot',
    type: 'bool',
    description: 'Skip the final snapshot when a database is destroyed.',
    default: 'true',
  },
  { name: 'apply_immediately', type: 'bool', description: 'Apply changes without waiting for the window.', default: 'false' },
];

const DATABASE_RESOURCES: Partial<Record<IRDatabase['engine'], (database: IRDatabase) => DataResource>> = {
  postgres: (database) => relationalDatabase(database, 5432),
  mysql: (database) => relationalDatabase(database, 3306),
  mongodb: (database) => documentDatabase(database),
  dynamodb: (database) => keyValueTable(database),
  redis: (database) => elasticache(database.name, 'redis', 6379),
};

const CACHE_RESOURCES: Partial<Record<IRCache['engine'], (cache: IRCache) => DataResource>> = {
  redis: (cache) => elasticache(cache.name, 'redis', 6379),
  memcached: (cache) => elasticache(cache.name, 'memcached', 11211),
};

const BROKER_RESOURCES: Partial<Record<IRBroker['engine'], (broker: IRBroker) => DataResource>> = {
  kafka: (broker) => managedKafka(broker),
  rabbitmq: (broker) => managedRabbitmq(broker),
  sqs: (broker) => queues(broker),
  sns: (broker) => topics(broker),
  eventbridge: (broker) => eventBus(broker),
};

const OBJECT_STORE_RESOURCES: Partial<Record<IRObjectStore['engine'], (store: IRObjectStore) => DataResource>> = {
  s3: (store) => bucket(store),
};

function relationalDatabase(database: IRDatabase, port: number): DataResource {
  const id = tfName(database.name);
  const slug = kebabCase(database.name);
  return {
    declaredName: database.name,
    port,
    variables: [
      ...RELATIONAL_VARIABLES,
      {
        name: `${id}_instance_class`,
        type: 'string',
        description: `Instance class for the "${database.name}" database.`,
        default: quote('db.t4g.micro'),
      },
      {
        name: `${id}_username`,
        type: 'string',
        description: `Master user of "${database.name}". The password is generated into Secrets Manager.`,
        default: quote('ail_admin'),
      },
    ],
    outputs: [
      { name: `${id}_endpoint`, value: `aws_db_instance.${id}.address`, description: `Endpoint of "${database.name}".` },
      {
        name: `${id}_master_secret_arn`,
        value: `aws_db_instance.${id}.master_user_secret[0].secret_arn`,
        description: `Secrets Manager entry holding the "${database.name}" master password.`,
      },
    ],
    write: (writer) => {
      writer.block(`resource "aws_db_subnet_group" ${quote(id)}`, (body) =>
        body.attributes([
          ['name', `"\${var.name_prefix}-${slug}"`],
          ['subnet_ids', 'var.subnet_ids'],
          ['tags', 'var.tags'],
        ]),
      );
      writer.blank();
      writer.block(`resource "aws_db_instance" ${quote(id)}`, (body) =>
        body.attributes([
          ['identifier', `"\${var.name_prefix}-${slug}"`],
          ['engine', quote(database.engine)],
          ...(database.version ? ([['engine_version', quote(database.version)]] as HclEntry[]) : []),
          ['instance_class', `var.${id}_instance_class`],
          ['allocated_storage', String(database.storageGb)],
          ['db_name', quote(database.name)],
          ['username', `var.${id}_username`],
          // AWS creates and rotates the master password; it never reaches this file.
          ['manage_master_user_password', 'true'],
          ['multi_az', String(database.multiAz)],
          ['storage_encrypted', 'true'],
          ['db_subnet_group_name', `aws_db_subnet_group.${id}.name`],
          ['vpc_security_group_ids', 'var.security_group_ids'],
          ['backup_retention_period', 'var.backup_retention_days'],
          ['skip_final_snapshot', 'var.skip_final_snapshot'],
          ['apply_immediately', 'var.apply_immediately'],
          ['tags', 'var.tags'],
        ]),
      );
    },
  };
}

function documentDatabase(database: IRDatabase): DataResource {
  const id = tfName(database.name);
  const slug = kebabCase(database.name);
  return {
    declaredName: database.name,
    port: 27017,
    variables: [
      ...RELATIONAL_VARIABLES,
      { name: 'docdb_instance_count', type: 'number', description: 'Instances in each DocumentDB cluster.', default: '1' },
      {
        name: `${id}_instance_class`,
        type: 'string',
        description: `Instance class for the "${database.name}" cluster.`,
        default: quote('db.t4g.medium'),
      },
      { name: `${id}_username`, type: 'string', description: `Master user of "${database.name}".`, default: quote('ail_admin') },
    ],
    outputs: [
      { name: `${id}_endpoint`, value: `aws_docdb_cluster.${id}.endpoint`, description: `Endpoint of "${database.name}".` },
    ],
    write: (writer) => {
      writer.block(`resource "aws_docdb_subnet_group" ${quote(id)}`, (body) =>
        body.attributes([
          ['name', `"\${var.name_prefix}-${slug}"`],
          ['subnet_ids', 'var.subnet_ids'],
          ['tags', 'var.tags'],
        ]),
      );
      writer.blank();
      writer.block(`resource "aws_docdb_cluster" ${quote(id)}`, (body) =>
        body.attributes([
          ['cluster_identifier', `"\${var.name_prefix}-${slug}"`],
          ['engine', quote('docdb')],
          ...(database.version ? ([['engine_version', quote(database.version)]] as HclEntry[]) : []),
          ['master_username', `var.${id}_username`],
          ['manage_master_user_password', 'true'],
          ['storage_encrypted', 'true'],
          ['db_subnet_group_name', `aws_docdb_subnet_group.${id}.name`],
          ['vpc_security_group_ids', 'var.security_group_ids'],
          ['backup_retention_period', 'var.backup_retention_days'],
          ['skip_final_snapshot', 'var.skip_final_snapshot'],
          ['tags', 'var.tags'],
        ]),
      );
      writer.blank();
      writer.block(`resource "aws_docdb_cluster_instance" ${quote(id)}`, (body) =>
        body.attributes([
          ['count', 'var.docdb_instance_count'],
          ['identifier', `"\${var.name_prefix}-${slug}-\${count.index}"`],
          ['cluster_identifier', `aws_docdb_cluster.${id}.id`],
          ['instance_class', `var.${id}_instance_class`],
          ['tags', 'var.tags'],
        ]),
      );
    },
  };
}

function keyValueTable(database: IRDatabase): DataResource {
  const id = tfName(database.name);
  return {
    declaredName: database.name,
    port: null,
    variables: [],
    outputs: [{ name: `${id}_table`, value: `aws_dynamodb_table.${id}.name`, description: `Name of "${database.name}".` }],
    write: (writer) => {
      writer.block(`resource "aws_dynamodb_table" ${quote(id)}`, (body) => {
        body.attributes([
          ['name', `"\${var.name_prefix}-${kebabCase(database.name)}"`],
          ['billing_mode', quote('PAY_PER_REQUEST')],
          ['hash_key', quote('id')],
          ['tags', 'var.tags'],
        ]);
        body.blank();
        body.block('attribute', (attribute) =>
          attribute.attributes([
            ['name', quote('id')],
            ['type', quote('S')],
          ]),
        );
        body.blank();
        body.block('point_in_time_recovery', (recovery) => recovery.attribute('enabled', 'true'));
      });
    },
  };
}

function elasticache(name: string, engine: 'redis' | 'memcached', port: number): DataResource {
  const id = tfName(name);
  const slug = kebabCase(name);
  return {
    declaredName: name,
    port,
    variables: [
      {
        name: `${id}_node_type`,
        type: 'string',
        description: `Node type for the "${name}" cache.`,
        default: quote('cache.t4g.micro'),
      },
    ],
    outputs: [
      {
        name: `${id}_endpoint`,
        value: `aws_elasticache_cluster.${id}.cache_nodes[0].address`,
        description: `Endpoint of "${name}".`,
      },
    ],
    write: (writer) => {
      writer.block(`resource "aws_elasticache_subnet_group" ${quote(id)}`, (body) =>
        body.attributes([
          ['name', `"\${var.name_prefix}-${slug}"`],
          ['subnet_ids', 'var.subnet_ids'],
          ['tags', 'var.tags'],
        ]),
      );
      writer.blank();
      writer.block(`resource "aws_elasticache_cluster" ${quote(id)}`, (body) =>
        body.attributes([
          ['cluster_id', `"\${var.name_prefix}-${slug}"`],
          ['engine', quote(engine)],
          ['node_type', `var.${id}_node_type`],
          ['num_cache_nodes', '1'],
          ['port', String(port)],
          ['subnet_group_name', `aws_elasticache_subnet_group.${id}.name`],
          ['security_group_ids', 'var.security_group_ids'],
          ['tags', 'var.tags'],
        ]),
      );
    },
  };
}

function managedKafka(broker: IRBroker): DataResource {
  const id = tfName(broker.name);
  return {
    declaredName: broker.name,
    port: 9092,
    variables: [
      { name: 'msk_volume_size', type: 'number', description: 'EBS volume size per broker, in GiB.', default: '100' },
      {
        name: `${id}_instance_type`,
        type: 'string',
        description: `Broker instance type for "${broker.name}".`,
        default: quote('kafka.t3.small'),
      },
      { name: `${id}_version`, type: 'string', description: `Kafka version for "${broker.name}".`, default: quote('3.6.0') },
    ],
    outputs: [
      {
        name: `${id}_bootstrap_brokers`,
        value: `aws_msk_cluster.${id}.bootstrap_brokers_tls`,
        description: `Bootstrap servers of "${broker.name}".`,
      },
    ],
    write: (writer) => {
      // Topics are created by the application: MSK exposes no Terraform resource for them.
      for (const topic of broker.topics) writer.comment(`declared topic "${topic}"`);
      writer.block(`resource "aws_msk_cluster" ${quote(id)}`, (body) => {
        body.attributes([
          ['cluster_name', `"\${var.name_prefix}-${kebabCase(broker.name)}"`],
          ['kafka_version', `var.${id}_version`],
          ['number_of_broker_nodes', 'length(var.subnet_ids)'],
          ['tags', 'var.tags'],
        ]);
        body.blank();
        body.block('broker_node_group_info', (group) => {
          group.attributes([
            ['instance_type', `var.${id}_instance_type`],
            ['client_subnets', 'var.subnet_ids'],
            ['security_groups', 'var.security_group_ids'],
          ]);
          group.blank();
          group.block('storage_info', (storage) =>
            storage.block('ebs_storage_info', (ebs) => ebs.attribute('volume_size', 'var.msk_volume_size')),
          );
        });
        body.blank();
        body.block('encryption_info', (encryption) =>
          encryption.block('encryption_in_transit', (transit) =>
            transit.attributes([
              ['client_broker', quote('TLS')],
              ['in_cluster', 'true'],
            ]),
          ),
        );
      });
    },
  };
}

function managedRabbitmq(broker: IRBroker): DataResource {
  const id = tfName(broker.name);
  return {
    declaredName: broker.name,
    port: 5671,
    variables: [
      {
        name: 'rabbitmq_engine_version',
        type: 'string',
        description: 'Amazon MQ RabbitMQ engine version.',
        default: quote('3.13'),
      },
      {
        name: `${id}_instance_type`,
        type: 'string',
        description: `Broker instance type for "${broker.name}".`,
        default: quote('mq.t3.micro'),
      },
      { name: `${id}_username`, type: 'string', description: `Broker user of "${broker.name}".`, default: quote('ail_admin') },
      {
        name: `${id}_password`,
        type: 'string',
        description: `Broker password of "${broker.name}". Supply it from your secret store; there is no default.`,
        sensitive: true,
      },
    ],
    outputs: [
      {
        name: `${id}_endpoints`,
        value: `aws_mq_broker.${id}.instances[0].endpoints`,
        description: `Endpoints of "${broker.name}".`,
      },
    ],
    write: (writer) => {
      writer.block(`resource "aws_mq_broker" ${quote(id)}`, (body) => {
        body.attributes([
          ['broker_name', `"\${var.name_prefix}-${kebabCase(broker.name)}"`],
          ['engine_type', quote('RabbitMQ')],
          ['engine_version', 'var.rabbitmq_engine_version'],
          ['host_instance_type', `var.${id}_instance_type`],
          ['deployment_mode', quote('SINGLE_INSTANCE')],
          ['publicly_accessible', 'false'],
          ['subnet_ids', 'slice(var.subnet_ids, 0, 1)'],
          ['security_groups', 'var.security_group_ids'],
          ['tags', 'var.tags'],
        ]);
        body.blank();
        body.block('user', (user) =>
          user.attributes([
            ['username', `var.${id}_username`],
            ['password', `var.${id}_password`],
          ]),
        );
      });
    },
  };
}

function queues(broker: IRBroker): DataResource {
  const id = tfName(broker.name);
  const declared = broker.topics.length > 0 ? broker.topics : [broker.name];
  return {
    declaredName: broker.name,
    port: null,
    variables: [
      {
        name: 'queue_max_receive_count',
        type: 'number',
        description: 'Deliveries before a message moves to the dead-letter queue.',
        default: '5',
      },
    ],
    outputs: declared.map((topic) => ({
      name: `${id}_${tfName(topic)}_url`,
      value: `aws_sqs_queue.${id}_${tfName(topic)}.url`,
      description: `URL of the "${topic}" queue.`,
    })),
    write: (writer) => {
      declared.forEach((topic, position) => {
        if (position > 0) writer.blank();
        const queue = `${id}_${tfName(topic)}`;
        writer.block(`resource "aws_sqs_queue" ${quote(`${queue}_dlq`)}`, (body) =>
          body.attributes([
            ['name', `"\${var.name_prefix}-${kebabCase(topic)}-dlq"`],
            ['sqs_managed_sse_enabled', 'true'],
            ['tags', 'var.tags'],
          ]),
        );
        writer.blank();
        writer.block(`resource "aws_sqs_queue" ${quote(queue)}`, (body) =>
          body.attributes([
            ['name', `"\${var.name_prefix}-${kebabCase(topic)}"`],
            ['sqs_managed_sse_enabled', 'true'],
            [
              'redrive_policy',
              `jsonencode({ deadLetterTargetArn = aws_sqs_queue.${queue}_dlq.arn, maxReceiveCount = var.queue_max_receive_count })`,
            ],
            ['tags', 'var.tags'],
          ]),
        );
      });
    },
  };
}

function topics(broker: IRBroker): DataResource {
  const id = tfName(broker.name);
  const declared = broker.topics.length > 0 ? broker.topics : [broker.name];
  return {
    declaredName: broker.name,
    port: null,
    variables: [],
    outputs: declared.map((topic) => ({
      name: `${id}_${tfName(topic)}_arn`,
      value: `aws_sns_topic.${id}_${tfName(topic)}.arn`,
      description: `ARN of the "${topic}" topic.`,
    })),
    write: (writer) => {
      declared.forEach((topic, position) => {
        if (position > 0) writer.blank();
        writer.block(`resource "aws_sns_topic" ${quote(`${id}_${tfName(topic)}`)}`, (body) =>
          body.attributes([
            ['name', `"\${var.name_prefix}-${kebabCase(topic)}"`],
            ['tags', 'var.tags'],
          ]),
        );
      });
    },
  };
}

function eventBus(broker: IRBroker): DataResource {
  const id = tfName(broker.name);
  return {
    declaredName: broker.name,
    port: null,
    variables: [],
    outputs: [
      { name: `${id}_event_bus_arn`, value: `aws_cloudwatch_event_bus.${id}.arn`, description: `ARN of "${broker.name}".` },
    ],
    write: (writer) => {
      writer.block(`resource "aws_cloudwatch_event_bus" ${quote(id)}`, (body) =>
        body.attributes([
          ['name', `"\${var.name_prefix}-${kebabCase(broker.name)}"`],
          ['tags', 'var.tags'],
        ]),
      );
    },
  };
}

function bucket(store: IRObjectStore): DataResource {
  const id = tfName(store.name);
  const blocked = String(!store.public);
  return {
    declaredName: store.name,
    port: null,
    variables: [],
    outputs: [{ name: `${id}_bucket`, value: `aws_s3_bucket.${id}.bucket`, description: `Name of "${store.name}".` }],
    write: (writer) => {
      writer.block(`resource "aws_s3_bucket" ${quote(id)}`, (body) =>
        body.attributes([
          ['bucket', `"\${var.name_prefix}-${kebabCase(store.name)}"`],
          ['tags', 'var.tags'],
        ]),
      );
      writer.blank();
      writer.block(`resource "aws_s3_bucket_public_access_block" ${quote(id)}`, (body) =>
        body.attributes([
          ['bucket', `aws_s3_bucket.${id}.id`],
          ['block_public_acls', blocked],
          ['block_public_policy', blocked],
          ['ignore_public_acls', blocked],
          ['restrict_public_buckets', blocked],
        ]),
      );
      writer.blank();
      writer.block(`resource "aws_s3_bucket_server_side_encryption_configuration" ${quote(id)}`, (body) => {
        body.attribute('bucket', `aws_s3_bucket.${id}.id`);
        body.blank();
        body.block('rule', (rule) =>
          rule.block('apply_server_side_encryption_by_default', (encryption) =>
            encryption.attribute('sse_algorithm', quote('AES256')),
          ),
        );
      });
    },
  };
}

/** Walks every declared resource once and reports the engines AWS has no answer for. */
function dataResources(contexts: readonly ContextPlan[], diagnostics: Diagnostic[]): DataPlan {
  const resources: DataResource[] = [];
  const policies: PolicyStatement[] = [];
  const secrets = new Set<string>();

  const resolve = <T extends { name: string; engine: string }>(
    declared: Declared<T>,
    catalogue: Partial<Record<string, (spec: T) => DataResource>>,
    kind: string,
    code: string,
  ): void => {
    const build = catalogue[declared.spec.engine];
    if (!build) {
      diagnostics.push(unsupportedEngine(code, PLATFORM, kind, declared.spec.name, declared.spec.engine, declared.span));
      return;
    }
    resources.push(build(declared.spec));
  };

  for (const plan of contexts) {
    for (const secret of plan.secrets) secrets.add(secret);
    for (const database of plan.databases) {
      resolve(database, DATABASE_RESOURCES, 'database', IAC_CODE.unsupportedDatabase);
      if (database.spec.engine === 'dynamodb') policies.push(dynamoPolicy(database.spec.name));
    }
    for (const cache of plan.caches) {
      // An in-memory cache lives inside the process; there is nothing to provision.
      if (cache.spec.engine === 'in-memory') continue;
      resolve(cache, CACHE_RESOURCES, 'cache', IAC_CODE.unsupportedCache);
    }
    for (const broker of plan.brokers) {
      resolve(broker, BROKER_RESOURCES, 'broker', IAC_CODE.unsupportedBroker);
      if (broker.spec.engine === 'sqs') policies.push(queuePolicy());
      if (broker.spec.engine === 'sns') policies.push(topicPolicy());
      if (broker.spec.engine === 'eventbridge') policies.push(eventBusPolicy());
    }
    for (const store of plan.objectStores) {
      resolve(store, OBJECT_STORE_RESOURCES, 'object store', IAC_CODE.unsupportedObjectStore);
      if (store.spec.engine === 's3') policies.push(bucketPolicy(store.spec.name));
    }
  }
  return { resources, policies, secrets: [...secrets] };
}

const ARN = '"arn:${data.aws_partition.current.partition}';
const ACCOUNT = '${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}';

function dynamoPolicy(name: string): PolicyStatement {
  return {
    sid: 'DynamoDbAccess',
    actions: [
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
      'dynamodb:Query',
      'dynamodb:Scan',
    ],
    resources: [`${ARN}:dynamodb:${ACCOUNT}:table/\${var.name_prefix}-${kebabCase(name)}"`],
  };
}

function queuePolicy(): PolicyStatement {
  return {
    sid: 'QueueAccess',
    actions: ['sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl'],
    resources: [`${ARN}:sqs:${ACCOUNT}:\${var.name_prefix}-*"`],
  };
}

function topicPolicy(): PolicyStatement {
  return { sid: 'TopicAccess', actions: ['sns:Publish'], resources: [`${ARN}:sns:${ACCOUNT}:\${var.name_prefix}-*"`] };
}

function eventBusPolicy(): PolicyStatement {
  return {
    sid: 'EventBusAccess',
    actions: ['events:PutEvents'],
    resources: [`${ARN}:events:${ACCOUNT}:event-bus/\${var.name_prefix}-*"`],
  };
}

function bucketPolicy(name: string): PolicyStatement {
  const arn = `${ARN}:s3:::\${var.name_prefix}-${kebabCase(name)}`;
  return {
    sid: 'ObjectStoreAccess',
    actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
    resources: [`${arn}"`, `${arn}/*"`],
  };
}

// ---------------------------------------------------------------------------
// Root module
// ---------------------------------------------------------------------------

function rootModule(plan: InfrastructurePlan, contexts: readonly ContextPlan[], data: DataPlan): GeneratedFile[] {
  const region = contexts.map((context) => context.environment['REGION'] ?? context.environment['AWS_REGION']).find(Boolean);

  const main = hclDocument((writer) => {
    writer.block('provider "aws"', (body) => {
      body.attribute('region', 'var.region');
      body.blank();
      body.block('default_tags', (tags) => tags.attribute('tags', 'local.tags'));
    });
    writer.blank();
    writer.block('locals', (body) =>
      body.attributes([
        ['name_prefix', '"${var.project}-${var.environment}"'],
        [
          'tags',
          object([
            ['Project', 'var.project'],
            ['Environment', 'var.environment'],
            ['ManagedBy', quote('hadl')],
          ]),
        ],
      ]),
    );
    writer.blank();
    writer.block('module "network"', (body) =>
      body.attributes([
        ['source', quote('./modules/network')],
        ['name_prefix', 'local.name_prefix'],
        ['vpc_cidr', 'var.vpc_cidr'],
        ['availability_zone_count', 'var.availability_zone_count'],
        ['tags', 'local.tags'],
      ]),
    );
    writer.blank();
    writer.block('module "security"', (body) =>
      body.attributes([
        ['source', quote('./modules/security')],
        ['name_prefix', 'local.name_prefix'],
        ['vpc_id', 'module.network.vpc_id'],
        ['vpc_cidr', 'var.vpc_cidr'],
        ['tags', 'local.tags'],
      ]),
    );
    if (data.resources.length > 0) {
      writer.blank();
      writer.block('module "data"', (body) =>
        body.attributes([
          ['source', quote('./modules/data')],
          ['name_prefix', 'local.name_prefix'],
          ['subnet_ids', 'module.network.private_subnet_ids'],
          ['security_group_ids', 'module.security.data_security_group_ids'],
          ['tags', 'local.tags'],
        ]),
      );
    }
    writer.blank();
    writer.block('module "compute"', (body) =>
      body.attributes([
        ['source', quote('./modules/compute')],
        ['name_prefix', 'local.name_prefix'],
        ['region', 'var.region'],
        ['subnet_ids', 'module.network.private_subnet_ids'],
        ['security_group_ids', list(['module.security.service_security_group_id'])],
        ['execution_role_arn', 'module.security.execution_role_arn'],
        ['task_role_arn', 'module.security.task_role_arn'],
        ['secret_arns', 'module.security.secret_arns'],
        ['tags', 'local.tags'],
      ]),
    );
  });

  const variables: HclVariable[] = [
    { name: 'project', type: 'string', description: 'Project name; prefixes every resource.', default: quote(plan.name) },
    { name: 'environment', type: 'string', description: 'Deployment environment.', default: quote('dev') },
    { name: 'region', type: 'string', description: 'AWS region.', default: quote(region ?? DEFAULT_REGION) },
    { name: 'vpc_cidr', type: 'string', description: 'CIDR block of the VPC.', default: quote('10.0.0.0/16') },
    {
      name: 'availability_zone_count',
      type: 'number',
      description: 'How many availability zones the subnets spread over.',
      default: '2',
    },
  ];

  const outputs: HclOutput[] = [
    { name: 'vpc_id', value: 'module.network.vpc_id', description: 'Identifier of the generated VPC.' },
    { name: 'cluster_name', value: 'module.compute.cluster_name', description: 'ECS cluster running the services.' },
    { name: 'service_names', value: 'module.compute.service_names', description: 'One ECS service per bounded context.' },
    { name: 'secret_arns', value: 'module.security.secret_arns', description: 'Secrets Manager entry per declared secret.' },
    ...data.resources.flatMap((resource) =>
      resource.outputs.map((output) => ({
        name: output.name,
        value: `module.data.${output.name}`,
        description: output.description,
      })),
    ),
  ];

  const versions = hclDocument((writer) =>
    writer.block('terraform', (body) => {
      body.attribute('required_version', quote('>= 1.6.0'));
      body.blank();
      body.block('required_providers', (providers) =>
        providers.block('aws =', (aws) =>
          aws.attributes([
            ['source', quote('hashicorp/aws')],
            ['version', quote('~> 5.0')],
          ]),
        ),
      );
    }),
  );

  return [
    file('terraform/main.tf', main),
    file('terraform/variables.tf', variablesDocument(variables)),
    file('terraform/outputs.tf', outputsDocument(outputs)),
    file('terraform/versions.tf', versions),
  ];
}

// ---------------------------------------------------------------------------
// modules/network
// ---------------------------------------------------------------------------

function networkModule(): GeneratedFile[] {
  const main = hclDocument((writer) => {
    writer.block('data "aws_availability_zones" "available"', (body) => body.attribute('state', quote('available')));
    writer.blank();
    writer.block('locals', (body) =>
      body.attribute('azs', 'slice(data.aws_availability_zones.available.names, 0, var.availability_zone_count)'),
    );
    writer.blank();
    writer.block('resource "aws_vpc" "main"', (body) =>
      body.attributes([
        ['cidr_block', 'var.vpc_cidr'],
        ['enable_dns_support', 'true'],
        ['enable_dns_hostnames', 'true'],
        ['tags', 'merge(var.tags, { Name = "${var.name_prefix}-vpc" })'],
      ]),
    );
    writer.blank();
    writer.block('resource "aws_internet_gateway" "main"', (body) =>
      body.attributes([
        ['vpc_id', 'aws_vpc.main.id'],
        ['tags', 'merge(var.tags, { Name = "${var.name_prefix}-igw" })'],
      ]),
    );
    writer.blank();
    writer.block('resource "aws_subnet" "public"', (body) =>
      body.attributes([
        ['count', 'var.availability_zone_count'],
        ['vpc_id', 'aws_vpc.main.id'],
        ['cidr_block', 'cidrsubnet(var.vpc_cidr, 4, count.index)'],
        ['availability_zone', 'local.azs[count.index]'],
        ['map_public_ip_on_launch', 'true'],
        ['tags', 'merge(var.tags, { Name = "${var.name_prefix}-public-${count.index}" })'],
      ]),
    );
    writer.blank();
    writer.block('resource "aws_subnet" "private"', (body) =>
      body.attributes([
        ['count', 'var.availability_zone_count'],
        ['vpc_id', 'aws_vpc.main.id'],
        ['cidr_block', 'cidrsubnet(var.vpc_cidr, 4, count.index + var.availability_zone_count)'],
        ['availability_zone', 'local.azs[count.index]'],
        ['tags', 'merge(var.tags, { Name = "${var.name_prefix}-private-${count.index}" })'],
      ]),
    );
    writer.blank();
    writer.block('resource "aws_eip" "nat"', (body) =>
      body.attributes([
        ['domain', quote('vpc')],
        ['tags', 'merge(var.tags, { Name = "${var.name_prefix}-nat" })'],
      ]),
    );
    writer.blank();
    writer.block('resource "aws_nat_gateway" "main"', (body) =>
      body.attributes([
        ['allocation_id', 'aws_eip.nat.id'],
        ['subnet_id', 'aws_subnet.public[0].id'],
        ['depends_on', list(['aws_internet_gateway.main'])],
        ['tags', 'merge(var.tags, { Name = "${var.name_prefix}-nat" })'],
      ]),
    );
    writer.blank();
    writer.block('resource "aws_route_table" "public"', (body) => {
      body.attribute('vpc_id', 'aws_vpc.main.id');
      body.blank();
      body.block('route', (route) =>
        route.attributes([
          ['cidr_block', quote('0.0.0.0/0')],
          ['gateway_id', 'aws_internet_gateway.main.id'],
        ]),
      );
      body.blank();
      body.attribute('tags', 'merge(var.tags, { Name = "${var.name_prefix}-public" })');
    });
    writer.blank();
    writer.block('resource "aws_route_table" "private"', (body) => {
      body.attribute('vpc_id', 'aws_vpc.main.id');
      body.blank();
      body.block('route', (route) =>
        route.attributes([
          ['cidr_block', quote('0.0.0.0/0')],
          ['nat_gateway_id', 'aws_nat_gateway.main.id'],
        ]),
      );
      body.blank();
      body.attribute('tags', 'merge(var.tags, { Name = "${var.name_prefix}-private" })');
    });
    for (const tier of ['public', 'private'] as const) {
      writer.blank();
      writer.block(`resource "aws_route_table_association" ${quote(tier)}`, (body) =>
        body.attributes([
          ['count', 'var.availability_zone_count'],
          ['subnet_id', `aws_subnet.${tier}[count.index].id`],
          ['route_table_id', `aws_route_table.${tier}.id`],
        ]),
      );
    }
  });

  return [
    file('terraform/modules/network/main.tf', main),
    file(
      'terraform/modules/network/variables.tf',
      variablesDocument([
        { name: 'name_prefix', type: 'string', description: 'Prefix applied to every resource name.' },
        { name: 'vpc_cidr', type: 'string', description: 'CIDR block of the VPC.' },
        { name: 'availability_zone_count', type: 'number', description: 'Number of availability zones to use.' },
        { name: 'tags', type: 'map(string)', description: 'Tags applied to every resource.', default: '{}' },
      ]),
    ),
    file(
      'terraform/modules/network/outputs.tf',
      outputsDocument([
        { name: 'vpc_id', value: 'aws_vpc.main.id', description: 'Identifier of the VPC.' },
        { name: 'public_subnet_ids', value: 'aws_subnet.public[*].id', description: 'Public subnets.' },
        { name: 'private_subnet_ids', value: 'aws_subnet.private[*].id', description: 'Private subnets.' },
      ]),
    ),
  ];
}

// ---------------------------------------------------------------------------
// modules/security
// ---------------------------------------------------------------------------

function securityModule(contexts: readonly ContextPlan[], data: DataPlan): GeneratedFile[] {
  const servicePorts = unique(contexts.map((plan) => plan.port));
  const dataPorts = unique(data.resources.map((resource) => resource.port).filter((port): port is number => port !== null));

  const main = hclDocument((writer) => {
    writer.comment('Partition, region and account come from the provider; none of them is hardcoded.');
    for (const source of ['aws_partition', 'aws_region', 'aws_caller_identity']) {
      writer.block(`data ${quote(source)} "current"`, () => undefined);
    }
    writer.blank();
    writer.block('resource "aws_security_group" "service"', (body) =>
      body.attributes([
        ['name', '"${var.name_prefix}-service"'],
        ['description', quote('Application tasks generated from the HADL bounded contexts')],
        ['vpc_id', 'var.vpc_id'],
        ['tags', 'var.tags'],
      ]),
    );
    for (const port of servicePorts) {
      writer.blank();
      writer.block(`resource "aws_vpc_security_group_ingress_rule" ${quote(`service_${port}`)}`, (body) =>
        body.attributes([
          ['security_group_id', 'aws_security_group.service.id'],
          ['description', quote(`Declared service port ${port}`)],
          ['cidr_ipv4', 'var.vpc_cidr'],
          ['from_port', String(port)],
          ['to_port', String(port)],
          ['ip_protocol', quote('tcp')],
          ['tags', 'var.tags'],
        ]),
      );
    }
    writer.blank();
    writer.block('resource "aws_vpc_security_group_egress_rule" "service"', (body) =>
      body.attributes([
        ['security_group_id', 'aws_security_group.service.id'],
        ['description', quote('Outbound traffic')],
        ['cidr_ipv4', quote('0.0.0.0/0')],
        ['ip_protocol', quote('-1')],
        ['tags', 'var.tags'],
      ]),
    );

    if (dataPorts.length > 0) {
      writer.blank();
      writer.block('resource "aws_security_group" "data"', (body) =>
        body.attributes([
          ['name', '"${var.name_prefix}-data"'],
          ['description', quote('Backing services declared in the HADL sources')],
          ['vpc_id', 'var.vpc_id'],
          ['tags', 'var.tags'],
        ]),
      );
      for (const port of dataPorts) {
        writer.blank();
        writer.block(`resource "aws_vpc_security_group_ingress_rule" ${quote(`data_${port}`)}`, (body) =>
          body.attributes([
            ['security_group_id', 'aws_security_group.data.id'],
            ['description', quote(`Access from the application tier on ${port}`)],
            ['referenced_security_group_id', 'aws_security_group.service.id'],
            ['from_port', String(port)],
            ['to_port', String(port)],
            ['ip_protocol', quote('tcp')],
            ['tags', 'var.tags'],
          ]),
        );
      }
    }

    for (const secret of data.secrets) {
      writer.blank();
      writer.comment(`declared as "secrets ${secret}"; the value is written outside HADL`);
      writer.block(`resource "aws_secretsmanager_secret" ${quote(secretKey(secret))}`, (body) =>
        body.attributes([
          ['name', `"\${var.name_prefix}/${secret}"`],
          ['description', quote(`${secret}, declared by an HADL infrastructure block`)],
          ['recovery_window_in_days', 'var.secret_recovery_window_days'],
          ['tags', 'var.tags'],
        ]),
      );
    }

    writer.blank();
    writer.block('data "aws_iam_policy_document" "task_assume"', (body) =>
      body.block('statement', (statement) => {
        statement.listAttribute('actions', [quote('sts:AssumeRole')]);
        statement.blank();
        statement.block('principals', (principals) =>
          principals.attributes([
            ['type', quote('Service')],
            ['identifiers', list([quote('ecs-tasks.amazonaws.com')])],
          ]),
        );
      }),
    );
    writer.blank();
    writer.block('resource "aws_iam_role" "execution"', (body) =>
      body.attributes([
        ['name', '"${var.name_prefix}-execution"'],
        ['assume_role_policy', 'data.aws_iam_policy_document.task_assume.json'],
        ['tags', 'var.tags'],
      ]),
    );
    writer.blank();
    writer.block('resource "aws_iam_role_policy_attachment" "execution"', (body) =>
      body.attributes([
        ['role', 'aws_iam_role.execution.name'],
        [
          'policy_arn',
          '"arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"',
        ],
      ]),
    );
    writer.blank();
    writer.block('resource "aws_iam_role" "task"', (body) =>
      body.attributes([
        ['name', '"${var.name_prefix}-task"'],
        ['assume_role_policy', 'data.aws_iam_policy_document.task_assume.json'],
        ['tags', 'var.tags'],
      ]),
    );

    const statements: PolicyStatement[] = [...data.policies];
    if (data.secrets.length > 0) {
      statements.unshift({
        sid: 'ReadDeclaredSecrets',
        actions: ['secretsmanager:GetSecretValue'],
        resources: data.secrets.map((secret) => `aws_secretsmanager_secret.${secretKey(secret)}.arn`),
      });
    }
    if (statements.length > 0) {
      writer.blank();
      writer.block('data "aws_iam_policy_document" "task"', (body) => {
        statements.forEach((statement, position) => {
          if (position > 0) body.blank();
          body.block('statement', (inner) => {
            inner.attribute('sid', quote(statement.sid));
            inner.listAttribute('actions', statement.actions.map(quote));
            inner.listAttribute('resources', statement.resources);
          });
        });
      });
      writer.blank();
      writer.block('resource "aws_iam_role_policy" "task"', (body) =>
        body.attributes([
          ['name', '"${var.name_prefix}-task"'],
          ['role', 'aws_iam_role.task.id'],
          ['policy', 'data.aws_iam_policy_document.task.json'],
        ]),
      );
    }
  });

  const outputs: HclOutput[] = [
    { name: 'service_security_group_id', value: 'aws_security_group.service.id', description: 'Security group of the tasks.' },
    {
      name: 'data_security_group_ids',
      value: dataPorts.length > 0 ? list(['aws_security_group.data.id']) : '[]',
      description: 'Security groups guarding the declared backing services.',
    },
    { name: 'execution_role_arn', value: 'aws_iam_role.execution.arn', description: 'Role ECS uses to start tasks.' },
    { name: 'task_role_arn', value: 'aws_iam_role.task.arn', description: 'Role the application itself runs as.' },
    {
      name: 'secret_arns',
      value: object(data.secrets.map((secret) => [quote(secret), `aws_secretsmanager_secret.${secretKey(secret)}.arn`])),
      description: 'Secrets Manager entry per declared secret name.',
    },
  ];

  return [
    file('terraform/modules/security/main.tf', main),
    file(
      'terraform/modules/security/variables.tf',
      variablesDocument([
        { name: 'name_prefix', type: 'string', description: 'Prefix applied to every resource name.' },
        { name: 'vpc_id', type: 'string', description: 'VPC the security groups belong to.' },
        { name: 'vpc_cidr', type: 'string', description: 'CIDR allowed to reach the declared service ports.' },
        {
          name: 'secret_recovery_window_days',
          type: 'number',
          description: 'Days a deleted secret can still be restored.',
          default: '7',
        },
        { name: 'tags', type: 'map(string)', description: 'Tags applied to every resource.', default: '{}' },
      ]),
    ),
    file('terraform/modules/security/outputs.tf', outputsDocument(outputs)),
  ];
}

// ---------------------------------------------------------------------------
// modules/data
// ---------------------------------------------------------------------------

function dataModule(data: DataPlan): GeneratedFile[] {
  const main = hclDocument((writer) => {
    data.resources.forEach((resource, position) => {
      if (position > 0) writer.blank();
      writer.comment(`declared as "${resource.declaredName}"`);
      resource.write(writer);
    });
  });

  const variables: HclVariable[] = [
    { name: 'name_prefix', type: 'string', description: 'Prefix applied to every resource name.' },
    { name: 'subnet_ids', type: 'list(string)', description: 'Private subnets the resources live in.' },
    { name: 'security_group_ids', type: 'list(string)', description: 'Security groups guarding the resources.' },
    { name: 'tags', type: 'map(string)', description: 'Tags applied to every resource.', default: '{}' },
    ...data.resources.flatMap((resource) => resource.variables),
  ];

  return [
    file('terraform/modules/data/main.tf', main),
    file('terraform/modules/data/variables.tf', variablesDocument(dedupeVariables(variables))),
    file('terraform/modules/data/outputs.tf', outputsDocument(data.resources.flatMap((resource) => resource.outputs))),
  ];
}

/** Two databases share `backup_retention_days`; Terraform allows only one declaration. */
function dedupeVariables(variables: readonly HclVariable[]): HclVariable[] {
  const seen = new Map<string, HclVariable>();
  for (const variable of variables) if (!seen.has(variable.name)) seen.set(variable.name, variable);
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// modules/compute
// ---------------------------------------------------------------------------

function computeModule(contexts: readonly ContextPlan[]): GeneratedFile[] {
  const main = hclDocument((writer) => {
    writer.block('resource "aws_ecs_cluster" "main"', (body) => {
      body.attributes([
        ['name', 'var.name_prefix'],
        ['tags', 'var.tags'],
      ]);
      body.blank();
      body.block('setting', (setting) =>
        setting.attributes([
          ['name', quote('containerInsights')],
          ['value', 'var.container_insights ? "enabled" : "disabled"'],
        ]),
      );
    });

    for (const plan of contexts) {
      const id = tfName(plan.serviceName);
      writer.blank();
      writer.comment(`bounded context "${plan.context.name}" (${plan.language}), port ${plan.port}`);
      writer.block(`resource "aws_cloudwatch_log_group" ${quote(id)}`, (body) =>
        body.attributes([
          ['name', `"/ecs/\${var.name_prefix}/${plan.serviceName}"`],
          ['retention_in_days', 'var.log_retention_days'],
          ['tags', 'var.tags'],
        ]),
      );
      writer.blank();
      writer.block(`resource "aws_ecs_task_definition" ${quote(id)}`, (body) => {
        body.attributes([
          ['family', `"\${var.name_prefix}-${plan.serviceName}"`],
          ['requires_compatibilities', list([quote('FARGATE')])],
          ['network_mode', quote('awsvpc')],
          ['cpu', `var.${id}_cpu`],
          ['memory', `var.${id}_memory`],
          ['execution_role_arn', 'var.execution_role_arn'],
          ['task_role_arn', 'var.task_role_arn'],
          ['tags', 'var.tags'],
        ]);
        body.blank();
        containerDefinition(body, plan, id);
      });
      writer.blank();
      writer.block(`resource "aws_ecs_service" ${quote(id)}`, (body) => {
        body.attributes([
          ['name', `"\${var.name_prefix}-${plan.serviceName}"`],
          ['cluster', 'aws_ecs_cluster.main.id'],
          ['task_definition', `aws_ecs_task_definition.${id}.arn`],
          ['desired_count', String(plan.scaling.min)],
          ['launch_type', quote('FARGATE')],
          ['tags', 'var.tags'],
        ]);
        body.blank();
        body.block('network_configuration', (network) =>
          network.attributes([
            ['subnets', 'var.subnet_ids'],
            ['security_groups', 'var.security_group_ids'],
            ['assign_public_ip', 'false'],
          ]),
        );
        body.blank();
        body.block('lifecycle', (lifecycle) => lifecycle.listAttribute('ignore_changes', ['desired_count']));
      });

      if (plan.scaling.max > plan.scaling.min) {
        writer.blank();
        writer.comment(
          `declared as "scaling min ${plan.scaling.min} max ${plan.scaling.max} cpu ${plan.scaling.targetCpuPercent}"`,
        );
        writer.block(`resource "aws_appautoscaling_target" ${quote(id)}`, (body) =>
          body.attributes([
            ['service_namespace', quote('ecs')],
            ['resource_id', `"service/\${aws_ecs_cluster.main.name}/\${aws_ecs_service.${id}.name}"`],
            ['scalable_dimension', quote('ecs:service:DesiredCount')],
            ['min_capacity', String(plan.scaling.min)],
            ['max_capacity', String(plan.scaling.max)],
          ]),
        );
        writer.blank();
        writer.block(`resource "aws_appautoscaling_policy" ${quote(`${id}_cpu`)}`, (body) => {
          body.attributes([
            ['name', `"\${var.name_prefix}-${plan.serviceName}-cpu"`],
            ['policy_type', quote('TargetTrackingScaling')],
            ['resource_id', `aws_appautoscaling_target.${id}.resource_id`],
            ['scalable_dimension', `aws_appautoscaling_target.${id}.scalable_dimension`],
            ['service_namespace', `aws_appautoscaling_target.${id}.service_namespace`],
          ]);
          body.blank();
          body.block('target_tracking_scaling_policy_configuration', (tracking) => {
            tracking.attribute('target_value', String(plan.scaling.targetCpuPercent));
            tracking.blank();
            tracking.block('predefined_metric_specification', (metric) =>
              metric.attribute('predefined_metric_type', quote('ECSServiceAverageCPUUtilization')),
            );
          });
        });
      }
    }
  });

  const variables: HclVariable[] = [
    { name: 'name_prefix', type: 'string', description: 'Prefix applied to every resource name.' },
    { name: 'region', type: 'string', description: 'Region the log groups live in.' },
    { name: 'subnet_ids', type: 'list(string)', description: 'Subnets the tasks run in.' },
    { name: 'security_group_ids', type: 'list(string)', description: 'Security groups attached to the tasks.' },
    { name: 'execution_role_arn', type: 'string', description: 'Role ECS uses to start tasks.' },
    { name: 'task_role_arn', type: 'string', description: 'Role the application itself runs as.' },
    { name: 'secret_arns', type: 'map(string)', description: 'Secrets Manager ARN per declared secret name.', default: '{}' },
    { name: 'log_retention_days', type: 'number', description: 'Retention of the task log groups.', default: '30' },
    { name: 'container_insights', type: 'bool', description: 'Enable ECS Container Insights.', default: 'true' },
    ...contexts.flatMap((plan) => {
      const id = tfName(plan.serviceName);
      return [
        {
          name: `${id}_image`,
          type: 'string',
          description: `Image for the ${plan.context.name} service.`,
          default: quote(`${plan.imageName}:latest`),
        },
        { name: `${id}_cpu`, type: 'number', description: `Fargate CPU units for ${plan.context.name}.`, default: '512' },
        { name: `${id}_memory`, type: 'number', description: `Fargate memory (MiB) for ${plan.context.name}.`, default: '1024' },
      ];
    }),
  ];

  const outputs: HclOutput[] = [
    { name: 'cluster_name', value: 'aws_ecs_cluster.main.name', description: 'ECS cluster running the services.' },
    {
      name: 'service_names',
      value: list(contexts.map((plan) => `aws_ecs_service.${tfName(plan.serviceName)}.name`)),
      description: 'One ECS service per bounded context.',
    },
  ];

  return [
    file('terraform/modules/compute/main.tf', main),
    file('terraform/modules/compute/variables.tf', variablesDocument(variables)),
    file('terraform/modules/compute/outputs.tf', outputsDocument(outputs)),
  ];
}

function containerDefinition(writer: HclWriter, plan: ContextPlan, id: string): void {
  writer.line('container_definitions = jsonencode([');
  writer.indented((body) => {
    body.line('{');
    body.indented((container) => {
      container.attributes([
        ['name', quote(plan.serviceName)],
        ['image', `var.${id}_image`],
        ['essential', 'true'],
      ]);
      container.line(`portMappings = [{ containerPort = ${plan.port}, protocol = "tcp" }]`);
      container.line('environment = [');
      container.indented((environment) => {
        const entries = Object.entries(baseEnvironment(plan));
        entries.forEach(([name, value], position) => {
          environment.line(`{ name = ${quote(name)}, value = ${quote(value)} }${position === entries.length - 1 ? '' : ','}`);
        });
      });
      container.line(']');
      if (plan.secrets.length > 0) {
        container.line('secrets = [');
        container.indented((secrets) => {
          plan.secrets.forEach((secret, position) => {
            const comma = position === plan.secrets.length - 1 ? '' : ',';
            secrets.line(`{ name = ${quote(secret)}, valueFrom = var.secret_arns[${quote(secret)}] }${comma}`);
          });
        });
        container.line(']');
      }
      container.line('logConfiguration = {');
      container.indented((logging) => {
        logging.attribute('logDriver', quote('awslogs'));
        logging.line('options = {');
        // Keys with dashes are expressions in HCL unless they are quoted.
        logging.indented((options) =>
          options.attributes([
            [quote('awslogs-group'), `aws_cloudwatch_log_group.${id}.name`],
            [quote('awslogs-region'), 'var.region'],
            [quote('awslogs-stream-prefix'), quote(plan.serviceName)],
          ]),
        );
        logging.line('}');
      });
      container.line('}');
    });
    body.line('}');
  });
  writer.line('])');
}

function secretKey(secret: string): string {
  return screamingSnakeCase(secret).toLowerCase();
}
