// W24 run 2b, criterion 2: the animation input matrix (render/anim.ts). For each row a fixture
// snapshot turns the animation on and another turns it off, and while it is on the animated
// transforms change as the effect clock advances — read from the scene graph (instance matrices of
// the drawn batches, the effect meshes and the W21 particle buffers), never from a renderer report.
// Presence alone would pass on the 2a renderer's static models; every "on" case here also asserts
// motion over effect-clock time.

import { describe, expect, it } from 'vitest';
import { A, B, P_ALIEN, P_BULLET, P_SHELL, U } from '../src/sim/kinds.ts';
import { BF_ACTIVE, BF_COMPLETE, BF_FIRING, BF_STARTED, BF_STARVED, T_BUILDING, US_BUILDING, US_IDLE, US_RECLAIMING } from '../src/sim/schema.ts';
import { World } from '../src/sim/world.ts';
import { Interpolator } from '../src/render/interp.ts';
import { CAPACITY } from '../src/sim/world.ts';
import { diff, drawAt, fx, mobile, mobileP, modelInstances, near, nextEpoch, partInstances, particles, renderer, rowIn, slot, snapAt, terrain } from './w24r2b-fixtures.ts';

const { r, scene } = renderer();

/** Ground distance from a matrix's translation to (x, z). */
const dist = (m: Float32Array, x: number, z: number) => Math.hypot(m[12]! - x, m[14]! - z);
/** End of a beam instance (geometry from x = 0 to 1 along the instance's x axis). */
const beamEnd = (m: Float32Array): [number, number] => [m[12]! + m[0]!, m[14]! + m[2]!];

function builderWorld(state: number, workOf: 'site' | 'wreck' | 'absent') {
  const w = new World(1, terrain, { waves: false });
  const site = w.placeBuilding(B.wall, 40, 70, false);
  w.addWreck(A.breaker, 46.5, 72.5, 20);
  const eng = w.spawnUnit(U.engineer, 43.5, 70.5);
  const c = w.units.cols;
  c.state[slot(eng)] = state;
  let work = 60000 + 1; // 'absent': an id in no table
  if (workOf === 'site') work = site + 1;
  else if (workOf === 'wreck') work = snapAt(w, 1).wrecks.id[0]! + 1;
  c.work[slot(eng)] = work;
  return { w, site, eng };
}

describe('build beam (commander, engineer): US_BUILDING and work − 1 present', () => {
  it('on: one beam from the engineer to its site, with pulses that travel towards the site as the clock advances', () => {
    const { w, eng } = builderWorld(US_BUILDING, 'site');
    const s = snapAt(w, 10);
    const E = nextEpoch();
    drawAt(r, s, { t: 0, dt: 0, world: E });
    drawAt(r, s, { t: 0.1, dt: 0.1, world: E });
    const beams = fx(scene, 'overlay/fx/build-beam');
    expect(beams.length).toBe(1);
    const ur = rowIn(s.units, eng);
    expect(dist(beams[0]!, s.units.cols.x[ur]!, s.units.cols.z[ur]!)).toBeLessThan(1.2);
    const [ex, ez] = beamEnd(beams[0]!);
    expect(Math.hypot(ex - 40.5, ez - 70.5)).toBeLessThan(0.8);
    const p0 = fx(scene, 'overlay/fx/build-pulse');
    drawAt(r, s, { t: 0.13, dt: 0.03, world: E });
    const p1 = fx(scene, 'overlay/fx/build-pulse');
    expect(p0.length).toBeGreaterThan(0);
    expect(diff(p0, p1)).toBeGreaterThan(1e-3);
    // towards the site: most pulses got closer to it
    const closer = p0.filter((m, i) => dist(p1[i]!, 40.5, 70.5) < dist(m, 40.5, 70.5)).length;
    expect(closer).toBeGreaterThan(p0.length / 2);
  });

  it('off: idle, or building an id that is not in the snapshot: no beam', () => {
    for (const [state, work] of [
      [US_IDLE, 'site'],
      [US_BUILDING, 'absent'],
    ] as const) {
      const { w } = builderWorld(state, work);
      const s = snapAt(w, 10);
      const E = nextEpoch();
      drawAt(r, s, { t: 0, dt: 0, world: E });
      drawAt(r, s, { t: 0.2, dt: 0.2, world: E });
      expect(fx(scene, 'overlay/fx/build-beam').length, `state ${state}, work ${work}`).toBe(0);
      expect(fx(scene, 'overlay/fx/build-pulse').length, `state ${state}, work ${work}`).toBe(0);
      expect(fx(scene, 'overlay/fx/reclaim-beam').length).toBe(0);
    }
  });
});

