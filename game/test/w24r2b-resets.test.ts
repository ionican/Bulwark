// W24 run 2b, criterion 6: resets (render/anim.ts). The global reset signal is the worker's world
// epoch (RunnerInfo.world: loads, rewinds, world replacement) or the snapshot tick going backwards,
// passed to the renderer directly. On a reset every effect state is dropped: recoil 0, tracers and
// particles cleared (no impacts for the rows that vanished with the old world), doors snapped to the
// state the current snapshot implies, aim snapped to the current target, and each turret's
// last-flashed tick seeded to the restored tick, so a restored BF_FIRING is not replayed as a shot.
// A reused id (a new id in a slot) starts that slot from rest.

import { describe, expect, it } from 'vitest';
import { A, B, P_BULLET, U } from '../src/sim/kinds.ts';
import { BF_COMPLETE, BF_FIRING, BF_STARTED, T_BUILDING } from '../src/sim/schema.ts';
import { World } from '../src/sim/world.ts';
import { GUN } from '../src/render/workshop/kit/kit.ts';
import { diff, drawAt, fx, nextEpoch, partInstances, particles, renderer, rowIn, slot, snapAt, terrain } from './w24r2b-fixtures.ts';

const { r, scene } = renderer();
const ON = BF_COMPLETE | BF_STARTED;

function scenario() {
  const w = new World(1, terrain, { waves: false });
  const gun = w.placeBuilding(B.gun, 66, 56, true);
  w.placeBuilding(B.gate, 72, 66, true, 0, 3, 2);
  const eng = w.spawnUnit(U.engineer, 95.5, 90.5);
  const a1 = w.spawnAlien(A.rusher, 76.5, 50.5);
  const a2 = w.spawnAlien(A.hunter, 58.5, 50.5);
  const shots: number[] = [];
  for (let k = 0; k < 3; k++) {
    const p = w.projectiles.create();
    const c = w.projectiles.cols;
    c.kind[slot(p)] = P_BULLET;
    c.x[slot(p)] = 69 + k;
    c.z[slot(p)] = 54 - k;
    c.fz[slot(p)] = -1;
    c.srcType[slot(p)] = T_BUILDING;
    c.srcId[slot(p)] = gun;
    shots.push(p);
  }
  const at = (tick: number, flags: number, target: number) => {
    const s = snapAt(w, tick);
    const g = rowIn(s.buildings, gun);
    s.buildings.cols.flags[g] = flags;
    s.buildings.cols.target[g] = target;
    return s;
  };
  const kind = r.kitKinds.get(B.gun)!;
  const gunPart = `kit/${kind.placed.find((p) => p.pivot[0] === GUN && p.part.levels[0]!.size > 0)!.part.id}`;
  return { w, gun, eng, a1, a2, shots, at, gunPart };
}

const spread = () => {
  const l = partInstances(scene, 'gate/leaf');
  return Math.max(...l.map((m) => m[12]!)) - Math.min(...l.map((m) => m[12]!));
};

