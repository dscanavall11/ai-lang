import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'ail-cli-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Runs a command with stdout and stderr captured. */
async function run(argv: string[], cwd = repoRoot): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
  try {
    const code = await main(argv, cwd);
    return { code, out, err };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe('the haic command', () => {
  it('reports usage when called with nothing', async () => {
    const { code, out } = await run([]);
    expect(code).toBe(2);
    expect(out).toContain('the HADL compiler');
  });

  it('checks the worked example without errors', async () => {
    const { code, out } = await run(['check', 'examples/orders']);
    expect(code).toBe(0);
    expect(out).toContain('2 modules, 2 bounded contexts');
    expect(out).toContain('Catalogue → Sales (anti-corruption-layer)');
  });

  it('fails on a source with a broken design rule', async () => {
    const { code, out } = await run(['check', 'packages/cli/test/fixtures/embeds-aggregate.hadl']);
    expect(code).toBe(1);
    expect(out).toContain('HADL2207');
    expect(out).toContain('store the identity instead');
  });

  it('emits IR that round-trips as JSON', async () => {
    const { code, out } = await run(['ir', 'examples/orders']);
    expect(code).toBe(0);
    const project = JSON.parse(out) as { modules: unknown[]; irVersion: string };
    expect(project.irVersion).toBe('0.1');
    expect(project.modules).toHaveLength(2);
  });

  it('scaffolds a project that checks clean', async () => {
    const created = await run(['new', 'demo-service'], scratch);
    expect(created.code).toBe(0);

    const root = join(scratch, 'demo-service');
    expect(readFileSync(join(root, 'hadl.json'), 'utf8')).toContain('"defaultTarget": "typescript"');

    const checked = await run(['check', 'src'], root);
    expect(checked.out).not.toContain('error[');
    expect(checked.code).toBe(0);
  });

  it('refuses to overwrite an existing directory', async () => {
    const { code, err } = await run(['new', 'demo-service'], scratch);
    expect(code).toBe(1);
    expect(err).toContain('already exists');
  });

  it('builds the example into a target language', async () => {
    const { code, out } = await run(['build', 'examples/orders', '--target', 'typescript', '--out', join(scratch, 'out')]);
    expect(code).toBe(0);
    expect(out).toContain('src/domain/orders/model.ts');
  });

  it('explains the reasoning behind a design rule', async () => {
    const { code, out } = await run(['explain', 'HADL2503']);
    expect(code).toBe(0);
    expect(out).toContain('A service operation that only forwards');
  });

  it('rejects an unknown command', async () => {
    const { code, err } = await run(['frobnicate']);
    expect(code).toBe(2);
    expect(err).toContain('unknown command');
  });
});

describe('the architect command', () => {
  it('turns a requirements document into a spec and drafts', async () => {
    const out = join(scratch, 'library');
    const { code, out: stdout } = await run(['architect', 'examples/requirements/library.md', '--out', out]);
    expect(code).toBe(0);
    expect(stdout).toContain('.ai-spec/01-requirements.md');
    expect(stdout).toContain('Open questions');

    // The drafts it wrote must survive the compiler it wrote them for.
    const checked = await run(['check', 'src'], out);
    expect(checked.out).not.toContain('error[');
    expect(checked.code).toBe(0);
  });

  it('reports a missing requirements file rather than guessing', async () => {
    const { code, err } = await run(['architect', 'nope.md']);
    expect(code).toBe(1);
    expect(err).toContain('cannot read');
  });
});

describe('the deploy command', () => {
  it('generates only the platforms the sources declare', async () => {
    const { code, out } = await run(['deploy', 'examples/orders', '--out', join(scratch, 'iac')]);
    expect(code).toBe(0);
    expect(out).toContain('Docker Compose');
    expect(out).toContain('Kubernetes (Helm)');
    expect(out).toContain('Terraform (AWS)');
    // The orders example never asks for Lambda.
    expect(out).not.toContain('AWS Lambda');
  });

  it('lists every registered target', async () => {
    const { code, out } = await run(['targets']);
    expect(code).toBe(0);
    for (const id of ['typescript', 'java', 'python', 'go', 'rust', 'docker', 'kubernetes', 'terraform', 'aws-lambda']) {
      expect(out).toContain(id);
    }
  });
});

describe('the test command', () => {
  it('runs the scenarios the sources declare', async () => {
    const { code, out } = await run(['test', 'examples/crud']);
    expect(code).toBe(0);
    expect(out).toContain('creating a task');
    expect(out).toMatch(/\d+ passed/);
  });

  it('reports when nothing matches the filter', async () => {
    const { code, err } = await run(['test', 'examples/crud', '--only', 'nothing-like-this']);
    expect(code).toBe(0);
    expect(err).toContain('no scenario matches');
  });

  it('says so rather than passing when a module declares no scenarios', async () => {
    const { code, err } = await run(['test', 'examples/billing']);
    expect(code).toBe(0);
    expect(err).toContain('no scenarios found');
  });
});
