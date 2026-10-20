import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/health.ts', 'src/server.ts'],
      exclude: ['src/index.ts'],
      thresholds: { lines: 81, functions: 81, branches: 81, statements: 81 }
    }
  }
});
