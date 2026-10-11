import { execSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';

// The build stamp the game shows in its corner (src/version.ts), read from git when Vite starts:
// the build number is the count of commits on the branch, then the commit and its date, and
// whether the tree had uncommitted changes. Outside a git checkout every field falls back.
function git(args: string): string {
  try {
    return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}
const BUILD = {
  number: Number(git('rev-list --count HEAD')) || 0,
  commit: git('rev-parse --short HEAD') || 'unknown',
  date: git('log -1 --format=%cs'),
  local: git('status --porcelain') !== '',
};

export default defineConfig({
  define: { __BUILD__: JSON.stringify(BUILD) },
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
