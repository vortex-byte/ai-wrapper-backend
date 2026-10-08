import { defineConfig } from 'vitest/config';

// Unit tests: no database, no network. Integration tests live behind
// `vitest.integration.config.ts` and require a real PostgreSQL (TEST_DATABASE_URL).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'tests/integration/**'],
    passWithNoTests: true,
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/cli/**', 'src/server.ts'],
    },
  },
});
