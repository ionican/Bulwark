// W25c finding 4 (Codex adversarial review, 9 Oct, medium): interpolation defeated the gait resets.
// Jump detection looked at the interpolated per-frame displacement, so a 5-tile teleport became
// small frame steps and the gait advanced; on rewind the feet were planted at the old world's
// position and then animated a 15-tile return.
// Required: discontinuities are found between snapshots, before interpolation — a jump of more
// than 2 tiles, the tick going backwards, a world replacement on load or rewind, a new entity id —
// and are not interpolated across: the entity snaps to the destination and the rig resets there.
// These tests drive the whole path: World → snapshot → Interpolator → ModelRenderer → rig.

import { describe, expect, it } from 'vitest';
import { A, U } from '../src/sim/kinds.ts';
import { slotOf } from '../src/sim/table.ts';
import { CAPACITY, World } from '../src/sim/world.ts';
import { decodeSnapshot, encodeSnapshot } from '../src/sim/snapshot.ts';
import { Interpolator } from '../src/render/interp.ts';
import { maxStepPerTick } from '../src/mobileStep.ts';
import { TU_SPEED, setTune } from '../src/sim/tuning.ts';
import { ENGINEER_LEGS } from '../src/render/workshop/w23/rig/specs.ts';
import { camera, renderer, terrain } from './w24r2a-fixtures.ts';

const { r } = renderer();
r.forcedLevel = 0;
r.cull = false;
const cam = camera({ x: 48, z: 92, distance: 40, yaw: 0 });
const FRAME = 1000 / 60;
const STEP = 0.25; // engineer walk per tick (5 m/s), tiles
const L = ENGINEER_LEGS.leg;

/** The interpolator under test, with the world epoch passed as main.ts passes the worker's (load, rewind). */
class Path {
  readonly interp: Interpolator;
  constructor(opts = {}) {
    this.interp = new Interpolator(CAPACITY, opts);
  }
  now = 0;
  /** Pushes a snapshot of `w` (`epoch`: the worker's world counter) and draws `frames` frames at 60 fps. */
  push(w: World, epoch = 0, frames = 6, each?: () => void): void {
    const snap = decodeSnapshot(encodeSnapshot(w));
    (this.interp.push as (s: typeof snap, now: number, epoch?: number) => unknown)(snap, this.now, epoch);
    for (let f = 0; f < frames; f++) {
      this.frame();
      each?.();
    }
  }
  frame(): void {
    this.interp.update(this.now);
    r.update({ camera: cam, viewportHeight: 900, yaw: 0, snapshot: this.interp.curr!, aliens: this.interp.aliens, units: this.interp.units, dt: FRAME / 1000 });
    this.now += FRAME;
  }
  /** Drawn (interpolated) position of unit or alien `id`. */
  at(group: 'units' | 'aliens', id: number): [number, number] {
    const v = this.interp[group];
    for (let k = 0; k < v.count; k++) if (v.id[k] === id) return [v.x[k]!, v.z[k]!];
    throw new Error(`no ${group} ${id}`);
  }
}

function walkingWorld() {
  const w = new World(1, terrain, { waves: false });
  const e = w.spawnUnit(U.engineer, 40.5, 90.5);
  const a = w.spawnAlien(A.rusher, 40.5, 96.5);
  return { w, e, a };
}
const unitSlot = (w: World, id: number) => w.units.slotForId(id);
const alienSlot = (w: World, id: number) => w.aliens.slotForId(id);
/** Moves the engineer (and the alien) one tick along +x, as the simulation would walk them. */
function walkTick(w: World, e: number, a: number) {
  w.tick++;
  w.units.cols.x[unitSlot(w, e)]! += STEP;
  w.aliens.cols.x[alienSlot(w, a)]! += STEP;
}
/** Feet planted under the body at (x, z): both in stance, within the foot offset, no leg stretched. */
function expectPlanted(id: number, x: number, z: number) {
  const rig = r.rigOf(id)!;
  rig.legs.feet.forEach((f, i) => {
    expect(f.stance, `foot ${i} planted`).toBe(true);
    expect(Math.hypot(f.pos.x - x, f.pos.z - z), `foot ${i} under the body at ${x.toFixed(2)}`).toBeLessThan(L.footOut + 1e-3);
    expect(rig.legs.hips[i]!.distanceTo(rig.legs.ankles[i]!)).toBeLessThan(L.thigh + L.shin);
  });
}

