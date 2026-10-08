// W24 acceptance 4 (wall runs): buildRun from (10,10) to (19,12), depth 2, with builders west of
// x = 10 gives 20 tiles on rows y = 10 and 11, built column by column from x = 10, row 10 first in
// each column; blocked tiles are skipped and counted; a 128-tile run at depth 4 is one order per
// builder; a run refused when the run table is full creates nothing; resources drain during
// building only.

import { describe, expect, it } from 'vitest';
import { World, MAX_ORDERS } from '../src/sim/world.ts';
import { B, U, buildingInfo } from '../src/sim/kinds.ts';
import { BF_COMPLETE, BF_STARTED } from '../src/sim/schema.ts';
import { TILE_ROCK, flatTerrain } from '../src/sim/terrain.ts';
import { RUN_CAPACITY, planRun, runById, runProgress } from '../src/sim/runs.ts';
import type { Command } from '../src/sim/commands.ts';

const flat = (w = 40, h = 40) => {
  const world = new World(1, flatTerrain(w, h), { waves: false });
  world.pool.set([1e6, 1e6, 1e6]);
  return world;
};
const posOf = (w: World, id: number): [number, number] => {
  const s = w.buildings.slotForId(id);
  return [w.buildings.cols.tx[s]!, w.buildings.cols.ty[s]!];
};
const flagsOf = (w: World, id: number) => {
  const s = w.buildings.slotForId(id);
  return s < 0 ? -1 : w.buildings.cols.flags[s]!;
};
/** The expected order: columns x = 10..19, row 10 then row 11 in each. */
const EXPECTED: Array<[number, number]> = [];
for (let x = 10; x <= 19; x++) EXPECTED.push([x, 10], [x, 11]);

function onlyRun(w: World) {
  const runs = w.runs.filter((r) => r !== null);
  expect(runs.length).toBe(1);
  return runs[0]!;
}

describe('wall run geometry and build order', () => {
  it('(10,10) → (19,12), depth 2, builders west: 20 tiles on rows 10 and 11, column by column from x = 10, row 10 first', () => {
    const w = flat();
    const ids = [w.spawnUnit(U.engineer, 4.5, 10.5), w.spawnUnit(U.engineer, 4.5, 12.5)];
    const cmd: Command = { t: 'buildRun', ids, from: [10, 10], to: [19, 12], depth: 2 };
    expect(w.submit(cmd)).toBeNull();
    w.step();
    const run = onlyRun(w);
    expect(run.sites.length).toBe(20);
    expect(run.sites.map((id) => posOf(w, id))).toEqual(EXPECTED);
    expect(run.skipped).toBe(0);
    // Every tile is an ordinary wall site, reserved, tier 1.
    for (const id of run.sites) {
      const s = w.buildings.slotForId(id);
      expect(w.buildings.cols.kind[s]).toBe(B.wall);
      expect(w.buildings.cols.tier[s]).toBe(1);
    }
  });

  it('builders east of the run start from the other end; to on the axis puts depth rows on the positive side; ties go along x', () => {
    const w = flat();
    const east = [w.spawnUnit(U.engineer, 30.5, 10.5)];
    const p = planRun(w, { ids: east, from: [10, 10], to: [19, 12], depth: 2 });
    if (typeof p === 'string') throw new Error(p);
    expect(p.start).toBe('to');
    expect(p.tiles.slice(0, 4)).toEqual([[19, 10], [19, 11], [18, 10], [18, 11]]);
    const onAxis = planRun(w, { ids: [], from: [10, 10], to: [14, 10], depth: 3 });
    if (typeof onAxis === 'string') throw new Error(onAxis);
    expect(onAxis.tiles.slice(0, 3)).toEqual([[10, 10], [10, 11], [10, 12]]);
    const up = planRun(w, { ids: [], from: [10, 10], to: [14, 8], depth: 2 });
    if (typeof up === 'string') throw new Error(up);
    expect(up.tiles.slice(0, 2)).toEqual([[10, 10], [10, 9]]); // `to` lies at -z: rows go to -z
    const tie = planRun(w, { ids: [], from: [10, 10], to: [13, 13], depth: 1 });
    if (typeof tie === 'string') throw new Error(tie);
    expect(tie.axis).toBe('x');
    const alongZ = planRun(w, { ids: [], from: [10, 10], to: [12, 20], depth: 1 });
    if (typeof alongZ === 'string') throw new Error(alongZ);
    expect(alongZ.axis).toBe('z');
    expect(alongZ.tiles.length).toBe(11);
  });

  it('one builder builds the tiles in exactly that order', () => {
    const w = flat();
    const e = w.spawnUnit(U.engineer, 6.5, 10.5);
    w.enqueue({ t: 'buildRun', ids: [e], from: [10, 10], to: [19, 12], depth: 2 });
    w.step();
    const run = onlyRun(w);
    const sites = [...run.sites];
    const completed: number[] = [];
    for (let i = 0; i < 6000 && completed.length < 20; i++) {
      w.step();
      for (const id of sites) if (flagsOf(w, id) & BF_COMPLETE && !completed.includes(id)) completed.push(id);
    }
    expect(completed.map((id) => posOf(w, id))).toEqual(EXPECTED);
    expect(w.runs.every((r) => r === null)).toBe(true); // a finished run leaves the table
    w.step(); // the builder drops its run order on its next turn
    expect(w.orders[w.units.slotForId(e)]!.length).toBe(0);
  });

  it('several builders take tiles in build order: the started tiles are always within the first (started + builders) of the order', () => {
    const w = flat();
    const ids = [w.spawnUnit(U.commander, 5.5, 10.5), w.spawnUnit(U.engineer, 4.5, 11.5), w.spawnUnit(U.engineer, 4.5, 9.5)];
    w.enqueue({ t: 'buildRun', ids, from: [10, 10], to: [19, 12], depth: 2 });
    w.step();
    const sites = [...onlyRun(w).sites];
    let ticks = 0;
    while (sites.some((id) => !(flagsOf(w, id) & BF_COMPLETE)) && ticks++ < 6000) {
      w.step();
      const begun = sites.map((id) => (flagsOf(w, id) & BF_STARTED) !== 0);
      const n = begun.filter(Boolean).length;
      const last = begun.lastIndexOf(true);
      expect(last).toBeLessThan(n + ids.length - 1);
    }
    expect(sites.every((id) => flagsOf(w, id) & BF_COMPLETE)).toBe(true);
  });
});

