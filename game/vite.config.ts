import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 8813,
    strictPort: true,
    allowedHosts: ['codepandas-mac-studio.tailf809db.ts.net'],
    // map1.ts lives in ../model (W12); let the dev server read it.
    fs: { allow: ['..'] },
  },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
