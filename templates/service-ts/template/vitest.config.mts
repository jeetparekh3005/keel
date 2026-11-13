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
      // A floor so the service's coverage cannot silently regress. Set to @keel/core's parity
      // bar: the suite clears it WITHOUT Postgres. The repository is exercised by unit tests over
      // a fake pg pool (asserting the SQL/params, the row<->domain mapping, and the not-found /
      // error translation), and the composition root by a wiring e2e that boots AppModule with the
      // pool replaced by a fake. The only line the DB-free run cannot reach is infra.module's live
      // Database.connect factory; the real-DB CRUD e2e (describe.skipIf-gated on
      // KEEL_TEST_DATABASE_URL) covers it in CI, so CI coverage only exceeds this floor.
      thresholds: { statements: 74, branches: 61, functions: 82, lines: 74 },
    },
  },
});
