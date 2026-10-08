// W24 run 2a, Richard's feedback (item 6, from run 2b): units walk with W23's gait and planted
// feet, aliens with W21's gait phase, both driven by the distance moved between frames; a jump of
// more than 2 tiles, a tick going backwards or a new id resets; a stationary entity does not advance.

import { describe, expect, it } from 'vitest';
import { A, U } from '../src/sim/kinds.ts';
import { slotOf } from '../src/sim/table.ts';
import { World } from '../src/sim/world.ts';
import type { Snapshot } from '../src/sim/snapshot.ts';
import { groundHeight } from '../src/render/ground.ts';
import type { MobileView } from '../src/render/interp.ts';
import { ALIEN_PHASE_PER_TILE, RESET_JUMP } from '../src/render/walk.ts';
import { ENGINEER_LEGS, ENGINEER_WALK } from '../src/render/workshop/w23/rig/specs.ts';
import { camera, renderer, snapshotOf, terrain } from './w24r2a-fixtures.ts';

const { r } = renderer();
r.forcedLevel = 0;
r.cull = false;
const cam = camera();
const DT = 1 / 60;

interface Scene {
  s: Snapshot;
  units: MobileView;
  aliens: MobileView;
  engineer: number;
  rusher: number;
  breaker: number;
}

function scene(): Scene {
  const w = new World(1, terrain, { waves: false });
  const engineer = w.spawnUnit(U.engineer, 40.5, 90.5);
  const rusher = w.spawnAlien(A.rusher, 40.5, 96.5);
  const breaker = w.spawnAlien(A.breaker, 40.5, 102.5);
  const s = snapshotOf(w);
  const copy = (sec: Snapshot['units'] | Snapshot['aliens']): MobileView => ({
    count: sec.count,
    id: sec.id,
    kind: sec.cols.kind,
    x: Float32Array.from(sec.cols.x),
    z: Float32Array.from(sec.cols.z),
    fx: Float32Array.from({ length: sec.count }, () => 1),
    fz: new Float32Array(sec.count),
  });
  return { s, units: copy(s.units), aliens: copy(s.aliens), engineer, rusher, breaker };
}

let tick = 0;
/** One frame; a new scene starts at a lower tick than the last test's, which resets the tracks. */
function frame(sc: Scene, dt = DT, t = ++tick): void {
  sc.s.tick = t;
  r.update({ camera: cam, viewportHeight: 900, yaw: 0, snapshot: sc.s, aliens: sc.aliens, units: sc.units, dt });
}

function start(): Scene {
  const sc = scene();
  tick = 0;
  frame(sc, DT, 0);
  return sc;
}

