import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * One test run across every workspace package.
 *
 * The aliases point @lifecycle/shared at its TypeScript SOURCE rather than its
 * built dist. Without them a unit test run would depend on the shared package
 * having been compiled first, which makes a fast feedback loop conditional on a
 * build step and produces a confusing 'file does not exist' failure the first
 * time someone clones the repository.
 */

const sharedSrc = fileURLToPath(new URL('./packages/shared/src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // Subpath imports carrying the ESM .js extension, e.g.
      // '@lifecycle/shared/logging.js'.
      { find: /^@lifecycle\/shared\/(.*)\.js$/, replacement: `${sharedSrc}/$1.ts` },
      // Subpath imports without an extension.
      { find: /^@lifecycle\/shared\/(.*)$/, replacement: `${sharedSrc}/$1.ts` },
      // The barrel.
      { find: /^@lifecycle\/shared$/, replacement: `${sharedSrc}/index.ts` },
    ],
  },
  test: {
    include: ['packages/**/*.test.ts', 'services/**/*.test.ts'],
    environment: 'node',
  },
});
