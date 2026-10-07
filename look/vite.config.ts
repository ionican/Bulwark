import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 8817,
    strictPort: true,
    allowedHosts: ['codepandas-mac-studio.tailf809db.ts.net'],
    // The map layout and terrain come from ../game/src/sim and ../model (read-only).
    fs: { allow: ['..'] },
  },
  preview: { host: '127.0.0.1', port: 8817, strictPort: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
    // two pages: the W17/W18 vista (index.html) and the W20 turret bench (bench.html)
    rollupOptions: { input: { main: fileURLToPath(new URL('./index.html', import.meta.url)), bench: fileURLToPath(new URL('./bench.html', import.meta.url)) } },
  },
});
