import { defineConfig } from 'vitest/config';

/**
 * Test discovery.
 *
 * Build output is excluded explicitly. Without it vitest collected both
 * shared/src/**.test.ts and its compiled twin in shared/dist, so every
 * shared test ran twice — and after a change, the stale copy failed while
 * the real one passed, which looks exactly like a flaky test.
 */
export default defineConfig({
  test: {
    include: ['**/src/**/*.test.ts', '**/src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**'],
  },
});
