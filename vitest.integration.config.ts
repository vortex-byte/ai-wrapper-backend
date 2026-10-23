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
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/integration/setup.ts'],
    passWithNoTests: true,
    hookTimeout: 60_000,
    testTimeout: 60_000,
    fileParallelism: false,
    env: {
      LOG_TO_FILES: 'false',
      RATE_LIMIT_IP_REQUESTS: '100000',
      RATE_LIMIT_API_IP_REQUESTS: '100000',
      RATE_LIMIT_USER_REQUESTS: '100000',
      RATE_LIMIT_LOGIN_REQUESTS: '100000',
      RATE_LIMIT_GENERATION_REQUESTS: '100000',
      RATE_LIMIT_UPLOAD_REQUESTS: '100000',
    },
  },
});
