import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// NestJS relies on decorator metadata (emitDecoratorMetadata) for dependency injection.
// esbuild (vitest's default transformer) does not emit it, so compile tests with SWC.
export default defineConfig({
  plugins: [swc.vite()],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/index.ts'],
      // A floor so coverage cannot silently regress (the Python vertical enforces one too).
      // Ratcheted up toward Python's 85% as coverage grows; set just under the current level.
      thresholds: { statements: 74, branches: 61, functions: 82, lines: 74 },
    },
  },
});