describe('reclaim beam: US_RECLAIMING and work − 1 = a wreck present; reverse direction, distinct pulses', () => {
  it('on: the beam runs wreck → engineer, and its pulses travel towards the engineer', () => {
    const { w, eng } = builderWorld(US_RECLAIMING, 'wreck');
    const s = snapAt(w, 10);
    const E = nextEpoch();
    drawAt(r, s, { t: 0, dt: 0, world: E });
    drawAt(r, s, { t: 0.1, dt: 0.1, world: E });
    const beams = fx(scene, 'overlay/fx/reclaim-beam');
    expect(beams.length).toBe(1);
    expect(fx(scene, 'overlay/fx/build-beam').length).toBe(0);
    const ur = rowIn(s.units, eng);
    const ux = s.units.cols.x[ur]!;
    const uz = s.units.cols.z[ur]!;
    expect(dist(beams[0]!, 46.5, 72.5)).toBeLessThan(0.8);
    const [ex, ez] = beamEnd(beams[0]!);
    expect(Math.hypot(ex - ux, ez - uz)).toBeLessThan(1.2);
    const p0 = fx(scene, 'overlay/fx/reclaim-pulse');
    drawAt(r, s, { t: 0.13, dt: 0.03, world: E });
    const p1 = fx(scene, 'overlay/fx/reclaim-pulse');
    expect(p0.length).toBeGreaterThan(0);
    expect(diff(p0, p1)).toBeGreaterThan(1e-3);
    const closer = p0.filter((m, i) => dist(p1[i]!, ux, uz) < dist(m, ux, uz)).length;
    expect(closer).toBeGreaterThan(p0.length / 2);
  });

  it('off: a reclaiming engineer whose wreck id is absent draws no beam', () => {
    const { w } = builderWorld(US_RECLAIMING, 'absent');
    const s = snapAt(w, 10);
    const E = nextEpoch();
    drawAt(r, s, { t: 0, dt: 0, world: E });
    drawAt(r, s, { t: 0.2, dt: 0.2, world: E });
    expect(fx(scene, 'overlay/fx/reclaim-beam').length).toBe(0);
    expect(fx(scene, 'overlay/fx/reclaim-pulse').length).toBe(0);
  });
});

describe('carry pod (engineer): carry > 0, on the back, sized by load', () => {
  const pod = (carry: number, t: number, E: number) => {
    const w = new World(1, terrain, { waves: false });
    const eng = w.spawnUnit(U.engineer, 60.5, 80.5);
    w.units.cols.carry[slot(eng)] = carry;
    const s = snapAt(w, 10);
    drawAt(r, s, { t, dt: t === 0 ? 0 : 0.4, world: E });
    return { s, eng, box: partInstances(scene, 'eng/box') };
  };

  it('on: the pod is drawn behind the engineer, larger with a larger load, and sways as the clock advances', () => {
    const E = nextEpoch();
    const a = pod(10, 0, E);
    expect(a.box.length).toBe(1);
    const row = rowIn(a.s.units, a.eng);
    const fxv = a.s.units.cols.fx[row]!;
    const fzv = a.s.units.cols.fz[row]!;
    const m = a.box[0]!;
    const back = (m[12]! - a.s.units.cols.x[row]!) * fxv + (m[14]! - a.s.units.cols.z[row]!) * fzv;
    expect(back, 'pod centre behind the engineer along its facing').toBeLessThan(0);
    const b = pod(10, 0.4, E);
    expect(diff(a.box, b.box)).toBeGreaterThan(1e-4);
    const E2 = nextEpoch();
    const small = pod(4, 0, E2).box[0]!;
    const E3 = nextEpoch();
    const big = pod(20, 0, E3).box[0]!;
    const len = (q: Float32Array) => Math.hypot(q[0]!, q[1]!, q[2]!);
    expect(len(big)).toBeGreaterThan(len(small) * 1.2);
  });

  it('off: carry 0 draws no pod', () => {
    expect(pod(0, 0, nextEpoch()).box.length).toBe(0);
  });
});

