import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('./src/', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // homebridge-ui/server.js imports the compiled plugin from ../dist/.
      // Point tests at the TypeScript sources instead, so they never run
      // against a stale (or missing) build.
      { find: /^\.\.\/dist\/(.*)\.js$/, replacement: `${srcDir}$1.ts` },
    ],
  },
  test: {
    environment: 'node',
    globals: true,
    include: [
      'src/**/*.{test,spec}.ts',
      'test/**/*.{test,spec}.ts',
      'tests/**/*.{test,spec}.ts',
    ],
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'homebridge-ui/**/*.js'],
      // app.js is DOM wiring with no test environment for it; its logic lives
      // in helpers.js, which is covered.
      exclude: [
        'src/**/*.{test,spec}.ts',
        'src/**/__tests__/**',
        'homebridge-ui/public/lib/**',
        'homebridge-ui/public/app.js',
      ],
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 75,
        statements: 80,
      },
    },
  },
  oxc: {
    target: 'es2022',
  },
});
