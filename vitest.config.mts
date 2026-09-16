import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    // Every test is hermetic: mocked transport and a hand-driven clock. A test
    // that needs more than 15s is a hung scheduler, which is a failure.
    testTimeout: 15_000,
  },
});
