import { defineConfig } from 'vitest/config';
// Benchmarks outside npm test: npx vitest run --config scripts/vitest.bench.config.ts
export default defineConfig({ test: { environment: 'node', include: ['scripts/**/*.test.ts'] } });