/** One building of `kind` with its snapshot flags (and work) set. */
function oneBuilding(kind: number, tx: number, ty: number) {
  const w = new World(1, terrain, { waves: false });
  const id = w.placeBuilding(kind, tx, ty, true);
  if (id < 0) throw new Error(`cannot place ${kind} at ${tx},${ty}`);
  const at = (tick: number, flags: number, work = 0, progress = 1) => {
    const s = snapAt(w, tick);
    const row = rowIn(s.buildings, id);
    s.buildings.cols.flags[row] = flags;
    s.buildings.cols.work[row] = work;
    s.buildings.cols.progress[row] = progress;
    return s;
  };
  return { w, id, at };
}

describe('extractors: running by BF_COMPLETE (income extractors never get BF_ACTIVE)', () => {
  it('a complete mass extractor without BF_ACTIVE turns its drum as the clock advances; a started one does not', () => {
    const b = oneBuilding(B.massExtractor, 54, 50);
    const on = b.at(10, BF_COMPLETE | BF_STARTED);
    expect(on.buildings.cols.flags[0]! & BF_ACTIVE).toBe(0);
    const E = nextEpoch();
    drawAt(r, on, { t: 0, dt: 0, world: E });
    drawAt(r, on, { t: 0.1, dt: 0.1, world: E });
    const d0 = partInstances(scene, 'mass/drum');
    drawAt(r, on, { t: 0.6, dt: 0.5, world: E });
    const d1 = partInstances(scene, 'mass/drum');
    expect(d0.length).toBe(1);
    expect(diff(d0, d1)).toBeGreaterThan(1e-3);
    const off = b.at(10, BF_STARTED, 0, 0.5);
    const E2 = nextEpoch();
    drawAt(r, off, { t: 0, dt: 0, world: E2 });
    const e0 = partInstances(scene, 'mass/drum');
    drawAt(r, off, { t: 0.5, dt: 0.5, world: E2 });
    expect(diff(e0, partInstances(scene, 'mass/drum'))).toBe(0);
  });

  it('a complete rare extractor turns its ring', () => {
    const b = oneBuilding(B.rareExtractor, 73, 29);
    const on = b.at(10, BF_COMPLETE | BF_STARTED);
    const E = nextEpoch();
    drawAt(r, on, { t: 0, dt: 0, world: E });
    drawAt(r, on, { t: 0.1, dt: 0.1, world: E });
    const d0 = partInstances(scene, 'rare/ring');
    drawAt(r, on, { t: 0.6, dt: 0.5, world: E });
    expect(d0.length).toBe(1);
    expect(diff(d0, partInstances(scene, 'rare/ring'))).toBeGreaterThan(1e-3);
  });
});

describe('generator: running by BF_COMPLETE (never gets BF_ACTIVE)', () => {
  it('complete: the vane ring spins as the clock advances; under construction: still', () => {
    const b = oneBuilding(B.generator, 40, 44);
    const E = nextEpoch();
    const on = b.at(10, BF_COMPLETE | BF_STARTED);
    drawAt(r, on, { t: 0, dt: 0, world: E });
    const v0 = modelInstances(scene, 'generator/vane');
    drawAt(r, on, { t: 0.5, dt: 0.5, world: E });
    const v1 = modelInstances(scene, 'generator/vane');
    expect(v0.length).toBe(1);
    expect(diff(v0, v1)).toBeGreaterThan(1e-3);
    const E2 = nextEpoch();
    const off = b.at(10, BF_STARTED, 0, 0.5);
    drawAt(r, off, { t: 0, dt: 0, world: E2 });
    const w0 = modelInstances(scene, 'generator/vane');
    drawAt(r, off, { t: 0.5, dt: 0.5, world: E2 });
    expect(diff(w0, modelInstances(scene, 'generator/vane'))).toBe(0);
  });
});

