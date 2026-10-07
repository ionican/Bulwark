import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 8816,
    strictPort: true,
    allowedHosts: ['codepandas-mac-studio.tailf809db.ts.net'],
    // The map layout and terrain come from ../game/src/sim and ../model (read-only).
    fs: { allow: ['..'] },
  },
  preview: { host: '127.0.0.1', port: 8816, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 1600 },
});
