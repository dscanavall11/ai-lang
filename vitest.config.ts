import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string): string => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against sources, so `npm test` never needs a build first.
    alias: {
      '@ai-lang/core': src('core'),
      '@ai-lang/parser': src('parser'),
      '@ai-lang/analyzer': src('analyzer'),
      '@ai-lang/codegen': src('codegen'),
      '@ai-lang/iac': src('iac'),
      '@ai-lang/architect': src('architect'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
