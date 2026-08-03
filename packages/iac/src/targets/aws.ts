/**
 * AWS Lambda target: an AWS SAM application.
 *
 * One function per declared endpoint, one per declared handler. CloudFormation
 * intrinsics are written in their long form (`Fn::GetAtt`) because the short
 * `!GetAtt` tags cannot survive a YAML serialiser.
 */
import {
  CodeWriter,
  GENERATED_BANNER,
  file,
  kebabCase,
  pascalCase,
  type CodegenTarget,
  type Diagnostic,
  type GeneratedFile,
  type IRHandlerDecl,
  type InfrastructureGenerator,
} from '@haic/core';
import { IAC_CODE, iacWarning, noContextRequests, unsupportedEngine } from '../shared/diagnostics.js';
import {
  baseEnvironment,
  buildPlan,
  unique,
  type ContextPlan,
  type HandlerPlan,
  type InfrastructurePlan,
} from '../shared/plan.js';
import { yamlDocument } from '../shared/yaml.js';

const PLATFORM = 'AWS Lambda';

type Template = Record<string, unknown>;
type Resource = Record<string, unknown>;

const LAMBDA_RUNTIMES: Record<CodegenTarget, string> = {
  typescript: 'nodejs22.x',
  python: 'python3.12',
  java: 'java21',
  go: 'provided.al2023',
  rust: 'provided.al2023',
};

/** Where each runtime looks for the entry point of a generated function. */
const LAMBDA_HANDLERS: Record<CodegenTarget, (name: string) => string> = {
  typescript: (name) => `dist/lambda/${kebabCase(name)}.handler`,
  python: (name) => `app.lambda.${kebabCase(name).replace(/-/g, '_')}.handler`,
  java: () => 'com.ailang.Handler::handleRequest',
  go: () => 'bootstrap',
  rust: () => 'bootstrap',
};

export const awsGenerator: InfrastructureGenerator = {
  id: 'aws-lambda',
  displayName: 'AWS Lambda + API Gateway',
  verifyCommand: ['sam', 'validate'],

  generate(context) {
    const plan = buildPlan(context.project);
    const contexts = plan.targeting('aws-lambda');
    if (contexts.length === 0) return { files: [], diagnostics: [noContextRequests(PLATFORM, 'aws-lambda')] };

    const diagnostics: Diagnostic[] = [];
    const template = samTemplate(plan, contexts, diagnostics);
    return {
      files: [
        file('template.yaml', yamlDocument(template, ['Deploy with `sam build && sam deploy --guided`.'])),
        file('samconfig.toml', samConfig(plan, contexts)),
        file('README.md', readme(plan, contexts)),
      ],
      diagnostics,
    };
  },
};

// ---------------------------------------------------------------------------
// template.yaml
// ---------------------------------------------------------------------------

