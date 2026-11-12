import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// NestJS relies on decorator metadata (emitDecoratorMetadata) for dependency injection.
// esbuild (vitest's default transformer) does not emit it, so compile tests with SWC.
export default defineConfig({
  plugins: [swc.vite()],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.e2e.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/**/index.ts'],
      // A floor so the service's coverage cannot silently regress (@keel/core enforces one too).
      // Set just under the level this suite clears WITHOUT Postgres: the real-DB CRUD e2e is
      // describe.skipIf-gated on KEEL_TEST_DATABASE_URL, so the item repository is only exercised
      // in CI. The floor must therefore pass on the leaner local run; CI (with Postgres) only
      // covers more. Well below @keel/core's 74/61/82/74 - the gap is the repository, which has no
      // coverage without a database. Ratchet up as in-process (DB-free) tests grow.
      thresholds: { statements: 37, branches: 35, functions: 42, lines: 37 },
    },
  },
});
