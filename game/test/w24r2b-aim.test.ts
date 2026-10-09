// W24 run 2b, criterion 3: turret aim. With a target moving across a turret, every moving pivot the
// W22 kit defines has its intended transform at the target's interpolated position — the yaw
// pivot points at it within 1°, the pitch matches the game's flat-trajectory formula within 1°
// (flat line from the trunnion to the target's aim height; no ballistic arc), the pinion turns
// with the yaw by its gear ratio — and static parts do not move. Read from the drawn batches.

import { describe, expect, it } from 'vitest';
import { A, B, BUILDING_KINDS } from '../src/sim/kinds.ts';
import { BF_COMPLETE, BF_STARTED } from '../src/sim/schema.ts';
import { World } from '../src/sim/world.ts';
import { footprintRange, groundHeight } from '../src/render/ground.ts';
import { ALIEN_AIM_HEIGHT, flatPitch } from '../src/render/anim.ts';
import { TURRET_KINDS, TURRET_SCALE } from '../src/render/models.ts';
import { GUN, PINION, PINION0, PITCH, STATIC, YAW } from '../src/render/workshop/kit/kit.ts';
import { drawAt, mobile, nextEpoch, partInstances, renderer, rowIn, snapAt, terrain } from './w24r2b-fixtures.ts';

const { r, scene } = renderer();
const DEG = Math.PI / 180;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

