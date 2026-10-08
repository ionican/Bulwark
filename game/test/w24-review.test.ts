// W24 run 1, Codex adversarial review: one regression test per finding.
//   1 startWave at alien capacity stopped the simulation ('entity table full').
//   2 speed tuning let a saboteur cross a complete gate in one tick.
//   3 refusals at apply time never reached the caller.
//   4 the renderer drew at most 1,024 reserved sites although valid runs make more.

import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Scene } from 'three';
import { World } from '../src/sim/world.ts';
import { createWorld } from '../src/sim/scenarios.ts';
import { A, B, U } from '../src/sim/kinds.ts';
import { flatTerrain } from '../src/sim/terrain.ts';
import { serializeWorld } from '../src/sim/save.ts';
import { decodeSnapshot, encodeSnapshot } from '../src/sim/snapshot.ts';
import { SimRunner, type CommandResult } from '../src/sim/runner.ts';
import { setTune, TA_SPEED, TU_SPEED } from '../src/sim/tuning.ts';
import { EntityRenderer } from '../src/render/entities.ts';
import { Interpolator } from '../src/render/interp.ts';
import { applyRig } from '../src/render/cameraRig.ts';
import { flatWorld } from './fixtures.ts';

// ---- 1: capacity ---------------------------------------------------------------------------------

/** A sandbox whose alien table is full (4,096 aliens, spread so they are far from everything). */
function fullSandbox() {
  const w = new World(1, flatTerrain(128, 128, { base: { x: 64, z: 120 } }), { waves: false });
  w.scenario = 'sandbox';
  for (let i = 0; w.aliens.count < w.aliens.capacity; i++) w.spawnAlien(A.breaker, 0.5 + (i % 128), 0.5 + Math.floor(i / 128) * 0.9);
  return w;
}

describe('review 1: spawning at alien capacity', () => {
  it('startWave and spawnAt count live aliens and pending spawns, and are refused when they would not fit', () => {
    const w = fullSandbox();
    expect(w.submit({ t: 'startWave', index: 0 })).toMatch(/alien table/);
    expect(w.submit({ t: 'spawnAt', kind: A.rusher, x: 64.5, z: 100.5, count: 1 })).toMatch(/alien table/);
    // With room for 10 and 16 pending from a wave, a spawnAt of 10 no longer fits.
    const v = createWorld(1, 'sandbox');
    for (let i = 0; v.aliens.count < v.aliens.capacity - 26; i++) v.spawnAlien(A.breaker, 0.5 + (i % 128), 0.5 + Math.floor(i / 128) * 0.9);
    expect(v.submit({ t: 'startWave', index: 0 })).toBeNull(); // 16 rushers
    v.step();
    expect(v.submit({ t: 'spawnAt', kind: A.rusher, x: 64.5, z: 90.5, count: 10 + 1 })).toMatch(/alien table/);
  });

  it('a wave forced into a full table defers its spawns instead of throwing; the simulation keeps ticking; clearAliens then works', () => {
    const w = fullSandbox();
    w.enqueue({ t: 'spawn', kind: A.rusher, entry: 0, count: 16 }); // the debug spawn: never refused for room
    const tick = w.tick;
    for (let i = 0; i < 20; i++) expect(() => w.step()).not.toThrow();
    expect(w.tick).toBe(tick + 20);
    expect(w.pendingSpawns).toBe(16); // waiting for room
    w.enqueue({ t: 'clearAliens' });
    w.step();
    expect(w.aliens.count).toBeLessThanOrEqual(1);
    w.enqueue({ t: 'spawn', kind: A.rusher, entry: 0, count: 3 });
    for (let i = 0; i < 200; i++) w.step();
    expect(w.pendingSpawns).toBe(0);
    expect(w.aliens.count).toBeGreaterThan(0);
  });

  it("map 1's own wave schedule defers at a full table instead of throwing", () => {
    const w = createWorld(1, 'map1');
    for (let i = 0; w.aliens.count < w.aliens.capacity; i++) w.spawnAlien(A.breaker, 0.5 + (i % 128), 100.5 + Math.floor(i / 128) * 0.5);
    w.waveTicks[0] = w.tick + 1;
    for (let i = 0; i < 30; i++) expect(() => w.step()).not.toThrow();
    expect(w.nextWave).toBe(1);
  });

  it('the runner survives an exception in a tick: it reports it and keeps ticking', () => {
    const r = new SimRunner(createWorld(1, 'sandbox'), 0);
    const errors: string[] = [];
    const step = r.world.step.bind(r.world);
    let calls = 0;
    r.world.step = () => {
      if (calls++ === 3) throw new Error('boom');
      step();
    };
    let now = 0;
    for (let i = 0; i < 50; i++) {
      now += 100;
      const out = r.advanceSafe(now);
      if (out.error) errors.push(out.error);
    }
    expect(errors).toEqual([expect.stringMatching(/boom/)]);
    expect(r.world.tick).toBeGreaterThan(40);
  });
});

