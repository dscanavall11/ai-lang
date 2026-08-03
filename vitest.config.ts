import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string): string => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against sources, so `npm test` never needs a build first.
    alias: {
      '@haic/core': src('core'),
      '@haic/parser': src('parser'),
      '@haic/analyzer': src('analyzer'),
      '@haic/codegen': src('codegen'),
      '@haic/iac': src('iac'),
      '@haic/architect': src('architect'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
