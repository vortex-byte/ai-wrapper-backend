import { defineConfig } from 'vitest/config';

// Integration tests run against a real PostgreSQL (native local PG 18 in dev via
// TEST_DATABASE_URL; Testcontainers in CI). Never point these at a dev/prod DB.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    passWithNoTests: true,
    hookTimeout: 60_000,
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