describe('criterion 6: a rewind mid-fire resets every effect', () => {
  for (const how of ['new world epoch', 'tick going backwards'] as const) {
    it(`${how}: tracers, particles and recoil cleared; doors and aim snapped; the restored BF_FIRING is not replayed`, () => {
      const g = scenario();
      const E = nextEpoch();
      // reference: the gun's rest matrix aimed at a2, and the fully open door spread
      g.w.units.cols.x[slot(g.eng)] = 73.5;
      g.w.units.cols.z[slot(g.eng)] = 69.0;
      const restRef = (() => {
        const RE = nextEpoch();
        const s = g.at(5, ON, g.a2 + 1);
        s.projectiles.count = 0;
        drawAt(r, s, { t: 0, dt: 0, world: RE });
        return { gun: partInstances(scene, g.gunPart)[0]!, open: spread() };
      })();
      // mid-fire in the live world: aiming at a1, firing, shots in flight, the engineer far away
      g.w.units.cols.x[slot(g.eng)] = 95.5;
      g.w.units.cols.z[slot(g.eng)] = 90.5;
      drawAt(r, g.at(100, ON, g.a1 + 1), { t: 0, dt: 0, world: E });
      let t = 0;
      for (let k = 0; k < 3; k++) drawAt(r, g.at(101 + k, ON | BF_FIRING, g.a1 + 1), { t: (t += 0.03), dt: 0.03, world: E });
      expect(fx(scene, 'overlay/fx/tracer').length).toBe(3);
      expect(fx(scene, 'overlay/fx/flash').length).toBeGreaterThan(0);
      expect(particles(scene, 'glow').length + particles(scene, 'smoke').length).toBeGreaterThan(0);
      const shutSpread = spread();
      // the rewind: an older tick (and, for the epoch case, a new epoch); no shots in flight then,
      // the engineer at the gate, the gun firing at a2 in the restored snapshot
      for (const p of g.shots) g.w.projectiles.remove(slot(p));
      g.w.units.cols.x[slot(g.eng)] = 73.5;
      g.w.units.cols.z[slot(g.eng)] = 69.0;
      const restored = g.at(how === 'new world epoch' ? 150 : 50, ON | BF_FIRING, g.a2 + 1);
      const E2 = how === 'new world epoch' ? nextEpoch() : E;
      drawAt(r, restored, { t: t + 0.016, dt: 0.016, world: E2 });
      expect(fx(scene, 'overlay/fx/tracer').length, 'tracers').toBe(0);
      expect(particles(scene, 'glow').length + particles(scene, 'smoke').length, 'particles (and no impacts for the vanished rows)').toBe(0);
      expect(fx(scene, 'overlay/fx/flash').length, 'the restored BF_FIRING is not a new shot').toBe(0);
      expect(diff([partInstances(scene, g.gunPart)[0]!], [restRef.gun]), 'recoil 0 and aim snapped to a2').toBeLessThan(1e-5);
      expect(spread(), 'doors snapped open').toBeCloseTo(restRef.open, 5);
      expect(restRef.open).toBeGreaterThan(shutSpread + 0.5);
      // the next snapshot firing again is a new shot
      drawAt(r, g.at(restored.tick + 1, ON | BF_FIRING, g.a2 + 1), { t: t + 0.03, dt: 0.014, world: E2 });
      expect(fx(scene, 'overlay/fx/flash').length).toBe(1);
    });
  }

  it('a reused id starts from rest: a new turret in a recoiling turret’s slot, a new gate in an open gate’s slot', () => {
    const w = new World(1, terrain, { waves: false });
    const alien = w.spawnAlien(A.rusher, 76.5, 50.5);
    const first = w.placeBuilding(B.gun, 66, 56, true);
    const E = nextEpoch();
    const fire = (id: number, tick: number, flags: number) => {
      const s = snapAt(w, tick);
      const row = rowIn(s.buildings, id);
      s.buildings.cols.flags[row] = flags;
      s.buildings.cols.target[row] = alien + 1;
      return s;
    };
    const kind = r.kitKinds.get(B.gun)!;
    const gunPart = `kit/${kind.placed.find((p) => p.pivot[0] === GUN && p.part.levels[0]!.size > 0)!.part.id}`;
    drawAt(r, fire(first, 10, ON), { t: 0, dt: 0, world: E });
    const rest = partInstances(scene, gunPart)[0]!;
    drawAt(r, fire(first, 11, ON | BF_FIRING), { t: 0.01, dt: 0.01, world: E });
    drawAt(r, fire(first, 11, ON | BF_FIRING), { t: 0.07, dt: 0.06, world: E });
    expect(diff([partInstances(scene, gunPart)[0]!], [rest])).toBeGreaterThan(0.05);
    // the turret dies; a new one is placed in the same slot (a new id): drawn at rest
    w.removeBuilding(slot(first));
    const second = w.placeBuilding(B.gun, 66, 56, true);
    expect(slot(second)).toBe(slot(first));
    expect(second).not.toBe(first);
    drawAt(r, fire(second, 12, ON), { t: 0.08, dt: 0.01, world: E });
    expect(diff([partInstances(scene, gunPart)[0]!], [rest]), 'new turret at rest').toBeLessThan(1e-5);
  });
});
