import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sharedSrc = fileURLToPath(new URL('./packages/shared/src', import.meta.url));

/**
 * Emulator suite. Separate from the unit config so `npm test` stays fast and
 * needs no Java, no downloads and no listening ports, while the criteria that
 * genuinely depend on Firestore semantics get exercised against the real thing.
 *
 * Single-threaded on purpose: these tests share one emulator instance and
 * assert on collection contents, so parallel files would see each other's data.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@lifecycle\/shared\/(.*)\.js$/, replacement: `${sharedSrc}/$1.ts` },
      { find: /^@lifecycle\/shared\/(.*)$/, replacement: `${sharedSrc}/$1.ts` },
      { find: /^@lifecycle\/shared$/, replacement: `${sharedSrc}/index.ts` },
    ],
  },
  test: {
    include: ['packages/**/*.emulator.test.ts', 'services/**/*.emulator.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