describe('machines (smelter, assembler, shredder): BF_ACTIVE, not BF_STARVED, and work advancing between snapshots', () => {
  const MOVING: Array<[string, number, number, number, string | null]> = [
    ['assembler', B.assembler, 82, 44, 'assembler/arm'],
    ['shredder', B.shredder, 66, 44, 'shredder/rollA'],
    ['smelter', B.smelter, 74, 44, null],
  ];
  /** Draws snapshots a (tick 10, work .2) then b; returns the motion over 0.5 s of clock after b. */
  function run(kind: number, tx: number, ty: number, part: string | null, flagsB: number, workB: number, tickB = 11) {
    const b = oneBuilding(kind, tx, ty);
    const E = nextEpoch();
    const on = BF_COMPLETE | BF_STARTED | BF_ACTIVE;
    drawAt(r, b.at(10, on, 0.2), { t: 0, dt: 0, world: E });
    const sb = b.at(tickB, flagsB, workB);
    drawAt(r, sb, { t: 0.1, dt: 0.1, world: E });
    const read = () => (part ? modelInstances(scene, part) : null);
    const m0 = read();
    const smoke: Array<Array<[number, number, number]>> = [];
    for (let k = 1; k <= 10; k++) {
      drawAt(r, sb, { t: 0.1 + k * 0.1, dt: 0.1, world: E });
      smoke.push(near([...particles(scene, 'smoke'), ...particles(scene, 'glow')], tx + 1, ty + 1, 3));
    }
    return { moved: part ? diff(m0!, read()!) : 0, count: part ? m0!.length : 0, smoke };
  }

  for (const [name, kind, tx, ty, part] of MOVING) {
    it(`${name}: on (work .2 → .3 in one tick, and → .5 over three ticks): moves as the clock advances`, () => {
      for (const [workB, tickB] of [
        [0.3, 11],
        [0.5, 13],
      ] as const) {
        const res = run(kind, tx, ty, part, BF_COMPLETE | BF_STARTED | BF_ACTIVE, workB, tickB);
        if (part) {
          expect(res.count, `${name} part drawn`).toBe(1);
          expect(res.moved, `${name} work ${workB} at tick ${tickB}`).toBeGreaterThan(1e-3);
        } else {
          // the smelter has no moving part: smoke rises from its chimneys and moves
          const last = res.smoke[res.smoke.length - 1]!;
          const prev = res.smoke[res.smoke.length - 2]!;
          expect(last.length, 'smoke near the smelter').toBeGreaterThan(0);
          expect(JSON.stringify(last)).not.toBe(JSON.stringify(prev));
        }
      }
    });

    it(`${name}: off when starved, when work does not advance, or without BF_ACTIVE`, () => {
      for (const [flags, work, why] of [
        [BF_COMPLETE | BF_STARTED | BF_ACTIVE | BF_STARVED, 0.3, 'starved'],
        [BF_COMPLETE | BF_STARTED | BF_ACTIVE, 0.2, 'work not advancing'],
        [BF_COMPLETE | BF_STARTED, 0.3, 'not active'],
      ] as const) {
        const res = run(kind, tx, ty, part, flags, work);
        if (part) expect(res.moved, `${name}: ${why}`).toBe(0);
        else expect(res.smoke[res.smoke.length - 1]!.length, `${name}: ${why}`).toBe(0);
      }
    });
  }
});

