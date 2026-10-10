// W24 run 3, criterion 11 (G; Richard 2026-10-10 signed off the models look: "oh yes - remove").
// The `?greybox=1` switch is gone: main.ts no longer reads it, the adapter and the view have no
// greybox branch, and `__game.renderMode` (a getter) reports 'models'. Nothing under src/ is left
// unimported (every file is reachable from main.ts, which starts the worker), so no greybox-only
// file stays behind. The browser half — `?greybox=1` loads the models view and
// `__game.renderMode === 'models'` — is in scripts/check-panel.mjs.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const read = (f: string) => readFileSync(join(SRC, f), 'utf8');

/** Every .ts file under src/ (declaration files aside). */
function allFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...allFiles(p));
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Files reachable from `entry` by relative imports, dynamic imports and `new URL(…)` worker entries. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    let src: string;
    try {
      src = readFileSync(f, 'utf8');
    } catch {
      return;
    }
    for (const m of src.matchAll(/(?:import|export)[^'"]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|new URL\(\s*['"](\.[^'"]+)['"]/g)) visit(resolve(dirname(f), m[1] ?? m[2] ?? m[3]!));
  };
  visit(entry);
  return seen;
}

describe('run 3 criterion 11: the greybox view is removed', () => {
  it('main.ts does not read ?greybox; renderMode is a getter reporting models', () => {
    const main = read('main.ts');
    expect(main).not.toMatch(/params\.get\(['"]greybox['"]\)/);
    expect(main).not.toMatch(/['"]greybox['"]/);
    expect(main).toMatch(/get renderMode\(\)[^{]*\{\s*return 'models';/);
  });

  it('the adapter and the view have no greybox branch', () => {
    expect(read('render/adapter.ts')).not.toMatch(/greybox/);
    expect(read('render/view.ts')).not.toMatch(/mode === 'greybox'|greybox/);
    expect(read('ui/hud.ts')).not.toMatch(/"greybox"/);
  });

  it('every file under src/ is imported (no greybox-only file left behind)', () => {
    const seen = reachable(join(SRC, 'main.ts'));
    const orphans = allFiles().filter((f) => !seen.has(f)).map((f) => f.slice(SRC.length));
    expect(orphans).toEqual([]);
  });
});