function samTemplate(plan: InfrastructurePlan, contexts: readonly ContextPlan[], diagnostics: Diagnostic[]): Template {
  const resources: Record<string, Resource> = {};
  const outputs: Record<string, Resource> = {};

  for (const deployable of contexts) {
    const prefix = pascalCase(deployable.serviceName);
    const secrets = secretResources(deployable, prefix);
    Object.assign(resources, secrets.resources);

    if (deployable.endpoints.length > 0) {
      resources[`${prefix}Api`] = restApi(deployable);
      outputs[`${prefix}ApiUrl`] = {
        Description: `Base URL of the ${deployable.context.name} API.`,
        Value: {
          'Fn::Sub': `https://\${${prefix}Api}.execute-api.\${AWS::Region}.amazonaws.com/\${StageName}`,
        },
      };
    }
    for (const declared of deployable.endpoints) {
      const { endpoint } = declared;
      if (endpoint.auth !== 'none') {
        diagnostics.push(
          iacWarning(
            IAC_CODE.unsupportedAuth,
            `endpoint ${endpoint.method} ${endpoint.path} declares "${endpoint.auth}" auth, which SAM cannot derive an authorizer from`,
            deployable.span,
            'add an Auth block to the generated API, or move the check into the service',
          ),
        );
      }
      const properties = baseFunction(deployable, prefix, secrets.names);
      properties['Description'] = endpoint.description ?? `${endpoint.method} ${endpoint.path}`;
      properties['Events'] = {
        Api: {
          Type: 'Api',
          Properties: { RestApiId: { Ref: `${prefix}Api` }, Path: endpoint.path, Method: endpoint.method.toLowerCase() },
        },
      };
      resources[`${prefix}${pascalCase(endpoint.name)}Function`] = {
        Type: 'AWS::Serverless::Function',
        Properties: properties,
      };
    }

    for (const declared of deployable.handlers) {
      const { handler } = declared;
      const subscription = eventSource(deployable, declared, prefix, diagnostics);
      if (!subscription) continue;
      Object.assign(resources, subscription.resources);

      const properties = baseFunction(deployable, prefix, secrets.names);
      properties['Description'] = handler.description ?? `Reacts to ${handler.on} (${handler.delivery}).`;
      properties['Events'] = subscription.events;
      const policies = [...((properties['Policies'] as unknown[]) ?? []), ...subscription.policies];
      if (policies.length > 0) properties['Policies'] = policies;
      resources[`${prefix}${pascalCase(handler.name)}Function`] = {
        Type: 'AWS::Serverless::Function',
        Properties: properties,
      };
    }
  }

  const template: Template = {
    AWSTemplateFormatVersion: '2010-09-09',
    Transform: 'AWS::Serverless-2016-10-31',
    Description: `${plan.project.name}: generated from the HADL infrastructure blocks.`,
    Parameters: {
      StageName: { Type: 'String', Default: 'dev', Description: 'API Gateway stage the endpoints are published under.' },
    },
    Globals: { Function: globals(contexts) },
    Resources: resources,
  };
  if (Object.keys(outputs).length > 0) template['Outputs'] = outputs;
  return template;
}

function globals(contexts: readonly ContextPlan[]): Resource {
  const tracing = contexts.some((plan) => plan.observability.tracing);
  const globalFunction: Resource = { Timeout: 30, MemorySize: 512, Architectures: ['arm64'] };
  if (tracing) globalFunction['Tracing'] = 'Active';
  return globalFunction;
}

function restApi(plan: ContextPlan): Resource {
  return {
    Type: 'AWS::Serverless::Api',
    Properties: {
      StageName: { Ref: 'StageName' },
      Description: `HTTP surface of the ${plan.context.name} bounded context.`,
      TracingEnabled: plan.observability.tracing,
      MethodSettings: [{ ResourcePath: '/*', HttpMethod: '*', MetricsEnabled: plan.observability.metrics }],
    },
  };
}

function baseFunction(plan: ContextPlan, prefix: string, secrets: readonly string[]): Resource {
  const variables: Record<string, unknown> = { ...baseEnvironment(plan) };
  for (const secret of secrets) variables[`${secret}_SECRET_ARN`] = { Ref: `${prefix}${pascalCase(secret)}Secret` };

  const properties: Resource = {
    CodeUri: `${plan.serviceName}/`,
    Runtime: LAMBDA_RUNTIMES[plan.language],
    Handler: LAMBDA_HANDLERS[plan.language](plan.serviceName),
    Environment: { Variables: variables },
  };
  const policies = resourcePolicies(plan, prefix, secrets);
  if (policies.length > 0) properties['Policies'] = policies;
  return properties;
}

/** IAM policies scoped to the resources the IR declares, and to nothing else. */
function resourcePolicies(plan: ContextPlan, prefix: string, secrets: readonly string[]): unknown[] {
  const policies: unknown[] = [];
  for (const secret of secrets) {
    policies.push({ AWSSecretsManagerGetSecretValuePolicy: { SecretArn: { Ref: `${prefix}${pascalCase(secret)}Secret` } } });
  }
  for (const database of plan.databases) {
    if (database.spec.engine === 'dynamodb') policies.push({ DynamoDBCrudPolicy: { TableName: database.spec.name } });
  }
  for (const store of plan.objectStores) {
    if (store.spec.engine === 's3') policies.push({ S3CrudPolicy: { BucketName: store.spec.name } });
  }
  return policies;
}

