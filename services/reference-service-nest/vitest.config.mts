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
    },
  },
});
