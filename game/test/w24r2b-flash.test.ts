// W24 run 2b, criterion 4 (and the recoil half of the matrix row "recoil + muzzle flash"):
// BF_FIRING in a snapshot whose tick is newer than the last one this turret flashed for gives one
// muzzle flash (the overlay/fx/flash mesh, read from the scene) and one recoil cycle of the gun
// parts; the same snapshot drawn over several frames, or a repeated snapshot of the same tick,
// gives no second flash. Flashes are best-effort (a snapshot can cover several ticks): at most one
// per turret per snapshot.

import { describe, expect, it } from 'vitest';
import { A, B } from '../src/sim/kinds.ts';
import { BF_COMPLETE, BF_FIRING, BF_STARTED } from '../src/sim/schema.ts';
import { World } from '../src/sim/world.ts';
import { GUN, STATIC } from '../src/render/workshop/kit/kit.ts';
import { drawAt, fx, nextEpoch, partInstances, renderer, rowIn, snapAt, terrain } from './w24r2b-fixtures.ts';

const { r, scene } = renderer();
const ON = BF_COMPLETE | BF_STARTED;

function turret(kind = B.gun) {
  const w = new World(1, terrain, { waves: false });
  const id = w.placeBuilding(kind, 66, 56, true);
  const alien = w.spawnAlien(A.rusher, 76.5, 50.5);
  const at = (tick: number, flags: number) => {
    const s = snapAt(w, tick);
    const row = rowIn(s.buildings, id);
    s.buildings.cols.flags[row] = flags;
    s.buildings.cols.target[row] = alien + 1;
    return s;
  };
  return { w, id, at };
}

describe('criterion 4: one flash per turret per newer firing snapshot', () => {
  it('two consecutive snapshots with BF_FIRING and different ticks give two flashes', () => {
    const g = turret();
    const E = nextEpoch();
    drawAt(r, g.at(10, ON), { t: 0, dt: 0, world: E });
    expect(fx(scene, 'overlay/fx/flash').length).toBe(0);
    drawAt(r, g.at(11, ON | BF_FIRING), { t: 0.002, dt: 0.002, world: E });
    expect(fx(scene, 'overlay/fx/flash').length).toBe(1);
    drawAt(r, g.at(12, ON | BF_FIRING), { t: 0.004, dt: 0.002, world: E });
    expect(fx(scene, 'overlay/fx/flash').length).toBe(2);
  });

  it('the same snapshot rendered over several frames gives one; a repeated snapshot of the same tick gives none', () => {
    const g = turret();
    const E = nextEpoch();
    drawAt(r, g.at(10, ON), { t: 0, dt: 0, world: E });
    const s = g.at(11, ON | BF_FIRING);
    let t = 0;
    for (let k = 0; k < 5; k++) {
      drawAt(r, s, { t: (t += 0.002), dt: 0.002, world: E });
      expect(fx(scene, 'overlay/fx/flash').length, `frame ${k}`).toBe(1);
    }
    // the worker sends the same tick again (paused, or a slow frame): a new object, the same tick
    drawAt(r, g.at(11, ON | BF_FIRING), { t: (t += 0.002), dt: 0.002, world: E });
    expect(fx(scene, 'overlay/fx/flash').length).toBe(1);
    // the flash is short: gone after 0.2 s of effect clock
    drawAt(r, s, { t: t + 0.2, dt: 0.2, world: E });
    expect(fx(scene, 'overlay/fx/flash').length).toBe(0);
  });

  it('a batched snapshot (several ticks at once) with BF_FIRING gives one flash', () => {
    const g = turret();
    const E = nextEpoch();
    drawAt(r, g.at(10, ON), { t: 0, dt: 0, world: E });
    drawAt(r, g.at(13, ON | BF_FIRING), { t: 0.002, dt: 0.002, world: E });
    expect(fx(scene, 'overlay/fx/flash').length).toBe(1);
  });

  it('recoil: the gun parts kick back along the barrel and return as the clock advances; the base does not move', () => {
    const g = turret();
    const kind = r.kitKinds.get(B.gun)!;
    const gun = kind.placed.find((p) => p.pivot[0] === GUN && p.part.levels[0]!.size > 0)!.part.id;
    const base = kind.placed.find((p) => p.pivot[0] === STATIC && p.part.levels[0]!.size > 0)!.part.id;
    const E = nextEpoch();
    drawAt(r, g.at(10, ON), { t: 0, dt: 0, world: E });
    const rest = partInstances(scene, `kit/${gun}`)[0]!;
    const base0 = partInstances(scene, `kit/${base}`)[0]!;
    const s = g.at(11, ON | BF_FIRING);
    drawAt(r, s, { t: 0.002, dt: 0.002, world: E });
    drawAt(r, s, { t: 0.06, dt: 0.058, world: E });
    const kicked = partInstances(scene, `kit/${gun}`)[0]!;
    // displacement against the barrel axis (column 0)
    const ax = [rest[0]!, rest[1]!, rest[2]!];
    const al = Math.hypot(...ax);
    const along = ((kicked[12]! - rest[12]!) * ax[0]! + (kicked[13]! - rest[13]!) * ax[1]! + (kicked[14]! - rest[14]!) * ax[2]!) / al;
    expect(along, 'moved backwards along the barrel').toBeLessThan(-0.05);
    expect(partInstances(scene, `kit/${base}`)[0]!).toEqual(base0);
    drawAt(r, s, { t: 0.8, dt: 0.74, world: E });
    const back = partInstances(scene, `kit/${gun}`)[0]!;
    expect(Math.hypot(back[12]! - rest[12]!, back[13]! - rest[13]!, back[14]! - rest[14]!), 'back in battery').toBeLessThan(1e-4);
  });
});