function secretResources(plan: ContextPlan, prefix: string): { resources: Record<string, Resource>; names: string[] } {
  const resources: Record<string, Resource> = {};
  for (const secret of plan.secrets) {
    resources[`${prefix}${pascalCase(secret)}Secret`] = {
      Type: 'AWS::SecretsManager::Secret',
      Properties: {
        Name: { 'Fn::Sub': `\${AWS::StackName}/${secret}` },
        Description: `${secret}, declared by an HADL infrastructure block.`,
        // The value is generated in-account, so no placeholder is ever committed.
        GenerateSecretString: { PasswordLength: 32, ExcludePunctuation: true },
      },
    };
  }
  return { resources, names: [...plan.secrets] };
}

// ---------------------------------------------------------------------------
// Event sources
// ---------------------------------------------------------------------------

interface Subscription {
  readonly resources: Record<string, Resource>;
  readonly events: Resource;
  readonly policies: unknown[];
}

function eventSource(
  plan: ContextPlan,
  declared: HandlerPlan,
  prefix: string,
  diagnostics: Diagnostic[],
): Subscription | null {
  const { handler } = declared;
  const name = `${prefix}${pascalCase(handler.name)}`;

  if (handler.trigger === 'schedule') {
    if (!handler.schedule) {
      diagnostics.push(
        iacWarning(
          IAC_CODE.noEventSource,
          `handler ${handler.name} is scheduled but declares no cron expression`,
          plan.span,
          'add a "schedule" line to the handler',
        ),
      );
      return null;
    }
    const expression = /^(cron|rate)\(/.test(handler.schedule) ? handler.schedule : `cron(${handler.schedule})`;
    return { resources: {}, events: { Timer: { Type: 'Schedule', Properties: { Schedule: expression } } }, policies: [] };
  }

  const broker = plan.brokers[0];
  if (!broker) {
    diagnostics.push(
      iacWarning(
        IAC_CODE.noEventSource,
        `handler ${handler.name} reacts to ${handler.on} but the context declares no broker to subscribe to`,
        plan.span,
        'declare "broker <name> using sqs" or "using eventbridge" in the infrastructure block',
      ),
    );
    return null;
  }

  const topic = declared.event?.topic ?? kebabCase(handler.on);
  if (broker.spec.engine === 'sqs') return sqsSubscription(name, topic, handler);
  if (broker.spec.engine === 'eventbridge') return eventBridgeSubscription(handler, broker.spec.name);

  diagnostics.push(
    unsupportedEngine(
      IAC_CODE.unsupportedBroker,
      PLATFORM,
      'broker',
      broker.spec.name,
      broker.spec.engine,
      broker.span,
    ),
  );
  return null;
}

function sqsSubscription(name: string, topic: string, handler: IRHandlerDecl): Subscription {
  // `delivery exactly-once` is what a FIFO queue is for; anything else is standard.
  const fifo = handler.delivery === 'exactly-once';
  const suffix = fifo ? '.fifo' : '';
  const queue: Resource = {
    Type: 'AWS::SQS::Queue',
    Properties: {
      QueueName: { 'Fn::Sub': `\${AWS::StackName}-${kebabCase(topic)}${suffix}` },
      // `retries` becomes the redrive threshold: the broker owns retry counting.
      RedrivePolicy: {
        deadLetterTargetArn: { 'Fn::GetAtt': [`${name}DeadLetterQueue`, 'Arn'] },
        maxReceiveCount: Math.max(1, handler.retries),
      },
    },
  };
  const deadLetter: Resource = {
    Type: 'AWS::SQS::Queue',
    Properties: { QueueName: { 'Fn::Sub': `\${AWS::StackName}-${kebabCase(topic)}-dlq${suffix}` } },
  };
  if (fifo) {
    (queue['Properties'] as Resource)['FifoQueue'] = true;
    (queue['Properties'] as Resource)['ContentBasedDeduplication'] = true;
    (deadLetter['Properties'] as Resource)['FifoQueue'] = true;
  }

  return {
    resources: { [`${name}Queue`]: queue, [`${name}DeadLetterQueue`]: deadLetter },
    events: {
      Queue: {
        Type: 'SQS',
        Properties: { Queue: { 'Fn::GetAtt': [`${name}Queue`, 'Arn'] }, BatchSize: 10 },
      },
    },
    policies: [{ SQSPollerPolicy: { QueueName: { 'Fn::GetAtt': [`${name}Queue`, 'QueueName'] } } }],
  };
}

function eventBridgeSubscription(handler: IRHandlerDecl, busName: string): Subscription {
  const bus = `${pascalCase(busName)}EventBus`;
  return {
    resources: {
      [bus]: {
        Type: 'AWS::Events::EventBus',
        Properties: { Name: { 'Fn::Sub': `\${AWS::StackName}-${kebabCase(busName)}` } },
      },
    },
    events: {
      Rule: {
        Type: 'EventBridgeRule',
        Properties: {
          EventBusName: { Ref: bus },
          Pattern: { 'detail-type': [handler.on] },
        },
      },
    },
    policies: [{ EventBridgePutEventsPolicy: { EventBusName: { Ref: bus } } }],
  };
}

// ---------------------------------------------------------------------------
// samconfig.toml and README
// ---------------------------------------------------------------------------

function samConfig(plan: InfrastructurePlan, contexts: readonly ContextPlan[]): string {
  const region = contexts.map((context) => context.environment['REGION'] ?? context.environment['AWS_REGION']).find(Boolean);
  const writer = new CodeWriter();
  writer.line(`# ${GENERATED_BANNER}`);
  writer.line('version = 0.1');
  writer.blank();
  writer.line('[default.global.parameters]');
  writer.line(`stack_name = "${plan.name}"`);
  if (region) writer.line(`region = "${region}"`);
  writer.blank();
  writer.line('[default.build.parameters]');
  writer.line('cached = true');
  writer.line('parallel = true');
  writer.blank();
  writer.line('[default.deploy.parameters]');
  writer.line('capabilities = "CAPABILITY_IAM"');
  writer.line('confirm_changeset = true');
  writer.line('resolve_s3 = true');
  writer.blank();
  writer.line('[default.sync.parameters]');
  writer.line('watch = true');
  return writer.toString();
}

function readme(plan: InfrastructurePlan, contexts: readonly ContextPlan[]): string {
  const runtimes = unique(contexts.map((context) => LAMBDA_RUNTIMES[context.language]));
  const lines = [
    `# ${plan.project.name} on AWS Lambda`,
    '',
    `${GENERATED_BANNER}`,
    '',
    '## What is in the template',
    '',
    '| Resource | Comes from |',
    '| --- | --- |',
    '| `AWS::Serverless::Api` | every bounded context that declares an endpoint |',
    '| `AWS::Serverless::Function` | one per `## endpoint` and one per `## handler` |',
    '| `AWS::SQS::Queue` | handlers backed by a `broker ... using sqs` |',
    '| `AWS::Events::EventBus` | handlers backed by a `broker ... using eventbridge` |',
    '| `AWS::SecretsManager::Secret` | every name in `secrets ...` |',
    '',
    '## Bounded contexts',
    '',
    ...contexts.map(
      (context) =>
        `- **${context.context.name}** (${context.language} on ${LAMBDA_RUNTIMES[context.language]}): ` +
        `${context.endpoints.length} endpoint(s), ${context.handlers.length} handler(s), code in \`${context.serviceName}/\``,
    ),
    '',
    '## Deploy',
    '',
    '```bash',
    `# build one artefact per function (${runtimes.join(', ')})`,
    'sam validate',
    'sam build',
    'sam deploy --guided   # writes the answers back into samconfig.toml',
    '```',
    '',
    'Secret values are generated in-account by CloudFormation and never leave it.',
    'Overwrite them with `aws secretsmanager put-secret-value` if you already have one.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}
