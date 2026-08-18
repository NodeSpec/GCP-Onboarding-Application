import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const sharedSrc = fileURLToPath(new URL('./packages/shared/src', import.meta.url));
const schemasSrc = fileURLToPath(new URL('./packages/schemas/src', import.meta.url));

export default defineConfig({
  // The console tests render real components, so JSX has to be transformed.
  // Everything else in the repo is plain TypeScript and unaffected.
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@lifecycle\/shared\/(.*)\.js$/, replacement: `${sharedSrc}/$1.ts` },
      { find: /^@lifecycle\/shared\/(.*)$/, replacement: `${sharedSrc}/$1.ts` },
      { find: /^@lifecycle\/shared$/, replacement: `${sharedSrc}/index.ts` },
      // The console imports the schemas package directly, so client and server
      // validate with the same code rather than two copies of the same rules.
      { find: /^@lifecycle\/schemas$/, replacement: `${schemasSrc}/index.ts` },
    ],
  },
  test: {
    include: ['packages/**/*.test.ts', 'services/**/*.test.ts', 'services/**/*.test.tsx'],
    // The emulator suite has its own config and its own command; it must not
    // run here, where there is no emulator listening.
    exclude: ['**/node_modules/**', '**/*.emulator.test.ts'],
    environment: 'node',
  },
});