describe('W25c finding 4: discontinuities are found between snapshots, before interpolation', () => {
  it('a 5-tile teleport: the first frame after it draws the destination, the rig is reset there and does not walk', () => {
    const p = new Path();
    const { w, e, a } = walkingWorld();
    for (let t = 0; t < 20; t++) {
      walkTick(w, e, a);
      p.push(w);
    }
    const rig = r.rigOf(e)!;
    expect(rig.legs.phase).toBeGreaterThan(0.5); // it has been walking
    w.tick++;
    w.units.cols.x[unitSlot(w, e)]! += 5;
    w.aliens.cols.x[alienSlot(w, a)]! += 5;
    const dest = w.units.cols.x[unitSlot(w, e)]!;
    const z = w.units.cols.z[unitSlot(w, e)]!;
    const alienDest = w.aliens.cols.x[alienSlot(w, a)]!;
    const phases: number[] = [];
    const alienPhases: number[] = [];
    const xs: number[] = [];
    p.push(w, 0, 6, () => {
      phases.push(rig.legs.phase);
      alienPhases.push(r.alienTracks.phase[slotOf(a)]!);
      xs.push(p.at('units', e)[0]);
    });
    expect(xs[0]).toBeCloseTo(dest, 5);
    expect(xs.every((x) => Math.abs(x - dest) < 1e-5), `drawn x over the tick ${xs.map((x) => x.toFixed(2))}`).toBe(true);
    expect(phases, 'gait phase over the tick after the teleport').toEqual(phases.map(() => 0));
    expectPlanted(e, dest, z);
    expect(p.at('aliens', a)[0]).toBeCloseTo(alienDest, 5);
    const seedPhase = r.alienTracks.seed[slotOf(a)]! * Math.PI * 2;
    for (const ph of alienPhases) expect(ph).toBeCloseTo(seedPhase, 5);
  });

  it('a step under 2 tiles between snapshots is still interpolated and walked', () => {
    const p = new Path();
    const { w, e, a } = walkingWorld();
    p.push(w);
    walkTick(w, e, a);
    w.units.cols.x[unitSlot(w, e)]! += 1.5; // 1.75 tiles in one tick
    const xs: number[] = [];
    p.push(w, 0, 6, () => xs.push(p.at('units', e)[0]));
    expect(xs[0]).toBeCloseTo(40.5, 5); // alpha 0: the previous snapshot's position
    expect(xs[5]!).toBeGreaterThan(41.5);
  });

  it('fast but legitimate walking (sandbox speed × 10: 2.5 tiles a tick) is interpolated and walked, with main.ts’s step limit', () => {
    const p = new Path({ maxStepPerTick });
    const { w, e, a } = walkingWorld();
    setTune(w, 'unit', U.engineer, TU_SPEED, 10);
    p.push(w);
    const rig = r.rigOf(e)!;
    const xs: number[] = [];
    for (let t = 0; t < 4; t++) {
      walkTick(w, e, a);
      w.units.cols.x[unitSlot(w, e)]! += 2.25; // 2.5 tiles a tick in all
      p.push(w, 0, 6, () => xs.push(p.at('units', e)[0]));
    }
    // every frame moves on by about 2.5 / 6 tiles: no frame stands still at a snapshot position
    for (let k = 1; k < xs.length; k++) expect(xs[k]! - xs[k - 1]!, `frame ${k}`).toBeGreaterThan(0.3);
    expect(rig.legs.phase).toBeGreaterThan(1);
  });

  it('rewind (the tick goes backwards, 15 tiles away): drawn at the rewound position at once, feet planted there, no walk back', () => {
    const p = new Path();
    const { w, e, a } = walkingWorld();
    w.tick = 500;
    w.units.cols.x[unitSlot(w, e)] = 55.5;
    for (let t = 0; t < 10; t++) {
      walkTick(w, e, a);
      p.push(w, 0);
    }
    const back = walkingWorld(); // the checkpoint: same ids, at x 40.5, tick 300
    back.w.tick = 300;
    expect(back.e).toBe(e);
    const rig = r.rigOf(e)!;
    const phases: number[] = [];
    const xs: number[] = [];
    p.push(back.w, 1, 6, () => {
      phases.push(rig.legs.phase);
      xs.push(p.at('units', e)[0]);
    });
    expect(xs[0]).toBeCloseTo(40.5, 5);
    expect(xs.every((x) => Math.abs(x - 40.5) < 1e-5), `drawn x ${xs.map((x) => x.toFixed(2))}`).toBe(true);
    expect(phases).toEqual(phases.map(() => 0));
    expectPlanted(e, 40.5, 90.5);
  });

  it('a load with the tick going forward and a small move (the world replaced): not interpolated across, reset there', () => {
    const p = new Path();
    const { w, e, a } = walkingWorld();
    for (let t = 0; t < 20; t++) {
      walkTick(w, e, a);
      p.push(w, 0);
    }
    const loaded = walkingWorld();
    loaded.w.tick = w.tick + 400;
    const lx = w.units.cols.x[unitSlot(w, e)]! - 1.2; // under 2 tiles from where it was drawn
    loaded.w.units.cols.x[unitSlot(loaded.w, e)] = lx;
    const rig = r.rigOf(e)!;
    const xs: number[] = [];
    const phases: number[] = [];
    p.push(loaded.w, 2, 6, () => {
      xs.push(p.at('units', e)[0]);
      phases.push(rig.legs.phase);
    });
    expect(xs[0]).toBeCloseTo(lx, 5);
    expect(phases).toEqual(phases.map(() => 0));
    expectPlanted(e, lx, 90.5);
  });

  it('a new entity id in the same slot is never interpolated from the old one', () => {
    const p = new Path();
    const { w, e, a } = walkingWorld();
    p.push(w);
    w.tick++;
    w.units.remove(unitSlot(w, e)); // the unit is gone; the next one created takes its slot
    const e2 = w.spawnUnit(U.engineer, 41.5, 91.5);
    expect(slotOf(e2)).toBe(slotOf(e));
    expect(e2).not.toBe(e);
    const xs: number[] = [];
    p.push(w, 0, 3, () => xs.push(p.at('units', e2)[0]));
    expect(xs[0]).toBeCloseTo(41.5, 5);
    expectPlanted(e2, 41.5, 91.5);
    void a;
  });
});
