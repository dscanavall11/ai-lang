/**
 * Kubernetes target: one Helm chart per bounded context.
 *
 * `values.yaml` and `Chart.yaml` are plain data, so they go through `toYaml`.
 * The templates carry `{{ }}` directives that no YAML serialiser can round-trip,
 * so those are written line by line instead.
 */
import {
  CodeWriter,
  GENERATED_BANNER,
  file,
  type Diagnostic,
  type GeneratedFile,
  type InfrastructureGenerator,
} from '@haic/core';
import { IAC_CODE, iacWarning, noContextRequests } from '../shared/diagnostics.js';
import {
  baseEnvironment,
  buildPlan,
  connectionVariable,
  unique,
  type ContextPlan,
  type Declared,
  type InfrastructurePlan,
} from '../shared/plan.js';
import { yamlDocument } from '../shared/yaml.js';

const CHART_VERSION = '0.1.0';
const HEALTH_PATH = '/health';

export const kubernetesGenerator: InfrastructureGenerator = {
  id: 'kubernetes',
  displayName: 'Kubernetes (Helm)',
  verifyCommand: ['helm', 'lint', 'charts'],

  generate(context) {
    const plan = buildPlan(context.project);
    const contexts = plan.targeting('kubernetes');
    if (contexts.length === 0) return { files: [], diagnostics: [noContextRequests('Kubernetes', 'kubernetes')] };

    const files: GeneratedFile[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const deployable of contexts) {
      files.push(...chart(plan, deployable));
      diagnostics.push(...unprovisioned(deployable));
    }
    return { files, diagnostics };
  },
};

/**
 * A chart deploys the application, not its stateful dependencies: turning a
 * declared database into a StatefulSet would be a guess about how it is run.
 */
function unprovisioned(plan: ContextPlan): Diagnostic[] {
  const report = <T extends { name: string; engine: string }>(declared: Declared<T>, kind: string, code: string) =>
    iacWarning(
      code,
      `the "${plan.serviceName}" chart does not provision the ${kind} "${declared.spec.name}" (${declared.spec.engine})`,
      declared.span,
      `point ${connectionVariable(declared.spec.name)} at a managed instance, or install a chart for it`,
    );

  return [
    ...plan.databases.map((entry) => report(entry, 'database', IAC_CODE.unsupportedDatabase)),
    ...plan.brokers.map((entry) => report(entry, 'broker', IAC_CODE.unsupportedBroker)),
    ...plan.caches
      .filter((entry) => entry.spec.engine !== 'in-memory')
      .map((entry) => report(entry, 'cache', IAC_CODE.unsupportedCache)),
    ...plan.objectStores.map((entry) => report(entry, 'object store', IAC_CODE.unsupportedObjectStore)),
  ];
}

function chart(plan: InfrastructurePlan, deployable: ContextPlan): GeneratedFile[] {
  const root = `charts/${deployable.serviceName}`;
  const files = [
    file(`${root}/Chart.yaml`, chartMetadata(deployable)),
    file(`${root}/values.yaml`, values(plan, deployable)),
    file(`${root}/templates/_helpers.tpl`, helpers(deployable)),
    file(`${root}/templates/deployment.yaml`, deployment(deployable)),
    file(`${root}/templates/service.yaml`, service(deployable)),
    file(`${root}/templates/configmap.yaml`, configMap(deployable)),
  ];
  if (deployable.secrets.length > 0) files.push(file(`${root}/templates/secret.yaml`, secret(deployable)));
  // No declared endpoint means no HTTP surface worth routing to.
  if (deployable.endpoints.length > 0) files.push(file(`${root}/templates/ingress.yaml`, ingress(deployable)));
  if (deployable.scaling.max > deployable.scaling.min) {
    files.push(file(`${root}/templates/hpa.yaml`, horizontalPodAutoscaler(deployable)));
  }
  return files;
}

// ---------------------------------------------------------------------------
// Chart data
// ---------------------------------------------------------------------------

function chartMetadata(plan: ContextPlan): string {
  return yamlDocument({
    apiVersion: 'v2',
    name: plan.serviceName,
    description: plan.context.description ?? `${plan.context.name} bounded context (${plan.context.kind}).`,
    type: 'application',
    version: CHART_VERSION,
    appVersion: CHART_VERSION,
    keywords: [plan.context.kind, plan.language],
  });
}

