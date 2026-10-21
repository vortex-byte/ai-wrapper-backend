import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'tests/integration/**'],
    passWithNoTests: true,
    clearMocks: true,
    restoreMocks: true,
    // Unit runs never touch the rotating log files; the redaction suite enables them explicitly.
    // File transports are off; the per-IP/user buckets are raised so a test file's request
    // volume never trips the production defaults (the limiter itself is unit-tested).
    env: {
      LOG_TO_FILES: 'false',
      RATE_LIMIT_IP_REQUESTS: '100000',
      RATE_LIMIT_API_IP_REQUESTS: '100000',
      RATE_LIMIT_USER_REQUESTS: '100000',
      RATE_LIMIT_LOGIN_REQUESTS: '100000',
      RATE_LIMIT_GENERATION_REQUESTS: '100000',
      RATE_LIMIT_UPLOAD_REQUESTS: '100000',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/cli/**', 'src/server.ts'],
      thresholds: {
        'src/orchestrator/**': { lines: 80 },
        'src/context-builder/**': { lines: 80 },
        'src/quota/domain/**': { lines: 80 },
      },
    },
  },
});
