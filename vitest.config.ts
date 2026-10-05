import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Each integration/API file boots its own in-process Postgres (PGlite, ~150 MB);
    // cap parallelism so the suite stays within memory on modest machines.
    pool: 'forks',
    maxWorkers: 2,
  },
});