describe('walking from snapshots', () => {
  it('a unit walked 10 tiles in a straight line advances its gait in proportion to the distance', () => {
    const sc = start();
    const rig = r.rigOf(sc.engineer)!;
    const p0 = rig.legs.phase;
    const step = ENGINEER_WALK * DT;
    let phase5 = 0;
    for (let k = 1; k * step <= 10 + 1e-9; k++) {
      sc.units.x[0] = 40.5 + k * step;
      frame(sc);
      if (phase5 === 0 && k * step >= 5) phase5 = rig.legs.phase - p0;
    }
    const phase10 = rig.legs.phase - p0;
    const stride = ENGINEER_LEGS.walk.stride;
    expect(phase10).toBeGreaterThan(10 / stride * 0.97);
    expect(phase10).toBeLessThan(10 / stride * 1.03);
    expect(phase10 / phase5).toBeCloseTo(2, 1);
    expect(rig.action).toBe('walk');
  });

  it('a planted foot stays on its touchdown point (within 1e-3 tiles) on the sampled ground while it is down', () => {
    const sc = start();
    const rig = r.rigOf(sc.engineer)!;
    const step = ENGINEER_WALK * DT;
    const plant: Array<{ x: number; y: number; z: number } | null> = [null, null];
    let checked = 0;
    let stances = 0;
    for (let k = 1; k <= 600; k++) {
      sc.units.x[0] = 40.5 + k * step;
      sc.units.z[0] = 90.5 + k * step * 0.3;
      frame(sc);
      rig.legs.feet.forEach((f, i) => {
        if (!f.stance) {
          plant[i] = null;
          return;
        }
        const a = rig.legs.ankles[i]!;
        if (!plant[i]) {
          plant[i] = { x: a.x, y: a.y, z: a.z };
          stances++;
          expect(Math.abs(f.pos.y - groundHeight(terrain, f.pos.x, f.pos.z))).toBeLessThan(1e-4);
          return;
        }
        const p = plant[i]!;
        expect(Math.hypot(a.x - p.x, a.y - p.y, a.z - p.z)).toBeLessThan(1e-3);
        checked++;
      });
    }
    expect(stances).toBeGreaterThan(10);
    expect(checked).toBeGreaterThan(300);
  });

  it(`a 5-tile teleport (more than ${RESET_JUMP}) resets the gait: feet planted under the body, no stretched leg`, () => {
    const sc = start();
    const rig = r.rigOf(sc.engineer)!;
    const step = ENGINEER_WALK * DT;
    // walk until a foot is in the air (mid-stride)
    for (let k = 1; k <= 300 && rig.legs.feet.every((f) => f.stance); k++) {
      sc.units.x[0] = 40.5 + k * step;
      frame(sc);
    }
    expect(rig.legs.feet.some((f) => !f.stance)).toBe(true);
    sc.units.x[0] += 5;
    frame(sc);
    const L = ENGINEER_LEGS.leg;
    expect(rig.legs.phase).toBe(0);
    rig.legs.feet.forEach((f, i) => {
      expect(f.stance).toBe(true);
      expect(Math.hypot(f.pos.x - sc.units.x[0]!, f.pos.z - sc.units.z[0]!)).toBeLessThan(L.footOut + 1e-6);
      expect(rig.legs.hips[i]!.distanceTo(rig.legs.ankles[i]!)).toBeLessThan(L.thigh + L.shin);
    });
  });

  it('a stationary unit does not advance; nor does a paused one (dt 0)', () => {
    const sc = start();
    const rig = r.rigOf(sc.engineer)!;
    for (let k = 0; k < 30; k++) frame(sc);
    const p = rig.legs.phase;
    for (let k = 0; k < 120; k++) frame(sc);
    expect(rig.legs.phase).toBe(p);
    expect(rig.action).toBe('idle');
    for (let k = 0; k < 60; k++) frame(sc, 0);
    expect(rig.legs.phase).toBe(p);
  });

  it('aliens: the phase advances by distance × the kind’s rate, not at all when stationary, and resets on a jump', () => {
    const sc = start();
    const T = r.alienTracks;
    const rs = slotOf(sc.rusher);
    const bs = slotOf(sc.breaker);
    const p0 = [T.phase[rs]!, T.phase[bs]!];
    expect(p0[0]).toBeCloseTo(T.seed[rs]! * Math.PI * 2, 5);
    for (let k = 1; k <= 100; k++) {
      sc.aliens.x[0] = 40.5 + k * 0.1;
      sc.aliens.x[1] = 40.5 + k * 0.05;
      frame(sc);
    }
    expect(T.phase[rs]! - p0[0]!).toBeCloseTo(10 * ALIEN_PHASE_PER_TILE[A.rusher]!, 2);
    expect(T.phase[bs]! - p0[1]!).toBeCloseTo(5 * ALIEN_PHASE_PER_TILE[A.breaker]!, 2);
    expect(T.heading[rs]).toBeCloseTo(0, 5);
    const p1 = T.phase[rs]!;
    for (let k = 0; k < 60; k++) frame(sc);
    expect(T.phase[rs]).toBe(p1);
    sc.aliens.x[0] += 5;
    frame(sc);
    expect(T.phase[rs]).toBeCloseTo(T.seed[rs]! * Math.PI * 2, 5);
  });

  it('the snapshot tick going backwards (rewind, load) resets every gait', () => {
    const sc = start();
    const rig = r.rigOf(sc.engineer)!;
    for (let k = 1; k <= 60; k++) {
      sc.units.x[0] = 40.5 + k * ENGINEER_WALK * DT;
      frame(sc);
    }
    expect(rig.legs.phase).toBeGreaterThan(0);
    frame(sc, DT, 3);
    expect(rig.legs.phase).toBe(0);
  });
});
