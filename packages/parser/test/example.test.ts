import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DiagnosticBag, formatDiagnostics, indexModule } from '@ai-lang/core';
import { parseModule } from '../src/index.js';

const examplePath = fileURLToPath(new URL('../../../examples/orders/orders.ail', import.meta.url));

describe('the orders example', () => {
  const text = readFileSync(examplePath, 'utf8');
  const diagnostics = new DiagnosticBag();
  const { module } = parseModule('examples/orders/orders.ail', text, diagnostics);

  it('parses without errors', () => {
    expect(formatDiagnostics(diagnostics.errors, new Map([['examples/orders/orders.ail', text]]))).toBe('');
    expect(module).not.toBeNull();
  });

  it('reads the frontmatter', () => {
    expect(module?.name).toBe('orders');
    expect(module?.context).toBe('Sales');
    expect(module?.target).toBe('java');
    expect(module?.imports).toEqual([{ module: 'catalog', names: [], via: 'anti-corruption-layer' }]);
  });

  it('collects every declaration kind', () => {
    const index = indexModule(module!);
    expect(index.enums.map((d) => d.name)).toEqual(['OrderStatus']);
    expect(index.valueObjects.map((d) => d.name)).toEqual(['Money']);
    expect(index.entities.map((d) => d.name)).toEqual(['OrderItem']);
    expect(index.aggregates.map((d) => d.name)).toEqual(['Order']);
    expect(index.commands.map((d) => d.name)).toEqual(['PlaceOrder']);
    expect(index.events.map((d) => d.name)).toEqual(['OrderPlaced']);
    expect(index.errors.map((d) => d.name)).toEqual(['OrderNotFound', 'OrderAlreadyPlaced', 'EmptyOrder', 'EmptyOrderTotal']);
    expect(index.ports.map((d) => d.name)).toEqual(['OrderRepository', 'CustomerNotifier', 'PlaceOrderUseCase']);
    // The repository is declared inline on its port, so the parser names it.
    expect(index.adapters.map((d) => d.name)).toEqual(['SqlOrderRepository', 'EmailCustomerNotifier']);
    expect(index.services.map((d) => d.name)).toEqual(['PlaceOrderService']);
    expect(index.endpoints).toHaveLength(2);
    expect(index.handlers.map((d) => d.name)).toEqual(['NotifyOnPlacement']);
  });

  it('captures the aggregate structure', () => {
    const order = indexModule(module!).typed('Order', 'aggregate')!;
    expect(order.identity).toEqual(['id']);
    expect(order.entities).toEqual(['OrderItem']);
    expect(order.emits).toEqual(['OrderPlaced']);
    expect(order.invariants).toHaveLength(1);
    expect(order.invariants[0]!.description).toBe('an order must hold at least one item');
    expect(order.fields.find((f) => f.name === 'total')?.derived).toBe(true);
    expect(order.fields.find((f) => f.name === 'placedAt')?.required).toBe(false);
  });

  it('captures checked and unchecked errors with their status codes', () => {
    const index = indexModule(module!);
    expect(index.typed('OrderNotFound', 'error')).toMatchObject({ checked: true, status: 404 });
    expect(index.typed('EmptyOrderTotal', 'error')).toMatchObject({ checked: false });
  });

  it('parses the service body into statements', () => {
    const service = indexModule(module!).typed('PlaceOrderService', 'service')!;
    expect(service.uses).toEqual(['OrderRepository']);
    expect(service.implements).toBe('PlaceOrderUseCase');

    const operation = service.operations[0]!;
    expect(operation.phrase).toBe('place order');
    expect(operation.name).toBe('placeOrder');
    expect(operation.returns).toEqual({
      kind: 'result',
      ok: { kind: 'named', name: 'OrderPlaced' },
      errors: ['OrderNotFound', 'OrderAlreadyPlaced', 'EmptyOrder'],
    });
    expect(operation.body.map((s) => s.kind)).toEqual([
      'let',
      'when',
      'when',
      'let',
      'let',
      'set',
      'set',
      'set',
      'perform',
      'publish',
      'return',
    ]);
  });

  it('parses the endpoint contract', () => {
    const endpoint = indexModule(module!).endpoints.find((e) => e.method === 'POST')!;
    expect(endpoint.method).toBe('POST');
    expect(endpoint.path).toBe('/orders/{orderId}/place');
    expect(endpoint.handler).toEqual({ service: 'PlaceOrderService', operation: 'place order' });
    expect(endpoint.auth).toBe('bearer');
    expect(endpoint.responses).toEqual([
      { status: 200, body: { kind: 'named', name: 'OrderPlaced' } },
      { status: 404, when: 'OrderNotFound' },
      { status: 409, when: 'OrderAlreadyPlaced' },
      { status: 422, when: 'EmptyOrder' },
    ]);
  });

  it('parses the infrastructure block', () => {
    expect(module?.infrastructure).toMatchObject({
      port: 8080,
      databases: [{ name: 'ordersdb', engine: 'postgres', version: '16', storageGb: 50 }],
      brokers: [{ name: 'events', engine: 'kafka', topics: ['order-placed'] }],
      caches: [{ name: 'sessions', engine: 'redis' }],
      secrets: ['DB_PASSWORD', 'KAFKA_PASSWORD'],
      environment: { LOG_LEVEL: 'info', REGION: 'eu-west-1' },
      scaling: { min: 2, max: 10, targetCpuPercent: 70 },
      deploy: ['docker', 'kubernetes', 'terraform'],
    });
  });
});