function values(plan: InfrastructurePlan, deployable: ContextPlan): string {
  const autoscaling = deployable.scaling.max > deployable.scaling.min;
  const document: Record<string, unknown> = {
    nameOverride: '',
    fullnameOverride: '',
    replicaCount: deployable.scaling.min,
    image: { repository: deployable.imageName, tag: 'latest', pullPolicy: 'IfNotPresent' },
    containerPort: deployable.port,
    service: { type: 'ClusterIP', port: deployable.port },
    // The HPA tracks CPU utilisation, which only means anything against a request.
    resources: {
      requests: { cpu: '250m', memory: '256Mi' },
      limits: { cpu: '1', memory: '512Mi' },
    },
    probes: { readinessPath: HEALTH_PATH, livenessPath: HEALTH_PATH },
    env: baseEnvironment(deployable),
  };

  if (deployable.endpoints.length > 0) {
    document['ingress'] = {
      enabled: true,
      className: '',
      host: `${deployable.serviceName}.${plan.name}.local`,
      paths: pathPrefixes(deployable).map((path) => ({ path, pathType: 'Prefix' })),
    };
  }
  if (autoscaling) {
    document['autoscaling'] = {
      enabled: true,
      minReplicas: deployable.scaling.min,
      maxReplicas: deployable.scaling.max,
      targetCPUUtilizationPercentage: deployable.scaling.targetCpuPercent,
    };
  }
  return yamlDocument(document, ['Values come from the `## infrastructure` block of the HADL sources.']);
}

