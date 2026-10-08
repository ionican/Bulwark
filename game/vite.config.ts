import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 8822, // W24 branch: 8821 is taken on codepanda
    strictPort: true,
    allowedHosts: ['codepandas-mac-studio.tailf809db.ts.net'],
    // map1.ts lives in ../model (W12); let the dev server read it.
    fs: { allow: ['..'] },
  },
  // W24 run 2a tests compare the ported kit with look/'s own (look/src imports 'three'): resolve it
  // to this package's copy, so the comparison does not depend on look/node_modules.
  resolve: { dedupe: ['three'] },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
