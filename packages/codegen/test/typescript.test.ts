import { describe, expect, it } from 'vitest';
import { generateProject, typescriptGenerator } from '../src/index.js';
import { assertImportsResolve, fileNamed, ordersProject } from './helpers.js';

const project = ordersProject();
const result = generateProject(typescriptGenerator, { project, outputDir: 'out/typescript', options: {} });

describe('the TypeScript backend', () => {
  it('lays the project out by hexagonal layer', () => {
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain('src/domain/orders/model.ts');
    expect(paths).toContain('src/application/orders/ports.ts');
    expect(paths).toContain('src/application/orders/services.ts');
    expect(paths).toContain('src/infrastructure/orders/adapters.ts');
    expect(paths).toContain('src/interface/orders/routes.ts');
    expect(paths).toContain('src/interface/orders/handlers.ts');
    expect(paths).toContain('package.json');
    expect(paths).toContain('tsconfig.json');
  });

  it('emits imports that resolve to other generated files', () => {
    assertImportsResolve(result.files, '.ts');
  });

  it('never imports a file from itself', () => {
    for (const generated of result.files) {
      const own = generated.path.split('/').pop()!.replace('.ts', '');
      expect(generated.contents).not.toMatch(new RegExp(`from '\\./${own}\\.js'`));
    }
  });

  it('turns an invariant into a runtime check on the aggregate', () => {
    const model = fileNamed(result.files, 'src/domain/orders/model.ts').contents;
    expect(model).toContain('checkInvariants(): void {');
    expect(model).toContain('if (!(this.items.length > 0)) throw new InvariantViolation');
  });

  it('lowers an aggregate expression into a map/reduce over the collection', () => {
    const model = fileNamed(result.files, 'src/domain/orders/model.ts').contents;
    expect(model).toContain('this.items.map((each) => (each.quantity * each.unitPrice.amount)).reduce(');
  });

  it('injects ports through the constructor, never adapters', () => {
    const services = fileNamed(result.files, 'src/application/orders/services.ts').contents;
    expect(services).toContain('private readonly orderRepository: OrderRepository,');
    expect(services).not.toContain('SqlOrderRepository');
  });

  it('propagates checked errors as typed throws with the declared status', () => {
    const errors = fileNamed(result.files, 'src/domain/orders/errors.ts').contents;
    expect(errors).toContain('export class OrderNotFound extends CheckedError {');
    expect(errors).toContain('static readonly status = 404;');
    expect(errors).toContain('export class EmptyOrderTotal extends UncheckedError {');
    // The message template is filled from the error's own fields.
    expect(errors).toContain('`no order exists with id ${String(details.orderId)}`');
  });

  it('documents the error contract on every operation', () => {
    const services = fileNamed(result.files, 'src/application/orders/services.ts').contents;
    expect(services).toContain('@throws OrderNotFound');
    expect(services).toContain('@throws OrderAlreadyPlaced');
    expect(services).toContain('@throws EmptyOrder');
  });

  it('destructures parameters so bodies read like the source', () => {
    const services = fileNamed(result.files, 'src/application/orders/services.ts').contents;
    expect(services).toContain('async placeOrder({ command }: { command: PlaceOrder }): Promise<OrderPlaced> {');
    expect(services).toContain('const order = await this.orderRepository.findOrderById({ id: command.orderId });');
  });

  it('generates real SQL for the repository phrases it recognises', () => {
    const adapters = fileNamed(result.files, 'src/infrastructure/orders/adapters.ts').contents;
    expect(adapters).toContain("private readonly table = 'orders';");
    expect(adapters).toContain('SELECT * FROM ${this.table} WHERE id = $1');
    expect(adapters).toContain('ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data');
  });

  it('says so plainly when it cannot implement an adapter operation', () => {
    const adapters = fileNamed(result.files, 'src/infrastructure/orders/adapters.ts').contents;
    expect(adapters).toContain('has no generated implementation for a http-client adapter; write it here.');
  });

  it('maps every declared response to a route', () => {
    const routes = fileNamed(result.files, 'src/interface/orders/routes.ts').contents;
    expect(routes).toContain("router.post('/orders/:orderId/place'");
    expect(routes).toContain("router.get('/orders/:id'");
    expect(routes).toContain('response.status(200).json(result);');
  });

  it('carries the infrastructure block into an env template', () => {
    const env = fileNamed(result.files, '.env.example').contents;
    expect(env).toContain('PORT=8080');
    expect(env).toContain('LOG_LEVEL=info');
    expect(env).toContain('DB_PASSWORD=');
    expect(env).toContain('ORDERSDB_URL=postgres://localhost/ordersdb');
  });

  it('emits nothing for a declaration kind the module does not use', () => {
    // The catalogue has no events, commands or handlers.
    const paths = result.files.map((f) => f.path);
    expect(paths).not.toContain('src/domain/catalog/messages.ts');
    expect(paths).not.toContain('src/interface/catalog/handlers.ts');
  });
});

describe('queries', () => {
  it('compiles a declared query into SQL built at call time', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { DiagnosticBag } = await import('@haic/core');
    const { parseModule } = await import('@haic/parser');
    const { analyze } = await import('@haic/analyzer');

    const path = 'examples/crud/tasks.hadl';
    const text = readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');
    const bag = new DiagnosticBag();
    const { module } = parseModule(path, text, bag);
    const analysed = analyze([module!], { projectName: 'tasks' });
    const emitted = generateProject(typescriptGenerator, { project: analysed.project, outputDir: 'out', options: {} });

    const shapes = fileNamed(emitted.files, 'src/domain/tasks/messages.ts').contents;
    expect(shapes).toContain('export interface TaskSearch {');

    const adapters = fileNamed(emitted.files, 'src/infrastructure/tasks/adapters.ts').contents;
    // The in-memory adapter filters with the same criteria the SQL one compiles.
    expect(adapters).toContain('function matchesTaskSearch(task: Task, query: TaskSearch): boolean {');
    expect(adapters).toContain('if (query.state !== null && !(task.state === query.state)) return false;');
    // A nullable column compared against a value is guarded, as SQL would treat it.
    expect(adapters).toContain('query.dueBefore !== null && task.dueOn !== null');
  });
});
