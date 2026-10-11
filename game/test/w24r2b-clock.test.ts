// W24 run 2b, criterion 5: the effect clock (render/anim.ts EffectClock). Each frame it advances by
// the real frame time × the runner's speed, by 0 while paused, clamped to 100 ms; a world reset
// (a new world epoch, or the tick going backwards) restarts it with a zero delta. Paused for 2 s,
// every effect transform in the scene is unchanged frame to frame; at 3× the doors travel in a
// third of the frames.

import { describe, expect, it } from 'vitest';
import { A, B, P_BULLET, U } from '../src/sim/kinds.ts';
import { BF_ACTIVE, BF_COMPLETE, BF_FIRING, BF_STARTED, T_BUILDING, US_BUILDING } from '../src/sim/schema.ts';
import { World } from '../src/sim/world.ts';
import { EffectClock } from '../src/render/anim.ts';
import { diff, drawAt, everything, nextEpoch, partInstances, particles, renderer, rowIn, slot, snapAt, terrain } from './w24r2b-fixtures.ts';

const { r, scene } = renderer();

describe('criterion 5: the effect clock', () => {
  it('advances by frame time × speed, 0 when paused, at most 100 ms a frame', () => {
    const c = new EffectClock();
    c.advance(1 / 60, 1, false, 10, 0);
    expect(c.dt).toBeCloseTo(1 / 60, 9);
    c.advance(1 / 60, 3, false, 11, 0);
    expect(c.dt).toBeCloseTo(3 / 60, 9);
    const t = c.t;
    c.advance(1 / 60, 3, true, 11, 0);
    expect(c.dt).toBe(0);
    expect(c.t).toBe(t);
    c.advance(0.5, 1, false, 12, 0);
    expect(c.dt).toBeCloseTo(0.1, 9);
    c.advance(0.05, 10, false, 13, 0);
    expect(c.dt).toBeCloseTo(0.1, 9);
    expect(c.t).toBeCloseTo(t + 0.2, 9);
  });

  it('a world reset restarts it with a zero delta: a new world epoch, or the tick going backwards', () => {
    const c = new EffectClock();
    c.advance(1 / 60, 1, false, 100, 0);
    c.advance(1 / 60, 1, false, 101, 0);
    expect(c.reset).toBe(false);
    c.advance(1 / 60, 1, false, 101, 1);
    expect(c.reset).toBe(true);
    expect(c.dt).toBe(0);
    c.advance(1 / 60, 1, false, 102, 1);
    expect(c.reset).toBe(false);
    expect(c.dt).toBeCloseTo(1 / 60, 9);
    c.advance(1 / 60, 1, false, 50, 1);
    expect(c.reset).toBe(true);
    expect(c.dt).toBe(0);
    // repeated snapshots of the same tick (paused, or the worker waiting) are not a reset
    c.advance(1 / 60, 1, false, 50, 1);
    expect(c.reset).toBe(false);
  });

  /** A scene with every animation on: a firing turret mid-recoil, an opening gate, a running extractor, generator and assembler, a builder beaming, a shot. */
  function busy() {
    const w = new World(1, terrain, { waves: false });
    const gun = w.placeBuilding(B.gun, 66, 56, true);
    const gate = w.placeBuilding(B.gate, 72, 66, true, 0, 3, 2);
    w.placeBuilding(B.massExtractor, 54, 50, true);
    w.placeBuilding(B.generator, 40, 44, true);
    const asm = w.placeBuilding(B.assembler, 82, 44, true);
    const site = w.placeBuilding(B.wall, 40, 70, false);
    const eng = w.spawnUnit(U.engineer, 73.5, 69.0);
    w.units.cols.state[slot(eng)] = US_BUILDING;
    w.units.cols.work[slot(eng)] = site + 1;
    const alien = w.spawnAlien(A.rusher, 76.5, 50.5);
    const p = w.projectiles.create();
    w.projectiles.cols.kind[slot(p)] = P_BULLET;
    w.projectiles.cols.x[slot(p)] = 70;
    w.projectiles.cols.z[slot(p)] = 53;
    w.projectiles.cols.fz[slot(p)] = -1;
    w.projectiles.cols.srcType[slot(p)] = T_BUILDING;
    w.projectiles.cols.srcId[slot(p)] = gun;
    const at = (tick: number, work: number) => {
      const s = snapAt(w, tick);
      const g = rowIn(s.buildings, gun);
      s.buildings.cols.flags[g] = BF_COMPLETE | BF_STARTED | BF_FIRING;
      s.buildings.cols.target[g] = alien + 1;
      const a = rowIn(s.buildings, asm);
      s.buildings.cols.flags[a] = BF_COMPLETE | BF_STARTED | BF_ACTIVE;
      s.buildings.cols.work[a] = work;
      return s;
    };
    void gate;
    return { w, at, eng, put: (x: number, z: number) => ((w.units.cols.x[slot(eng)] = x), (w.units.cols.z[slot(eng)] = z)) };
  }

  it('paused for 2 s: every transform in the scene (models, effects, particles) is unchanged frame to frame', () => {
    const b = busy();
    const E = nextEpoch();
    const c = new EffectClock();
    const frame = (s: ReturnType<typeof b.at>, paused: boolean) => {
      c.advance(1 / 60, 1, paused, s.tick, E);
      drawAt(r, s, { t: c.t, dt: c.dt, world: E });
    };
    frame(b.at(10, 0.2), false);
    const s = b.at(11, 0.3);
    for (let k = 0; k < 8; k++) frame(s, false); // mid-recoil, doors moving, beams pulsing
    let prev = everything(scene);
    let prevP = JSON.stringify([particles(scene, 'smoke'), particles(scene, 'glow')]);
    expect(prev.length).toBeGreaterThan(100);
    for (let k = 0; k < 120; k++) {
      frame(s, true);
      const now = everything(scene);
      const nowP = JSON.stringify([particles(scene, 'smoke'), particles(scene, 'glow')]);
      expect(diff(prev, now), `paused frame ${k}`).toBe(0);
      expect(nowP, `paused frame ${k}: particles`).toBe(prevP);
      prev = now;
      prevP = nowP;
    }
    // resumed: things move again
    frame(s, false);
    frame(s, false);
    expect(diff(prev, everything(scene))).toBeGreaterThan(0);
  });

  it('at 3× the doors open in a third of the frames', () => {
    const framesToOpen = (speed: number) => {
      const b = busy();
      b.put(95.5, 90.5);
      const E = nextEpoch();
      const c = new EffectClock();
      let tick = 10;
      c.advance(1 / 60, speed, false, tick, E);
      drawAt(r, b.at(tick, 0.2), { t: c.t, dt: c.dt, world: E });
      const spread = () => {
        const l = partInstances(scene, 'gate/leaf');
        return Math.max(...l.map((m) => m[12]!)) - Math.min(...l.map((m) => m[12]!));
      };
      const shut = spread();
      b.put(73.5, 69.0);
      const s = b.at(++tick, 0.2);
      let open = -1;
      let last = shut;
      for (let k = 1; k <= 400; k++) {
        c.advance(1 / 60, speed, false, s.tick, E);
        drawAt(r, s, { t: c.t, dt: c.dt, world: E });
        const now = spread();
        if (k > 2 && Math.abs(now - last) < 1e-6 && now > shut + 0.5) {
          open = k;
          break;
        }
        last = now;
      }
      return open;
    };
    const one = framesToOpen(1);
    const three = framesToOpen(3);
    expect(one).toBeGreaterThan(30);
    expect(three).toBeGreaterThan(0);
    expect(Math.abs(one / three - 3), `${one} frames at 1×, ${three} at 3×`).toBeLessThan(0.35);
  });
});