describe('skipped tiles', () => {
  it('rock, existing wall and otherwise blocked tiles are skipped and counted', () => {
    const terrain = flatTerrain(40, 40, { rocks: [[13, 10]] });
    const w = new World(1, terrain, { waves: false });
    w.placeBuilding(B.wall, 12, 11, true); // already wall
    w.placeBuilding(B.gun, 15, 10, true); // blocks (15..16, 10..11): 4 tiles
    const ids = [w.spawnUnit(U.engineer, 4.5, 10.5)];
    const plan = planRun(w, { ids, from: [10, 10], to: [19, 12], depth: 2 });
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.skipped).toEqual({ rock: 1, wall: 1, blocked: 4, total: 6 });
    expect(plan.tiles.length).toBe(14);
    w.enqueue({ t: 'buildRun', ids, from: [10, 10], to: [19, 12], depth: 2 });
    w.step();
    const run = onlyRun(w);
    expect(run.sites.length).toBe(14);
    expect(run.skipped).toBe(6);
    const expected = EXPECTED.filter(([x, y]) => !(x === 13 && y === 10) && !(x === 12 && y === 11) && !(x >= 15 && x <= 16));
    expect(run.sites.map((id) => posOf(w, id))).toEqual(expected);
    expect(terrain.tiles[10 * 40 + 13]).toBe(TILE_ROCK);
  });

  it('a run with nothing to build is refused with the counts', () => {
    const w = flat();
    for (let x = 10; x <= 12; x++) w.placeBuilding(B.wall, x, 10, true);
    expect(w.submit({ t: 'buildRun', ids: [], from: [10, 10], to: [12, 10], depth: 1 })).toMatch(/nothing to build: all 3 tiles skipped \(rock 0, wall 3, blocked 0\)/);
  });

  it('refuses depth 0 and 5, and runs longer than 128 tiles', () => {
    const w = flat(200, 20);
    expect(w.submit({ t: 'buildRun', ids: [], from: [1, 1], to: [5, 1], depth: 0 })).toMatch(/depth must be 1\.\.4/);
    expect(w.submit({ t: 'buildRun', ids: [], from: [1, 1], to: [5, 1], depth: 5 })).toMatch(/depth must be 1\.\.4/);
    expect(w.submit({ t: 'buildRun', ids: [], from: [0, 1], to: [128, 1], depth: 1 })).toMatch(/at most 128 tiles/);
    expect(w.submit({ t: 'buildRun', ids: [], from: [0, 1], to: [127, 1], depth: 1 })).toBeNull();
  });
});

