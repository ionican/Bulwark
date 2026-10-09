// W24 run 2b, criteria 7 and 1. Capacity: the projectile table full (4,096 rows, every kind) is
// drawn row for row — tracers for bullets, shells and heavy shells, the alien-shot shape for alien
// projectiles — with `overflowed` false; the effect pools are sized from the simulation's table
// capacities. Snapshot-only: the run 2a import-graph walk reaches the new render modules and they
// import only the pure simulation modules.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { B, P_ALIEN, P_BULLET, P_HEAVY, P_SHELL } from '../src/sim/kinds.ts';
import { T_BUILDING } from '../src/sim/schema.ts';
import { CAPACITY, World } from '../src/sim/world.ts';
import { drawAt, fx, nextEpoch, renderer, slot, snapAt, terrain } from './w24r2b-fixtures.ts';

const { r, scene } = renderer();

describe('criterion 7: every projectile row at the simulation’s capacity is drawn', () => {
  it('4,096 rows: 3,072 tracers and 1,024 alien shots, nothing overflowed', () => {
    const w = new World(1, terrain, { waves: false });
    const gun = w.placeBuilding(B.gun, 66, 56, true);
    const kinds = [P_BULLET, P_SHELL, P_HEAVY, P_ALIEN];
    for (let i = 0; i < CAPACITY.projectiles; i++) {
      const p = w.projectiles.create();
      const c = w.projectiles.cols;
      c.kind[slot(p)] = kinds[i % 4]!;
      c.x[slot(p)] = 10 + (i % 100);
      c.z[slot(p)] = 10 + Math.floor(i / 100) * 2;
      c.fx[slot(p)] = 1;
      c.srcType[slot(p)] = T_BUILDING;
      c.srcId[slot(p)] = gun;
    }
    const s = snapAt(w, 10);
    expect(s.projectiles.count).toBe(CAPACITY.projectiles);
    const E = nextEpoch();
    drawAt(r, s, { t: 0, dt: 0, world: E });
    drawAt(r, s, { t: 0.02, dt: 0.02, world: E });
    expect(fx(scene, 'overlay/fx/tracer').length).toBe((CAPACITY.projectiles * 3) / 4);
    expect(fx(scene, 'overlay/fx/alien-shot').length).toBe(CAPACITY.projectiles / 4);
    expect(r.overflowed).toBe(false);
    // and when they all go at once (impacts are particles, bounded by W21's caps): still no overflow
    s.projectiles.count = 0;
    drawAt(r, s, { t: 0.04, dt: 0.02, world: E });
    expect(fx(scene, 'overlay/fx/tracer').length).toBe(0);
    expect(r.overflowed).toBe(false);
  });
});

describe('criterion 1: snapshot-only, the new modules included', () => {
  const SRC = fileURLToPath(new URL('../src/', import.meta.url));
  const PURE_SIM = new Set(['sim/kinds.ts', 'sim/balance.ts', 'sim/schema.ts', 'sim/table.ts', 'sim/terrain.ts', 'sim/rng.ts']);
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith('.ts') ? [join(dir, n)] : []));
  const imports = (file: string): string[] => {
    const src = readFileSync(file, 'utf8');
    const out: string[] = [];
    const re = /(?:^|\n)\s*(import|export)\s+([\s\S]*?)\s+from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const spec = m[3] ?? m[4]!;
      const clause = (m[2] ?? '').trim();
      if (m[1] && /^type\s/.test(clause)) continue;
      if (m[1] && /^\{[\s\S]*\}$/.test(clause) && clause.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean).every((n) => n.startsWith('type '))) continue;
      out.push(spec.startsWith('.') ? resolve(dirname(file), spec) : spec);
    }
    return out;
  };
  const roots = files(join(SRC, 'render'));
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const d of imports(f)) if (d.startsWith('/') && d.endsWith('.ts')) stack.push(d);
  }
  const reached = [...seen].map((f) => relative(SRC, f));

  it('the walk reaches the run 2b modules (anim, effects) and the W26/W27 ones under render/', () => {
    for (const m of ['render/anim.ts', 'render/effects.ts', 'render/idle.ts', 'render/preview.ts']) expect(reached, m).toContain(m);
  });

  it('they import only the pure simulation modules', () => {
    const bad = reached.filter((f) => f.startsWith('sim/') && !PURE_SIM.has(f));
    expect(bad).toEqual([]);
  });
});