describe('gate doors: a player unit within 2 tiles opens them; aliens never do', () => {
  function gateWorld() {
    const w = new World(1, terrain, { waves: false });
    const gate = w.placeBuilding(B.gate, 72, 66, true, 0, 3, 2);
    if (gate < 0) throw new Error('gate');
    const eng = w.spawnUnit(U.engineer, 95.5, 90.5);
    const alien = w.spawnAlien(A.rusher, 100.5, 95.5);
    const put = (id: number, table: 'units' | 'aliens', x: number, z: number) => {
      w[table].cols.x[slot(id)] = x;
      w[table].cols.z[slot(id)] = z;
    };
    return { w, eng, alien, put };
  }
  const leaves = () => partInstances(scene, 'gate/leaf');

  it('an engineer 1 tile from the gate: the leaves slide apart as the clock advances', () => {
    const g = gateWorld();
    const E = nextEpoch();
    drawAt(r, snapAt(g.w, 10), { t: 0, dt: 0, world: E });
    const shut = leaves();
    expect(shut.length).toBe(4);
    g.put(g.eng, 'units', 73.5, 69.0);
    const s = snapAt(g.w, 11);
    drawAt(r, s, { t: 0.05, dt: 0.05, world: E });
    const a = leaves();
    drawAt(r, s, { t: 0.4, dt: 0.35, world: E });
    const b = leaves();
    expect(diff(a, b)).toBeGreaterThan(0.05);
    // apart: the leaves' spread along the run grows
    const spread = (l: Float32Array[]) => Math.max(...l.map((m) => m[12]!)) - Math.min(...l.map((m) => m[12]!));
    expect(spread(b)).toBeGreaterThan(spread(shut) + 0.1);
  });

  it('an alien 1 tile from the gate (no player unit near): the leaves stay shut', () => {
    const g = gateWorld();
    const E = nextEpoch();
    drawAt(r, snapAt(g.w, 10), { t: 0, dt: 0, world: E });
    const shut = leaves();
    g.put(g.alien, 'aliens', 73.5, 69.0);
    const s = snapAt(g.w, 11);
    for (let k = 1; k <= 10; k++) drawAt(r, s, { t: k * 0.1, dt: 0.1, world: E });
    expect(diff(shut, leaves())).toBe(0);
  });

  it('an engineer 4 tiles away: shut', () => {
    const g = gateWorld();
    const E = nextEpoch();
    g.put(g.eng, 'units', 73.5, 72.5);
    const s = snapAt(g.w, 10);
    drawAt(r, s, { t: 0, dt: 0, world: E });
    const shut = leaves();
    for (let k = 1; k <= 10; k++) drawAt(r, s, { t: k * 0.1, dt: 0.1, world: E });
    expect(diff(shut, leaves())).toBe(0);
  });
});

describe("beam turret's beam: BF_FIRING and a present target", () => {
  function beamWorld() {
    const w = new World(1, terrain, { waves: false });
    const id = w.placeBuilding(B.beam, 66, 56, true);
    const alien = w.spawnAlien(A.hunter, 70.5, 50.5);
    const at = (tick: number, flags: number, target: number) => {
      const s = snapAt(w, tick);
      const row = rowIn(s.buildings, id);
      s.buildings.cols.flags[row] = flags;
      s.buildings.cols.target[row] = target;
      return s;
    };
    return { w, id, alien, at };
  }

  it('on: a beam from the muzzle to the target, drawn every frame and pulsing as the clock advances', () => {
    const g = beamWorld();
    const E = nextEpoch();
    const s = g.at(10, BF_COMPLETE | BF_STARTED | BF_FIRING, g.alien + 1);
    drawAt(r, s, { t: 0, dt: 0, world: E });
    const a = fx(scene, 'overlay/fx/turret-beam');
    drawAt(r, s, { t: 0.07, dt: 0.07, world: E });
    const b = fx(scene, 'overlay/fx/turret-beam');
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(dist(a[0]!, 67, 57)).toBeLessThan(1.5);
    const [ex, ez] = beamEnd(a[0]!);
    expect(Math.hypot(ex - 70.5, ez - 50.5)).toBeLessThan(0.8);
    expect(diff(a, b)).toBeGreaterThan(1e-4);
  });

  it('off: flag clear, or the target absent', () => {
    const g = beamWorld();
    for (const s of [g.at(10, BF_COMPLETE | BF_STARTED, g.alien + 1), g.at(11, BF_COMPLETE | BF_STARTED | BF_FIRING, 60000)]) {
      const E = nextEpoch();
      drawAt(r, s, { t: 0, dt: 0, world: E });
      drawAt(r, s, { t: 0.1, dt: 0.1, world: E });
      expect(fx(scene, 'overlay/fx/turret-beam').length).toBe(0);
    }
  });
});

