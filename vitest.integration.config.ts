import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Integration tests: they need a real MongoDB **replica set** (MONGODB_URI in .env), so they are
 * kept out of `npm test` / `npm run verify`, which must pass on any machine with no database.
 *
 *   npm run test:integration
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.int.test.ts'],
    pool: 'forks',
    // One file at a time: they share a database, and parallel files would only add noise to the
    // concurrency each test creates deliberately.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // tenantIsolation.int.test.ts walks every route over real HTTP from one address — a few
    // hundred requests a minute. dotenv never overrides a variable already set, so this wins.
    // SMTP_HOST empty: emails go to `outbox` (mailer.service.ts) where the tests read the links,
    // never to a real inbox. AUTH_RATE_LIMIT_MAX for the same reason as RATE_LIMIT_MAX.
    env: {
      RATE_LIMIT_MAX: '100000',
      AUTH_RATE_LIMIT_MAX: '100000',
      SMTP_HOST: '',
      JWT_PLATFORM_SECRET: 'integration-test-platform-secret-0123456789',
    },
  },
});
