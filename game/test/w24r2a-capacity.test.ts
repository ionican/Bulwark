// W24 run 2a, criterion 8: capacity. Every batch is sized from the simulation's table capacities.
// The building table full of walls (4,096 tiles: sixteen runs 64 long and 4 deep, the most wall
// the table can hold) is drawn in each construction state, at each tier and at each detail level,
// and the part instances actually submitted (the count of every instanced batch) must equal the
// instances W23's autotiler gives for that grid, built here independently; nothing overflows. The
// same for a table full of gun turrets (4,096 kit turrets), aliens (4,096), units (256) and icons.

import { describe, expect, it } from 'vitest';
import { InstancedMesh, type Object3D } from 'three';
import { A, B, U } from '../src/sim/kinds.ts';
import { BF_COMPLETE, BF_STARTED } from '../src/sim/schema.ts';
import { flatTerrain } from '../src/sim/terrain.ts';
import { CAPACITY, World } from '../src/sim/world.ts';
import { WallGrid } from '../src/render/workshop/w23/walls/grid.ts';
import { wallInstances } from '../src/render/workshop/w23/walls/layout.ts';
import { draw, renderer, snapshotOf } from './w24r2a-fixtures.ts';
import { standInMaterials } from '../src/render/materials.ts';
import { ALIEN_MAKERS } from '../src/render/workshop/models/procedural/aliens.ts';

const { r } = renderer();

/**
 * Submitted instances: per batch (one count per part × level; all materials of a part share it),
 * plus icons and outlines. Map 1's bare deposits (drawn on every frame) are left out.
 */
function submitted(root: Object3D): { parts: number; icons: number; outlines: number; w17: number } {
  const seen = new Set<string>();
  let parts = 0;
  let icons = 0;
  let outlines = 0;
  const w17 = new Map<string, number>();
  root.traverse((o) => {
    if (!(o instanceof InstancedMesh) || !o.visible || o.count === 0) return;
    if (o.name === 'icon/massDeposit' || o.name === 'icon/rareDeposit' || String(o.userData.part ?? '').startsWith('deposit/')) return;
    if (o.name.startsWith('icon/')) icons += o.count;
    else if (o.name === 'reserved-outline') outlines += o.count;
    else if (o.userData.part !== undefined) {
      const key = `${o.userData.part}@${o.userData.level}`;
      if (!seen.has(key)) {
        seen.add(key);
        parts += o.count;
      }
    } else if (o.userData.model !== undefined) w17.set(o.userData.model as string, o.count);
  });
  return { parts, icons, outlines, w17: [...w17.values()].reduce((a, b) => a + b, 0) };
}

describe('criterion 8: capacity', () => {
  const terrain = flatTerrain(128, 128);
  const w = new World(1, terrain, { waves: false });
  for (let run = 0; run < 16; run++) for (let y = run * 5; y < run * 5 + 4; y++) for (let x = 0; x < 64; x++) if (w.placeBuilding(B.wall, x, y, true) < 0) throw new Error('place');
  const full = snapshotOf(w);

  it('the fixture fills the building table', () => {
    expect(full.buildings.count).toBe(CAPACITY.buildings);
  });

  // what W23's autotiler gives for the same tiles, at each tier
  const expected = (tier: number, level: number): number => {
    const g = new WallGrid(128, 128);
    for (let run = 0; run < 16; run++) for (let y = run * 5; y < run * 5 + 4; y++) for (let x = 0; x < 64; x++) g.set(x, y, tier);
    return wallInstances(g).filter((i) => r.parts.get(i.part).levels[level as 0 | 1 | 2].size > 0).length;
  };

  for (const state of ['reserved', 'started', 'complete'] as const)
    for (const tier of [1, 2, 3])
      it(`walls ${state}, tier ${tier}: every part instance at every detail level, every icon, no overflow`, () => {
        const s = snapshotOf(w);
        const c = s.buildings.cols;
        for (let row = 0; row < s.buildings.count; row++) {
          c.tier[row] = tier;
          c.flags[row] = state === 'reserved' ? 0 : state === 'started' ? BF_STARTED : BF_STARTED | BF_COMPLETE;
          c.progress[row] = state === 'started' ? 0.5 : state === 'complete' ? 1 : 0;
        }
        for (const level of [0, 1, 2, 3]) {
          draw(r, s, { level });
          const n = submitted(r.group);
          if (state === 'reserved') {
            expect(n.outlines, `level ${level}`).toBe(CAPACITY.buildings);
            expect(n.parts).toBe(0);
          } else if (level === 3) {
            expect(n.icons).toBe(CAPACITY.buildings);
            expect(n.parts).toBe(0);
          } else {
            const want = expected(tier, level);
            expect(want).toBeGreaterThan(CAPACITY.buildings * 4);
            expect(n.parts, `level ${level}`).toBe(want);
          }
          expect(r.overflowed).toBe(false);
        }
      });

  it('a table full of gun turrets (4,096 kit turrets, 64 × 64 footprints of 2 × 2): every part at every level, every icon', () => {
    const t = new World(1, terrain, { waves: false });
    for (let y = 0; y < 128; y += 2) for (let x = 0; x < 128; x += 2) if (t.placeBuilding(B.gun, x, y, true) < 0) throw new Error('place');
    const s = snapshotOf(t);
    expect(s.buildings.count).toBe(CAPACITY.buildings);
    const kind = r.kitKinds.get(B.gun)!;
    for (const level of [0, 1, 2, 3]) {
      draw(r, s, { level });
      const n = submitted(r.group);
      if (level === 3) expect(n.icons).toBe(CAPACITY.buildings);
      else expect(n.parts).toBe(CAPACITY.buildings * kind.placed.filter((p) => p.part.levels[level]!.size > 0).length);
      expect(r.overflowed).toBe(false);
    }
  });

  it('a table full of belts (4,096 W17 models), aliens (4,096) and units (256): every instance, no overflow', () => {
    const t = new World(1, terrain, { waves: false });
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (t.placeBuilding(B.belt, x, y, true) < 0) throw new Error('place');
    for (let i = 0; i < CAPACITY.aliens; i++) t.spawnAlien(A.rusher, 64.5 + (i % 64) * 0.9, 0.5 + Math.floor(i / 64) * 1.9);
    for (let i = 0; i < CAPACITY.units; i++) t.spawnUnit(i ? U.engineer : U.commander, 0.5 + (i % 32) * 2, 66.5 + Math.floor(i / 32) * 4);
    const s = snapshotOf(t);
    expect(s.aliens.count).toBe(CAPACITY.aliens);
    expect(s.units.count).toBe(CAPACITY.units);
    draw(r, s, { level: 0 });
    const n = submitted(r.group);
    // belts are one W17 model each (all materials share one count)
    // a rusher is drawn as its parts (body and four legs, walk.ts): one instance each per rusher
    expect(n.w17).toBe(CAPACITY.buildings + CAPACITY.aliens * ALIEN_MAKERS.rusher(standInMaterials().alien).parts.length);
    // engineers: one instance per drawn segment of the rig; the commander likewise
    expect(n.parts).toBeGreaterThan(CAPACITY.units * 10);
    expect(r.overflowed).toBe(false);
    draw(r, s, { level: 3 });
    expect(submitted(r.group).icons).toBe(CAPACITY.buildings + CAPACITY.aliens + CAPACITY.units);
    expect(r.overflowed).toBe(false);
  });
});
