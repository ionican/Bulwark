// W24 run 2b, the post-build adversarial review (2026-10-09), finding 3 of 3.
//
// A commander's tracer started at a cached rig's muzzle even when that rig was not posed this frame
// (icon detail, after a load or while zoomed out). The rig's muzzle is used only when the rig was
// updated this frame; otherwise the origin comes from the unit's interpolated position.

import { describe, expect, it } from 'vitest';
import { A, P_BULLET, U } from '../src/sim/kinds.ts';
import { T_ALIEN, T_UNIT } from '../src/sim/schema.ts';
import { spawnProjectile } from '../src/sim/combat.ts';
import { World } from '../src/sim/world.ts';
import { ICON_LEVEL } from '../src/render/models.ts';
import { CommanderRig } from '../src/render/workshop/w23/rig/commander.ts';
import { drawAt, fx, nextEpoch, renderer, snapAt, terrain } from './w24r2b-fixtures.ts';

describe('finding 3: a commander tracer starts at the commander as drawn this frame', () => {
  /** A world with a commander at (x, z) and an alien 10 tiles north of it. */
  function scene3(x: number, z: number) {
    const w = new World(1, terrain, { waves: false });
    const cmd = w.spawnUnit(U.commander, x, z);
    const alien = w.spawnAlien(A.rusher, x, z - 10);
    return { w, cmd, alien };
  }
  /** Moves the commander (world state) and fires one bullet from it northwards, 0.6 tiles out. */
  function fireFrom(w: World, cmd: number, alien: number, x: number, z: number) {
    const s = w.units.slotForId(cmd);
    w.units.cols.x[s] = x;
    w.units.cols.z[s] = z;
    spawnProjectile(w, P_BULLET, x, z - 0.6, T_ALIEN, alien, x, z - 10, 1, 30, undefined, T_UNIT, U.commander, cmd);
  }
  /** The tail of the one tracer drawn (its instance translation: the streak starts there). */
  function tail(scene: Parameters<typeof fx>[0]): [number, number] {
    const t = fx(scene, 'overlay/fx/tracer');
    expect(t.length, 'one tracer drawn').toBe(1);
    return [t[0]![12]!, t[0]![14]!];
  }

  it('after a load at icon detail, the same commander id at a new position fires from there', () => {
    const { r, scene } = renderer();
    const { w, cmd, alien } = scene3(65.5, 64.5);
    // drawn at full detail: its rig is posed at (65.5, 64.5)
    drawAt(r, snapAt(w, 50), { t: 0, dt: 0, world: nextEpoch(), level: 0 });
    // a load: a new world epoch, the same id at (94.5, 94.5), drawn at icon detail, firing
    fireFrom(w, cmd, alien, 94.5, 94.5);
    drawAt(r, snapAt(w, 20), { t: 1, dt: 0, world: nextEpoch(), level: ICON_LEVEL });
    const [x, z] = tail(scene);
    expect(Math.hypot(x - 94.5, z - 94.5), `tracer tail at (${x.toFixed(2)}, ${z.toFixed(2)})`).toBeLessThan(1);
  });

  it('walking while zoomed out (icon detail), a new shot starts at the commander, not where it was last drawn in full', () => {
    const { r, scene } = renderer();
    const { w, cmd, alien } = scene3(65.5, 64.5);
    const E = nextEpoch();
    drawAt(r, snapAt(w, 50), { t: 0, dt: 0, world: E, level: 0 });
    // zoomed out: the commander walks 8 tiles east over 40 frames
    const s = w.units.slotForId(cmd);
    let t = 0;
    for (let k = 1; k <= 40; k++) {
      w.units.cols.x[s] = 65.5 + (8 * k) / 40;
      drawAt(r, snapAt(w, 50 + k), { t: (t += 0.05), dt: 0.05, world: E, level: ICON_LEVEL });
    }
    fireFrom(w, cmd, alien, 73.5, 64.5);
    drawAt(r, snapAt(w, 91), { t: (t += 0.05), dt: 0.05, world: E, level: ICON_LEVEL });
    const [x, z] = tail(scene);
    expect(Math.hypot(x - 73.5, z - 64.5), `tracer tail at (${x.toFixed(2)}, ${z.toFixed(2)})`).toBeLessThan(1);
  });

  it('drawn in full this frame, the tracer still starts at the rig muzzle', () => {
    const { r, scene } = renderer();
    const { w, cmd, alien } = scene3(65.5, 64.5);
    const E = nextEpoch();
    drawAt(r, snapAt(w, 50), { t: 0, dt: 0, world: E, level: 0 });
    fireFrom(w, cmd, alien, 65.5, 64.5);
    drawAt(r, snapAt(w, 51), { t: 0.05, dt: 0.05, world: E, level: 0 });
    const rig = r.rigOf(cmd);
    if (!(rig instanceof CommanderRig)) throw new Error('no commander rig');
    const [x, z] = tail(scene);
    expect(Math.hypot(x - rig.muzzle.x, z - rig.muzzle.z)).toBeLessThan(1e-3);
  });
});