describe('shots: every observed projectile row, interpolated; impact when the row is gone', () => {
  function shotWorld() {
    const w = new World(1, terrain, { waves: false });
    const gun = w.placeBuilding(B.gun, 48, 56, true);
    const P = w.projectiles;
    const add = (kind: number, x: number, z: number) => {
      const id = P.create();
      const c = P.cols;
      c.kind[slot(id)] = kind;
      c.x[slot(id)] = x;
      c.z[slot(id)] = z;
      c.fx[slot(id)] = 0;
      c.fz[slot(id)] = -1;
      c.srcType[slot(id)] = T_BUILDING;
      c.srcKind[slot(id)] = B.gun;
      c.srcId[slot(id)] = gun;
      return id;
    };
    return { w, gun, add };
  }

  it('a bullet and a shell are tracers, an alien shot its own shape; they move with the interpolation', () => {
    const g = shotWorld();
    const bullet = g.add(P_BULLET, 49, 54.5);
    g.add(P_SHELL, 50, 54);
    const spit = g.add(P_ALIEN, 60, 40);
    void spit;
    const ip = new Interpolator(CAPACITY);
    const E = nextEpoch();
    ip.push(snapAt(g.w, 10), 0, E);
    drawAt(r, ip.curr!, { t: 0, dt: 0, world: E, aliens: ip.aliens, units: ip.units, projectiles: ip.projectiles });
    expect(fx(scene, 'overlay/fx/tracer').length).toBe(2);
    expect(fx(scene, 'overlay/fx/alien-shot').length).toBe(1);
    // the bullet's first point is the shooter's muzzle: its tail starts at the gun
    const first = fx(scene, 'overlay/fx/tracer');
    expect(Math.min(...first.map((m) => dist(m, 49, 57)))).toBeLessThan(1.6);
    // next tick: the rows moved north
    const P = g.w.projectiles.cols;
    for (let i = 0; i < 3; i++) P.z[i] = P.z[i]! - 1.5;
    ip.push(snapAt(g.w, 11), 100, E);
    ip.update(130);
    drawAt(r, ip.curr!, { t: 0.13, dt: 0.13, world: E, aliens: ip.aliens, units: ip.units, projectiles: ip.projectiles });
    const a = fx(scene, 'overlay/fx/tracer');
    const sa = fx(scene, 'overlay/fx/alien-shot');
    ip.update(180);
    drawAt(r, ip.curr!, { t: 0.18, dt: 0.05, world: E, aliens: ip.aliens, units: ip.units, projectiles: ip.projectiles });
    expect(diff(a, fx(scene, 'overlay/fx/tracer'))).toBeGreaterThan(1e-3);
    expect(diff(sa, fx(scene, 'overlay/fx/alien-shot'))).toBeGreaterThan(1e-3);
    // the bullet's row goes: an impact (W21 particles) at its last position, its tracer gone
    const last = ip.projectiles.z[rowIn(ip.curr!.projectiles, bullet)]!;
    g.w.projectiles.remove(slot(bullet));
    ip.push(snapAt(g.w, 12), 200, E);
    drawAt(r, ip.curr!, { t: 0.2, dt: 0.02, world: E, aliens: ip.aliens, units: ip.units, projectiles: ip.projectiles });
    expect(fx(scene, 'overlay/fx/tracer').length).toBe(1);
    expect(near(particles(scene, 'glow'), 49, last, 1.2).length).toBeGreaterThan(0);
  });

  it('off: no projectile rows, no tracers', () => {
    const g = shotWorld();
    const E = nextEpoch();
    const s = snapAt(g.w, 10);
    drawAt(r, s, { t: 0, dt: 0, world: E, projectiles: mobileP(s.projectiles) });
    expect(fx(scene, 'overlay/fx/tracer').length).toBe(0);
    expect(fx(scene, 'overlay/fx/alien-shot').length).toBe(0);
    void mobile;
  });
});
