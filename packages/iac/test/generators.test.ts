import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DiagnosticBag, formatDiagnostics, type IRModule } from '@ai-lang/core';
import { analyze } from '@ai-lang/analyzer';
import { parseModule } from '@ai-lang/parser';
import { generateInfrastructure, infrastructureGenerators } from '../src/index.js';

const FILES = ['examples/orders/orders.ail', 'examples/orders/catalog.ail', 'examples/billing/subscriptions.ail'];

function project() {
  const bag = new DiagnosticBag();
  const sources = new Map<string, string>();
  const modules: IRModule[] = [];
  for (const path of FILES) {
    const text = readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');
    sources.set(path, text);
    const { module } = parseModule(path, text, bag);
    if (module) modules.push(module);
  }
  expect(formatDiagnostics(bag.errors, sources)).toBe('');
  return analyze(modules, { projectName: 'examples' }).project;
}

const irProject = project();
const outputs = infrastructureGenerators.all().map((generator) => ({
  generator,
  result: generateInfrastructure(generator, { project: irProject, outputDir: `out/${generator.id}`, options: {} }),
}));

describe.each(outputs)('the $generator.id generator', ({ generator, result }) => {
  const all = result.files.map((f) => f.contents).join('\n');

  it('emits files with clean relative paths', () => {
    expect(result.files.length).toBeGreaterThan(0);
    for (const generated of result.files) {
      expect(generated.path).not.toMatch(/\\/);
      expect(generated.path.startsWith('/')).toBe(false);
      expect(generated.contents.trim().length).toBeGreaterThan(0);
    }
  });

  it('provisions only what the sources declare', () => {
    // Every example declares postgres and kafka; none declares mysql or mongo.
    expect(all).not.toMatch(/\bmysql\b/i);
    expect(all).not.toMatch(/\bmongo/i);
  });

  it('names secrets without ever giving them a value', () => {
    const literal = /(?:DB_PASSWORD|KAFKA_PASSWORD|STRIPE_API_KEY)[ \t]*[=:][ \t]*["']?([^\s"'${}][^\s"'}]*)/g;
    expect([...all.matchAll(literal)].map((m) => m[1])).toEqual([]);
  });

  it('hardcodes no account id or credential', () => {
    expect(all).not.toMatch(/\b\d{12}\b/); // AWS account ids
    expect(all).not.toMatch(/AKIA[0-9A-Z]{16}/); // access keys
  });

  it('states a toolchain command that can verify its output', () => {
    expect(generator.verifyCommand?.length ?? 0).toBeGreaterThan(0);
  });

  it('warns rather than guessing when it cannot satisfy a declaration', () => {
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.severity).not.toBe('error');
      expect(diagnostic.code).toMatch(/^AIL3\d{3}$/);
    }
  });
});

describe('docker', () => {
  const docker = outputs.find((o) => o.generator.id === 'docker')!.result;
  const compose = docker.files.find((f) => f.path.endsWith('docker-compose.yml'))!.contents;

  it('publishes the port each module declared', () => {
    expect(compose).toContain('8080');
    expect(compose).toContain('8081');
    expect(compose).toContain('8082');
  });

  it('provisions one backing service per declared dependency', () => {
    expect(compose).toContain('ordersdb');
    expect(compose).toContain('catalogdb');
    expect(compose).toContain('billingdb');
    expect(compose).toMatch(/image: postgres:16/);
    expect(compose).toMatch(/redis/);
    expect(compose).toMatch(/kafka/);
  });

  it('builds one image per bounded context', () => {
    const dockerfiles = docker.files.filter((f) => f.path.endsWith('Dockerfile'));
    expect(dockerfiles.length).toBe(irProject.contexts.length);
  });
});

describe('kubernetes', () => {
  const helm = outputs.find((o) => o.generator.id === 'kubernetes')!.result;

  it('emits one chart per bounded context', () => {
    const charts = helm.files.filter((f) => f.path.endsWith('Chart.yaml'));
    expect(charts.length).toBe(irProject.contexts.length);
  });

  it('drives autoscaling from the declared scaling block', () => {
    const values = helm.files.filter((f) => f.path.endsWith('values.yaml')).map((f) => f.contents).join('\n');
    expect(values).toMatch(/minReplicas: 2/);
    expect(values).toMatch(/maxReplicas: 10/);
    expect(values).toMatch(/targetCPUUtilizationPercentage: 70/);
  });
});

describe('terraform', () => {
  const terraform = outputs.find((o) => o.generator.id === 'terraform')!.result;
  const all = terraform.files.map((f) => f.contents).join('\n');

  it('derives database resources from the declared engine and size', () => {
    expect(all).toContain('aws_db_instance');
    expect(all).toMatch(/engine\s*=\s*"postgres"/);
    expect(all).toMatch(/allocated_storage\s*=\s*100/);
  });

  it('keeps the region a variable rather than a constant', () => {
    expect(all).toMatch(/variable "(aws_)?region"/);
  });
});

describe('the registry', () => {
  it('exposes every platform the language documents', () => {
    expect(infrastructureGenerators.ids()).toEqual(['aws-lambda', 'docker', 'kubernetes', 'terraform']);
  });
});
