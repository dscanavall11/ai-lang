/**
 * The examples are documentation that has to keep working.
 *
 * Every one of them is quoted somewhere — in the README, in AGENTS.md, in the
 * language reference — so a change to the compiler that quietly invalidates one
 * has already published wrong advice.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'haic-examples-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += String(chunk)), true));
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => ((err += String(chunk)), true));
  try {
    return { code: await main(argv, repoRoot), out, err };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

/** Every example that holds sources. `requirements/` holds a brief, not a design. */
const directories = readdirSync(join(repoRoot, 'examples'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => readdirSync(join(repoRoot, 'examples', name)).some((file) => file.endsWith('.hadl')))
  .sort();

describe.each(directories)('examples/%s', (name) => {
  const path = `examples/${name}`;

  it('checks without an error', async () => {
    const { code, out } = await run(['check', path]);
    expect(out).not.toContain('error[');
    expect(code).toBe(0);
  });

  it('runs whatever scenarios it declares', async () => {
    const { code, out } = await run(['test', path]);
    expect(out).not.toContain('✗');
    expect(code).toBe(0);
  });
});

/**
 * The three systems written to exercise fenced blocks. Each one carries logic
 * that is not CRUD and not expressible as statements, so each one is a case the
 * escape hatch has to hold up under.
 */
describe('the non-CRUD systems', () => {
  const cases = [
    { module: 'matching', snippet: 'while (remaining > 0' },
    { module: 'ledger', snippet: 'Math.round(posting.amount.amount * 100)' },
    { module: 'dispatch', snippet: 'Math.asin(Math.sqrt(a))' },
  ];

  for (const { module, snippet } of cases) {
    it(`compiles examples/${module} into TypeScript that carries its block`, async () => {
      const out = join(scratch, module);
      const built = await run(['build', `examples/${module}`, '--language', 'ts', '--out', out]);
      expect(built.code).toBe(0);

      const model = readFileSync(join(out, 'typescript', 'src', 'domain', module, 'model.ts'), 'utf8');
      expect(model).toContain(snippet);
      expect(model).toContain('copied verbatim');
    });
  }

  it('compiles a scenario the interpreter cannot run into a test that can', async () => {
    // `match incoming` is written in TypeScript and Python, so `haic test`
    // defers it — and the generated project carries the test that runs it.
    const ran = await run(['test', 'examples/matching']);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('deferred to the target language');

    const out = join(scratch, 'compiled-scenarios');
    expect((await run(['build', 'examples/matching', '--ts', '--out', out])).code).toBe(0);
    const tests = readFileSync(join(out, 'typescript', 'src', 'domain', 'matching', 'scenarios.test.ts'), 'utf8');
    expect(tests).toContain('book.matchIncoming(');
    expect(tests).toContain('a crossing order takes the resting price');
  });

  it('says nothing about an operation a scenario reaches', async () => {
    const { out } = await run(['check', 'examples/matching']);
    expect(out).not.toContain('HADL2602');
  });

  it('keeps the ledger silent, because its block has statements beside it', async () => {
    const { code, out } = await run(['check', 'examples/ledger']);
    expect(out).not.toContain('HADL2602');
    expect(code).toBe(0);
  });
});