// ---- 2: movement never enters or crosses a blocking tile ----------------------------------------

/** True if the straight move from (x0, z0) to (x1, z1) touches a tile `blocked` reports (sampled finely). */
function crosses(x0: number, z0: number, x1: number, z1: number, blocked: (tx: number, tz: number) => boolean): boolean {
  const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) * 200) + 1;
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const z = z0 + ((z1 - z0) * i) / n;
    if (blocked(Math.floor(x), Math.floor(z))) return true;
  }
  return false;
}

/** Runs `ticks` and checks every alien and unit against every blocking tile each tick. */
function watch(w: World, ticks: number) {
  const W = w.terrain.w;
  const alienBlocked = (tx: number, tz: number) => tx < 0 || tz < 0 || tx >= W || tz >= w.terrain.h || !w.alienPassable(tz * W + tx);
  const unitBlocked = (tx: number, tz: number) => tx < 0 || tz < 0 || tx >= W || tz >= w.terrain.h || !w.unitPassable(tz * W + tx);
  const prevA = new Map<number, [number, number]>();
  const prevU = new Map<number, [number, number]>();
  // Starting positions, so the very first tick's moves are checked too.
  for (let s = 0; s < w.aliens.highWater; s++) if (w.aliens.alive[s]) prevA.set(w.aliens.id(s), [w.aliens.cols.x[s]!, w.aliens.cols.z[s]!]);
  for (let s = 0; s < w.units.highWater; s++) if (w.units.alive[s]) prevU.set(w.units.id(s), [w.units.cols.x[s]!, w.units.cols.z[s]!]);
  let moved = 0;
  for (let t = 0; t < ticks; t++) {
    w.step();
    for (let s = 0; s < w.aliens.highWater; s++) {
      if (!w.aliens.alive[s]) continue;
      const id = w.aliens.id(s);
      const x = w.aliens.cols.x[s]!;
      const z = w.aliens.cols.z[s]!;
      expect(alienBlocked(Math.floor(x), Math.floor(z)), `alien on a blocking tile at ${x},${z}, tick ${w.tick}`).toBe(false);
      const p = prevA.get(id);
      if (p) {
        expect(crosses(p[0], p[1], x, z, alienBlocked), `alien crossed a blocking tile ${p} -> ${x},${z}, tick ${w.tick}`).toBe(false);
        if (p[0] !== x || p[1] !== z) moved++;
      }
      prevA.set(id, [x, z]);
    }
    for (let s = 0; s < w.units.highWater; s++) {
      if (!w.units.alive[s]) continue;
      const id = w.units.id(s);
      const x = w.units.cols.x[s]!;
      const z = w.units.cols.z[s]!;
      const p = prevU.get(id);
      if (p) expect(crosses(p[0], p[1], x, z, unitBlocked), `unit crossed a blocking tile ${p} -> ${x},${z}, tick ${w.tick}`).toBe(false);
      prevU.set(id, [x, z]);
    }
  }
  return moved;
}