describe('one order per builder, and the run table', () => {
  it('a 128-tile run at depth 4 (512 tiles) is one order per builder', () => {
    const w = flat(128, 20);
    const ids = [w.spawnUnit(U.commander, 2.5, 2.5), w.spawnUnit(U.engineer, 3.5, 2.5), w.spawnUnit(U.engineer, 4.5, 2.5)];
    expect(w.submit({ t: 'buildRun', ids, from: [0, 10], to: [127, 12], depth: 4 })).toBeNull();
    w.step();
    const run = onlyRun(w);
    expect(run.sites.length).toBe(512);
    expect(512).toBeGreaterThan(MAX_ORDERS);
    for (const id of ids) {
      const orders = w.orders[w.units.slotForId(id)]!;
      expect(orders.length).toBe(1);
      expect(orders[0]!.t).toBe('run');
    }
    expect(w.applyRejected.length).toBe(0);
  });

  it('a run refused because the table is full creates nothing (validation and apply)', () => {
    const w = flat(80, 80);
    const e = w.spawnUnit(U.engineer, 2.5, 2.5);
    for (let i = 0; i < RUN_CAPACITY; i++) w.enqueue({ t: 'buildRun', ids: [], from: [2, 4 + i * 2], to: [4, 4 + i * 2], depth: 1 });
    w.step();
    expect(w.runs.every((r) => r !== null)).toBe(true);
    const buildings = w.buildings.count;
    const full: Command = { t: 'buildRun', ids: [e], from: [10, 70], to: [20, 70], depth: 2 };
    expect(w.submit(full)).toMatch(/run table is full \(32 runs\)/);
    // Forced past validation, the apply step refuses it too: no site, no order.
    w.enqueue(full);
    w.step();
    expect(w.buildings.count).toBe(buildings);
    expect(w.orders[w.units.slotForId(e)]!.length).toBe(0);
    expect(w.applyRejected.some((r) => /run table is full/.test(r.reason))).toBe(true);
  });

  it('stop leaves the remaining reserved tiles; cancelRun removes them and keeps started ones', () => {
    const w = flat();
    const e = w.spawnUnit(U.engineer, 8.5, 10.5);
    w.enqueue({ t: 'buildRun', ids: [e], from: [10, 10], to: [19, 10], depth: 1 });
    w.step();
    const run = onlyRun(w);
    while (runProgress(w, run).started === 0) w.step(); // the first tile has build power
    w.enqueue({ t: 'stop', ids: [e] });
    for (let i = 0; i < 20; i++) w.step();
    const p = runProgress(w, run);
    expect(p.reserved).toBe(9);
    expect(p.started + p.complete).toBe(1);
    expect(runById(w, run.id)).toBe(run); // still in the table
    expect(w.submit({ t: 'cancelRun', run: run.id })).toBeNull();
    w.step();
    expect(runById(w, run.id)).toBeNull();
    const walls = [];
    for (let s = 0; s < w.buildings.highWater; s++) if (w.buildings.alive[s]) walls.push(s);
    expect(walls.length).toBe(1); // the started (or finished) first tile stays
    expect(w.buildings.cols.tx[walls[0]!]).toBe(10);
    expect(w.submit({ t: 'cancelRun', run: run.id })).toMatch(/no run/);
  });
});

describe('resources', () => {
  it('drain while each tile is built, not at the order; reserved tiles cost nothing', () => {
    const w = new World(1, flatTerrain(40, 40), { waves: false }); // no commander: no income
    w.pool.set([5000, 5000, 0]);
    const e = w.spawnUnit(U.engineer, 1.5, 10.5); // a walk before the first tile is in reach
    w.enqueue({ t: 'buildRun', ids: [e], from: [10, 10], to: [13, 10], depth: 1 });
    w.step();
    const run = onlyRun(w);
    const start = Array.from(w.pool);
    let walked = 0;
    while (runProgress(w, run).started === 0) {
      expect(Array.from(w.pool)).toEqual(start); // laid, reserved, nothing spent
      w.step();
      walked++;
    }
    expect(walked).toBeGreaterThan(5);
    for (let i = 0; i < 4000 && runProgress(w, run).complete < 4; i++) w.step();
    expect(runProgress(w, run).complete).toBe(4);
    const cost = buildingInfo(B.wall).cost;
    // Progress is stored as f32, so the sum of the per-tick shares is exact to about 1e-6 of a build.
    expect(start[0]! - w.pool[0]!).toBeCloseTo(4 * cost[0], 2);
    expect(start[1]! - w.pool[1]!).toBeCloseTo(4 * cost[1], 2);
  });
});