/** `/orders/{orderId}/place` and `/orders` share the `/orders` ingress prefix. */
function pathPrefixes(plan: ContextPlan): string[] {
  const prefixes = plan.endpoints.map(({ endpoint }) => {
    const first = endpoint.path.split('/').filter(Boolean)[0];
    return first === undefined || first.startsWith('{') ? '/' : `/${first}`;
  });
  return unique(prefixes);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function template(): CodeWriter {
  const writer = new CodeWriter();
  writer.line(`# ${GENERATED_BANNER}`);
  return writer;
}

function helpers(plan: ContextPlan): string {
  const name = plan.serviceName;
  const writer = new CodeWriter();
  writer.line(`{{/* ${GENERATED_BANNER} */}}`);
  writer.blank();
  writer.line(`{{- define "${name}.name" -}}`);
  writer.line('{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}');
  writer.line('{{- end -}}');
  writer.blank();
  writer.line(`{{- define "${name}.fullname" -}}`);
  writer.line('{{- if .Values.fullnameOverride -}}');
  writer.line('{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}');
  writer.line('{{- else -}}');
  writer.line(`{{- printf "%s-%s" .Release.Name (include "${name}.name" .) | trunc 63 | trimSuffix "-" -}}`);
  writer.line('{{- end -}}');
  writer.line('{{- end -}}');
  writer.blank();
  writer.line(`{{- define "${name}.labels" -}}`);
  writer.line('helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}');
  writer.line(`{{ include "${name}.selectorLabels" . }}`);
  writer.line('app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}');
  writer.line('app.kubernetes.io/managed-by: {{ .Release.Service }}');
  writer.line('app.kubernetes.io/part-of: {{ .Chart.Name }}');
  writer.line('{{- end -}}');
  writer.blank();
  writer.line(`{{- define "${name}.selectorLabels" -}}`);
  writer.line(`app.kubernetes.io/name: {{ include "${name}.name" . }}`);
  writer.line('app.kubernetes.io/instance: {{ .Release.Name }}');
  writer.line('{{- end -}}');
  return writer.toString();
}

function deployment(plan: ContextPlan): string {
  const name = plan.serviceName;
  const autoscaling = plan.scaling.max > plan.scaling.min;
  const writer = template();
  writer.line('apiVersion: apps/v1');
  writer.line('kind: Deployment');
  writer.line('metadata:');
  writer.block(() => {
    writer.line(`name: {{ include "${name}.fullname" . }}`);
    writer.line('labels:');
    writer.block(() => writer.line(`{{- include "${name}.labels" . | nindent 4 }}`));
  });
  writer.line('spec:');
  writer.block(() => {
    if (autoscaling) {
      writer.line('{{- if not .Values.autoscaling.enabled }}');
      writer.line('replicas: {{ .Values.replicaCount }}');
      writer.line('{{- end }}');
    } else {
      writer.line('replicas: {{ .Values.replicaCount }}');
    }
    writer.line('selector:');
    writer.block(() => {
      writer.line('matchLabels:');
      writer.block(() => writer.line(`{{- include "${name}.selectorLabels" . | nindent 6 }}`));
    });
    writer.line('template:');
    writer.block(() => {
      writer.line('metadata:');
      writer.block(() => {
        writer.line('labels:');
        writer.block(() => writer.line(`{{- include "${name}.selectorLabels" . | nindent 8 }}`));
      });
      writer.line('spec:');
      writer.block(() => {
        writer.line('securityContext:');
        writer.block(() => writer.line('runAsNonRoot: true'));
        writer.line('containers:');
        writer.block(() => container(writer, plan));
      });
    });
  });
  return writer.toString();
}

function container(writer: CodeWriter, plan: ContextPlan): void {
  const name = plan.serviceName;
  writer.line('- name: {{ .Chart.Name }}');
  writer.block(() => {
    writer.line('image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"');
    writer.line('imagePullPolicy: {{ .Values.image.pullPolicy }}');
    writer.line('ports:');
    writer.block(() => {
      writer.line('- name: http');
      writer.block(() => {
        writer.line('containerPort: {{ .Values.containerPort }}');
        writer.line('protocol: TCP');
      });
    });
    writer.line('envFrom:');
    writer.block(() => {
      writer.line('- configMapRef:');
      writer.block(() => writer.block(() => writer.line(`name: {{ include "${name}.fullname" . }}-config`)));
      if (plan.secrets.length > 0) {
        writer.line('- secretRef:');
        writer.block(() => writer.block(() => writer.line(`name: {{ include "${name}.fullname" . }}-secrets`)));
      }
    });
    probe(writer, 'readinessProbe', '.Values.probes.readinessPath', 5, 10);
    probe(writer, 'livenessProbe', '.Values.probes.livenessPath', 15, 20);
    writer.line('resources:');
    writer.block(() => writer.line('{{- toYaml .Values.resources | nindent 12 }}'));
  });
}

function probe(writer: CodeWriter, kind: string, path: string, initialDelay: number, period: number): void {
  writer.line(`${kind}:`);
  writer.block(() => {
    writer.line('httpGet:');
    writer.block(() => {
      writer.line(`path: {{ ${path} }}`);
      writer.line('port: http');
    });
    writer.line(`initialDelaySeconds: ${initialDelay}`);
    writer.line(`periodSeconds: ${period}`);
  });
}

function service(plan: ContextPlan): string {
  const name = plan.serviceName;
  const writer = template();
  writer.line('apiVersion: v1');
  writer.line('kind: Service');
  writer.line('metadata:');
  writer.block(() => {
    writer.line(`name: {{ include "${name}.fullname" . }}`);
    writer.line('labels:');
    writer.block(() => writer.line(`{{- include "${name}.labels" . | nindent 4 }}`));
  });
  writer.line('spec:');
  writer.block(() => {
    writer.line('type: {{ .Values.service.type }}');
    writer.line('ports:');
    writer.block(() => {
      writer.line('- port: {{ .Values.service.port }}');
      writer.block(() => {
        writer.line('targetPort: http');
        writer.line('protocol: TCP');
        writer.line('name: http');
      });
    });
    writer.line('selector:');
    writer.block(() => writer.line(`{{- include "${name}.selectorLabels" . | nindent 4 }}`));
  });
  return writer.toString();
}

function configMap(plan: ContextPlan): string {
  const name = plan.serviceName;
  const writer = template();
  writer.line('apiVersion: v1');
  writer.line('kind: ConfigMap');
  writer.line('metadata:');
  writer.block(() => {
    writer.line(`name: {{ include "${name}.fullname" . }}-config`);
    writer.line('labels:');
    writer.block(() => writer.line(`{{- include "${name}.labels" . | nindent 4 }}`));
  });
  writer.line('data:');
  writer.block(() => {
    writer.line('{{- range $key, $value := .Values.env }}');
    writer.line('{{ $key }}: {{ $value | quote }}');
    writer.line('{{- end }}');
  });
  return writer.toString();
}

function secret(plan: ContextPlan): string {
  const name = plan.serviceName;
  const writer = template();
  writer.line('# Keys only. Values are injected at deploy time and must never be committed.');
  writer.line('apiVersion: v1');
  writer.line('kind: Secret');
  writer.line('metadata:');
  writer.block(() => {
    writer.line(`name: {{ include "${name}.fullname" . }}-secrets`);
    writer.line('labels:');
    writer.block(() => writer.line(`{{- include "${name}.labels" . | nindent 4 }}`));
  });
  writer.line('type: Opaque');
  writer.line('stringData:');
  writer.block(() => {
    for (const key of plan.secrets) writer.line(`${key}: ""`);
  });
  return writer.toString();
}

function ingress(plan: ContextPlan): string {
  const name = plan.serviceName;
  const writer = template();
  writer.line('{{- if .Values.ingress.enabled }}');
  writer.line('apiVersion: networking.k8s.io/v1');
  writer.line('kind: Ingress');
  writer.line('metadata:');
  writer.block(() => {
    writer.line(`name: {{ include "${name}.fullname" . }}`);
    writer.line('labels:');
    writer.block(() => writer.line(`{{- include "${name}.labels" . | nindent 4 }}`));
    writer.line('{{- with .Values.ingress.annotations }}');
    writer.line('annotations:');
    writer.block(() => writer.line('{{- toYaml . | nindent 4 }}'));
    writer.line('{{- end }}');
  });
  writer.line('spec:');
  writer.block(() => {
    writer.line('{{- with .Values.ingress.className }}');
    writer.line('ingressClassName: {{ . }}');
    writer.line('{{- end }}');
    writer.line('rules:');
    writer.block(() => {
      writer.line('- host: {{ .Values.ingress.host | quote }}');
      writer.block(() => {
        writer.line('http:');
        writer.block(() => {
          writer.line('paths:');
          writer.block(() => {
            writer.line('{{- range .Values.ingress.paths }}');
            writer.line('- path: {{ .path }}');
            writer.block(() => {
              writer.line('pathType: {{ .pathType }}');
              writer.line('backend:');
              writer.block(() => {
                writer.line('service:');
                writer.block(() => {
                  writer.line(`name: {{ include "${name}.fullname" $ }}`);
                  writer.line('port:');
                  writer.block(() => writer.line('number: {{ $.Values.service.port }}'));
                });
              });
            });
            writer.line('{{- end }}');
          });
        });
      });
    });
  });
  writer.line('{{- end }}');
  return writer.toString();
}

function horizontalPodAutoscaler(plan: ContextPlan): string {
  const name = plan.serviceName;
  const writer = template();
  writer.line('{{- if .Values.autoscaling.enabled }}');
  writer.line('apiVersion: autoscaling/v2');
  writer.line('kind: HorizontalPodAutoscaler');
  writer.line('metadata:');
  writer.block(() => {
    writer.line(`name: {{ include "${name}.fullname" . }}`);
    writer.line('labels:');
    writer.block(() => writer.line(`{{- include "${name}.labels" . | nindent 4 }}`));
  });
  writer.line('spec:');
  writer.block(() => {
    writer.line('scaleTargetRef:');
    writer.block(() => {
      writer.line('apiVersion: apps/v1');
      writer.line('kind: Deployment');
      writer.line(`name: {{ include "${name}.fullname" . }}`);
    });
    writer.line('minReplicas: {{ .Values.autoscaling.minReplicas }}');
    writer.line('maxReplicas: {{ .Values.autoscaling.maxReplicas }}');
    writer.line('metrics:');
    writer.block(() => {
      writer.line('- type: Resource');
      writer.block(() => {
        writer.line('resource:');
        writer.block(() => {
          writer.line('name: cpu');
          writer.line('target:');
          writer.block(() => {
            writer.line('type: Utilization');
            writer.line('averageUtilization: {{ .Values.autoscaling.targetCPUUtilizationPercentage }}');
          });
        });
      });
    });
  });
  writer.line('{{- end }}');
  return writer.toString();
}