describe('review 2: movement through blocking tiles', () => {
  for (const axis of ['x', 'z'] as const) {
    for (const speed of [0.1, 10]) {
      it(`a saboteur chasing an engineer does not cross a complete gate (axis ${axis}, speed ${speed}×)`, () => {
        const w = flatWorld(30, 30, { rich: true });
        w.scenario = 'sandbox';
        // Gate across row 10 (axis x: x 8..10) or column 10 (axis z: z 8..10); the engineer waits
        // two tiles beyond it, straight across the centre column.
        const gate = axis === 'x' ? w.placeBuilding(B.gate, 8, 10, true, 0, 3, 1) : w.placeBuilding(B.gate, 10, 8, true, 1, 1, 3);
        const [ex, ez] = axis === 'x' ? [9.5, 11.5] : [11.5, 9.5];
        w.spawnUnit(U.engineer, ex, ez);
        w.spawnAlien(A.saboteur, 9.5, 9.5);
        setTune(w, 'alien', A.saboteur, TA_SPEED, speed);
        const hp = w.buildings.cols.hp[w.buildings.slotForId(gate)]!;
        watch(w, 60);
        // The gate still stands, and it was not healed.
        const g = w.buildings.slotForId(gate);
        expect(g).toBeGreaterThanOrEqual(0);
        expect(w.buildings.cols.hp[g]).toBeLessThanOrEqual(hp);
      });
    }
  }

  for (const target of ['wall', 'gate'] as const) {
    it(`a rusher at 10× against a ${target} never stands on or crosses a blocking tile`, () => {
      const rocks: Array<[number, number]> = [];
      for (let x = 0; x < 30; x++) if (x < 7 || x > 11) rocks.push([x, 15]);
      const w = flatWorld(30, 30, { rich: true, terrain: { rocks, base: { x: 15, z: 2 } } });
      w.scenario = 'sandbox';
      if (target === 'wall') for (let x = 7; x <= 11; x++) w.placeBuilding(B.wall, x, 15, true);
      else {
        w.placeBuilding(B.wall, 7, 15, true);
        w.placeBuilding(B.gate, 8, 15, true, 0, 3, 1);
        w.placeBuilding(B.wall, 11, 15, true);
      }
      w.placeBuilding(B.gun, 8, 3, true);
      for (let i = 0; i < 6; i++) w.spawnAlien(A.rusher, 6.5 + i, 27.5);
      setTune(w, 'alien', A.rusher, TA_SPEED, 10);
      expect(watch(w, 150)).toBeGreaterThan(0);
    });
  }

  it('an engineer at 10× speed walking round a wall never crosses it', () => {
    const w = flatWorld(30, 30, { rich: true });
    for (let x = 0; x < 25; x++) w.placeBuilding(B.wall, x, 15, true);
    const e = w.spawnUnit(U.engineer, 5.5, 25.5);
    setTune(w, 'unit', U.engineer, TU_SPEED, 10);
    w.enqueue({ t: 'move', ids: [e], x: 5.5, z: 5.5 });
    watch(w, 200);
    const s = w.units.slotForId(e);
    expect(w.units.cols.z[s]).toBeCloseTo(5.5, 3);
  });
});

// ---- 3: final command results ------------------------------------------------------------------

describe('review 3: the result of each command is reported when it runs', () => {
  it('three spawnAt of 50 at one point before a tick: two applied, the third refused with its reason, delivered', () => {
    const r = new SimRunner(createWorld(1, 'sandbox'), 0);
    const results: CommandResult[] = [];
    r.onResult = (res) => results.push(res);
    for (let ref = 1; ref <= 3; ref++) expect(r.submitTracked({ t: 'spawnAt', kind: A.breaker, x: 40.5, z: 40.5, count: 50 }, ref)).toBeNull();
    expect(results).toEqual([]); // nothing is final before the tick runs
    r.stepOnce();
    expect(r.world.aliens.count).toBe(100);
    expect(results.map((x) => [x.ref, x.ok])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
    expect(results[2]!.reason).toMatch(/only \d+ of 50 breakers fit/);
  });

  it('a refusal at submit is final at once, and commands lost to a load are reported', () => {
    const r = new SimRunner(createWorld(1, 'sandbox'), 0);
    const results: CommandResult[] = [];
    r.onResult = (res) => results.push(res);
    expect(r.submitTracked({ t: 'spawnAt', kind: A.breaker, x: 40.5, z: 40.5, count: 99 }, 7)).toMatch(/1\.\.50/);
    expect(results).toEqual([]); // the caller reports a submit refusal itself
    expect(r.submitTracked({ t: 'clearAliens' }, 8)).toBeNull();
    r.paused = true;
    r.load(serializeWorld(createWorld(2, 'sandbox')));
    expect(results.map(({ ref, ok, reason }) => ({ ref, ok, reason }))).toEqual([{ ref: 8, ok: false, reason: expect.stringMatching(/load/) }]);
  });
});

// ---- 4: renderer capacity ----------------------------------------------------------------------

describe('review 4: the renderer draws every reserved site', () => {
  it('three maximum runs (1,536 reserved tiles) are all drawn, with no overflow', () => {
    const terrain = flatTerrain(128, 128);
    const w = new World(1, terrain, { waves: false });
    for (const y of [10, 40, 70]) w.enqueue({ t: 'buildRun', ids: [], from: [0, y], to: [127, y], depth: 4 });
    w.step();
    expect(w.buildings.count).toBe(1536);
    const snap = decodeSnapshot(encodeSnapshot(w));
    const scene = new Scene();
    const renderer = new EntityRenderer(scene, terrain);
    const interp = new Interpolator();
    interp.push(snap, 0);
    const camera = new PerspectiveCamera(60, 1, 0.5, 2000);
    applyRig(camera, { x: 64, z: 64, distance: 400, yaw: 0 }, 0);
    camera.updateMatrixWorld();
    renderer.update({ camera, viewportHeight: 900, yaw: 0, snapshot: snap, aliens: interp.aliens, units: interp.units, projectiles: interp.projectiles, selection: [], showRoutes: true });
    expect(renderer.counts.culled).toBe(0);
    expect(renderer.reservedDrawn).toBe(1536);
    expect(renderer.overflowed).toBe(false);
  });
});
