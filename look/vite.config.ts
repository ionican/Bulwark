import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 8819,
    strictPort: true,
    allowedHosts: ['codepandas-mac-studio.tailf809db.ts.net'],
    // The map layout and terrain come from ../game/src/sim and ../model (read-only).
    fs: { allow: ['..'] },
  },
  preview: { host: '127.0.0.1', port: 8819, strictPort: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
    // three pages: the W17/W18 vista (index.html), the W20 turret bench (bench.html) and the W21
    // turret stress test (stress.html)
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        bench: fileURLToPath(new URL('./bench.html', import.meta.url)),
        stress: fileURLToPath(new URL('./stress.html', import.meta.url)),
      },
    },
  },
});