describe('criterion 3: aim at the interpolated target', () => {
  it('the flat-trajectory pitch is the angle of the straight line from the trunnion to the aim point', () => {
    expect(flatPitch(10, 0, 0)).toBeCloseTo(0, 9);
    expect(flatPitch(10, 10, 0)).toBeCloseTo(Math.PI / 4, 9);
    expect(flatPitch(3, -4, 4)).toBeCloseTo(Math.atan2(-4, 5), 9);
  });

  for (const [game, id] of TURRET_KINDS) {
    it(`${id} (${BUILDING_KINDS[game]}): yaw, pitch and pinion follow a target moving across; static parts stay`, () => {
      const w = new World(1, terrain, { waves: false });
      const [tx, ty] = game === B.heavy ? [74, 56] : [66, 56];
      const t = w.placeBuilding(game, tx, ty, true);
      if (t < 0) throw new Error('place');
      const alien = w.spawnAlien(A.breaker, 60.5, 46.5);
      const s = snapAt(w, 10);
      const row = rowIn(s.buildings, t);
      s.buildings.cols.flags[row] = BF_COMPLETE | BF_STARTED;
      s.buildings.cols.target[row] = alien + 1;
      const fw = s.buildings.cols.fw[row]!;
      const cx = tx + fw / 2;
      const cz = ty + fw / 2;
      const top = footprintRange(terrain, tx, ty, fw, fw).top;
      const kind = r.kitKinds.get(game)!;
      const sc = TURRET_SCALE.get(game) ?? 1;
      const E = nextEpoch();
      const aliens = mobile(s.aliens);
      const ar = rowIn(s.aliens, alien);
      const xs = new Float32Array(aliens.x);
      const zs = new Float32Array(aliens.z);
      const view = { ...aliens, x: xs, z: zs };
      let statics: Map<string, Float32Array> | null = null;
      // the target walks west → east across the turret's north side (interpolated positions)
      for (let k = 0; k <= 8; k++) {
        xs[ar] = cx - 9 + k * 2.25;
        zs[ar] = cz - 7 + Math.abs(k - 4) * 0.6;
        drawAt(r, s, { t: k * 0.05, dt: k ? 0.05 : 0, world: E, aliens: view });
        const ax = xs[ar]!;
        const az = zs[ar]!;
        const wantYaw = Math.atan2(-(az - cz), ax - cx);
        const aimY = groundHeight(terrain, ax, az) + ALIEN_AIM_HEIGHT[A.breaker]!;
        const wantPitch = flatPitch(Math.hypot(ax - cx, az - cz), aimY - (top + kind.frame.trunnionY * sc), 0);
        const now = new Map<string, Float32Array>();
        for (const pl of kind.placed) {
          if (pl.part.levels[0]!.size === 0) continue;
          const inst = partInstances(scene, `kit/${pl.part.id}`, 0);
          expect(inst.length, pl.part.id).toBe(1);
          const m = inst[0]!;
          now.set(pl.part.id, m);
          const piv = pl.pivot[0]!;
          const c0 = Math.hypot(m[0]!, m[1]!, m[2]!);
          if (piv === YAW) {
            expect(Math.abs(wrap(Math.atan2(-m[2]!, m[0]!) - wantYaw)), `${pl.part.id} yaw, step ${k}`).toBeLessThan(1 * DEG);
            expect(Math.abs(m[1]! / c0), `${pl.part.id} has no pitch`).toBeLessThan(1e-4);
          } else if (piv === PITCH || piv === GUN) {
            expect(Math.abs(wrap(Math.atan2(-m[2]!, m[0]!) - wantYaw)), `${pl.part.id} yaw, step ${k}`).toBeLessThan(1 * DEG);
            expect(Math.abs(Math.asin(m[1]! / c0) - wantPitch), `${pl.part.id} pitch, step ${k}`).toBeLessThan(1 * DEG);
          } else if (piv === PINION) {
            const want = wrap(-wantYaw * kind.frame.pinionRatio);
            expect(Math.abs(wrap(Math.atan2(-m[2]!, m[0]!) - want)), `${pl.part.id} pinion, step ${k}`).toBeLessThan(1 * DEG);
          }
        }
        // static parts (and the pinion's resting pivot below full detail) never move
        if (!statics) statics = now;
        for (const pl of kind.placed) {
          if (pl.part.levels[0]!.size === 0 || (pl.pivot[0] !== STATIC && pl.pivot[0] !== PINION0)) continue;
          const a = statics.get(pl.part.id)!;
          const b = now.get(pl.part.id)!;
          expect(Math.max(...a.map((v, i) => Math.abs(v - b[i]!))), `${pl.part.id} static, step ${k}`).toBe(0);
        }
      }
    });
  }

  it('no target: the aim holds, then eases back to rest (yaw π/2, pitch 0): held 1 s, eased over 2 s', () => {
    const w = new World(1, terrain, { waves: false });
    const t = w.placeBuilding(B.gun, 66, 56, true);
    const alien = w.spawnAlien(A.rusher, 76.5, 57.5);
    const s = snapAt(w, 10);
    const row = rowIn(s.buildings, t);
    s.buildings.cols.target[row] = alien + 1;
    const kind = r.kitKinds.get(B.gun)!;
    const gunPart = kind.placed.find((p) => p.pivot[0] === GUN)!.part.id;
    const yawOf = () => {
      const m = partInstances(scene, `kit/${gunPart}`, 0)[0]!;
      return Math.atan2(-m[2]!, m[0]!);
    };
    const E = nextEpoch();
    drawAt(r, s, { t: 0, dt: 0, world: E });
    const aimed = yawOf();
    expect(Math.abs(wrap(aimed - Math.atan2(-(57.5 - 57), 76.5 - 67)))).toBeLessThan(1 * DEG);
    const s2 = snapAt(w, 11);
    s2.buildings.cols.target[rowIn(s2.buildings, t)] = 0;
    drawAt(r, s2, { t: 0.2, dt: 0.2, world: E });
    expect(Math.abs(wrap(yawOf() - aimed)), 'held').toBeLessThan(1 * DEG);
    let tt = 0.2;
    for (let k = 0; k < 33; k++) drawAt(r, s2, { t: (tt += 0.1), dt: 0.1, world: E });
    expect(Math.abs(wrap(yawOf() - Math.PI / 2)), 'at rest 3.3 s after the target went').toBeLessThan(1 * DEG);
  });
});
