// W25 acceptance 1–4 (build queue, Supreme Commander style). Each unit has its own order queue; an
// order goes onto the queue of every unit it was given to, and units that share an item build it
// together, each when it reaches that item. Shift (queue: true) appends, no Shift replaces. When
// an order is replaced or removed (dequeue, clearQueue), a reserved site that no unit has queued
// any more is removed; a started site stays; a wall run with no builders left keeps its started
// tiles and loses its reserved ones.

import { describe, expect, it } from 'vitest';
import { MAX_ORDERS, World } from '../src/sim/world.ts';
import { B, U } from '../src/sim/kinds.ts';
import { BF_COMPLETE, BF_STARTED, isReserved } from '../src/sim/schema.ts';
import { SimRunner, type CommandResult } from '../src/sim/runner.ts';
import { runById } from '../src/sim/runs.ts';
import type { Command } from '../src/sim/commands.ts';
import type { Order } from '../src/sim/units.ts';
import { flatWorld } from './fixtures.ts';

const flat = () => flatWorld(48, 48, { rich: true });
const slot = (w: World, id: number) => w.units.slotForId(id);
const ordersOf = (w: World, id: number): Order[] => w.orders[slot(w, id)] ?? [];
const exists = (w: World, site: number) => w.buildings.slotForId(site) >= 0;
/** W25c: the id of order `index` in unit `id`'s queue (dequeue names it). */
const oidAt = (w: World, id: number, index: number) => ordersOf(w, id)[index]!.oid;
const flagsOf = (w: World, site: number) => w.buildings.cols.flags[w.buildings.slotForId(site)]!;
/** Building ids of a unit's build orders, in queue order. */
const buildIds = (w: World, id: number) => ordersOf(w, id).map((o) => (o.t === 'build' ? o.id : o.t === 'run' ? -o.run : NaN));
const siteAt = (w: World, tx: number, ty: number) => {
  const s = w.occupancy[ty * w.terrain.w + tx]! - 1;
  return s < 0 ? -1 : w.buildings.id(s);
};

/** Submits (validated) and runs one tick so the command applies; fails the test on a refusal. */
function apply(w: World, cmd: Command): void {
  const why = w.submit(cmd);
  if (why) throw new Error(`refused: ${why}`);
  const rejected = w.applyRejected.length;
  w.step();
  if (w.applyRejected.length !== rejected) throw new Error(`refused at its tick: ${w.applyRejected[w.applyRejected.length - 1]!.reason}`);
}

/** A build order through the command path; returns the new site's id. */
function build(w: World, ids: number[], kind: number, tx: number, ty: number, queue: boolean): number {
  apply(w, { t: 'build', ids, kind, tx, ty, queue });
  const site = siteAt(w, tx, ty);
  expect(site, `site at ${tx},${ty}`).toBeGreaterThanOrEqual(0);
  return site;
}

describe('W25 acceptance 1: ownership', () => {
  it('A and B share X; A alone gets Y and Z, B alone gets W: each builds its own queue in order and both build X', () => {
    const w = flat();
    const a = w.spawnUnit(U.engineer, 6.5, 10.5);
    const b = w.spawnUnit(U.engineer, 6.5, 13.5);
    const X = build(w, [a, b], B.gun, 10, 10, false);
    const Y = build(w, [a], B.gun, 16, 8, true);
    const Z = build(w, [a], B.gun, 22, 8, true);
    const W_ = build(w, [b], B.gun, 16, 16, true);
    expect(buildIds(w, a)).toEqual([X, Y, Z]);
    expect(buildIds(w, b)).toEqual([X, W_]);
    // Follow each unit's work target (units.ts sets `work` = site id + 1 while it adds build power).
    const worked = new Map<number, number[]>([
      [a, []],
      [b, []],
    ]);
    // Gun: 150 BP·s; one engineer 5 BP/s, so about 30 s alone; 4,000 ticks is ample for all four.
    for (let t = 0; t < 4000; t++) {
      w.step();
      for (const u of [a, b]) {
        const target = w.units.cols.work[slot(w, u)]! - 1;
        const seq = worked.get(u)!;
        if (target >= 0 && seq[seq.length - 1] !== target) seq.push(target);
      }
      if (!ordersOf(w, a).length && !ordersOf(w, b).length) break;
    }
    for (const site of [X, Y, Z, W_]) expect(flagsOf(w, site) & BF_COMPLETE, `site ${site} complete`).toBeTruthy();
    expect(worked.get(a)).toEqual([X, Y, Z]);
    expect(worked.get(b)).toEqual([X, W_]);
  });
});

describe('W25 acceptance 2: no Shift replaces, and orphaned reserved sites go', () => {
  it('A has X, Y, Z reserved and alone: an unshifted order leaves A only the new order and removes X, Y and Z', () => {
    const w = flat();
    const a = w.spawnUnit(U.engineer, 40.5, 40.5); // far away: nothing starts
    const X = build(w, [a], B.gun, 6, 6, true);
    const Y = build(w, [a], B.gun, 10, 6, true);
    const Z = build(w, [a], B.gun, 14, 6, true);
    for (const s of [X, Y, Z]) expect(isReserved(flagsOf(w, s))).toBe(true);
    const before = w.buildings.count;
    apply(w, { t: 'move', ids: [a], x: 30.5, z: 30.5 });
    expect(ordersOf(w, a)).toEqual([{ t: 'move', x: 30.5, z: 30.5, oid: expect.any(Number) }]);
    for (const s of [X, Y, Z]) expect(exists(w, s), `site ${s} removed`).toBe(false);
    expect(w.buildings.count).toBe(before - 3);
    expect(w.occupancy[6 * w.terrain.w + 6]).toBe(0); // the tiles are free again
    expect(w.submit({ t: 'build', ids: [a], kind: B.gun, tx: 6, ty: 6 })).toBeNull();
  });

  it('a started site stays, a site another unit also has queued stays, a site only A held goes', () => {
    const w = flat();
    const a = w.spawnUnit(U.engineer, 9.5, 9.5);
    const b = w.spawnUnit(U.engineer, 46.5, 46.5);
    apply(w, { t: 'move', ids: [b], x: 1.5, z: 46.5 }); // B is busy first (45 tiles: 9 s), so T stays reserved
    const S = build(w, [a], B.gun, 10, 10, true); // A stands next to S: it starts at once
    const T = build(w, [a, b], B.gun, 20, 20, true);
    const U_ = build(w, [a], B.gun, 26, 20, true);
    for (let t = 0; t < 20; t++) w.step();
    expect(flagsOf(w, S) & BF_STARTED).toBeTruthy();
    expect(flagsOf(w, S) & BF_COMPLETE).toBeFalsy();
    expect(isReserved(flagsOf(w, T))).toBe(true);
    expect(isReserved(flagsOf(w, U_))).toBe(true);
    // An unshifted build replaces A's queue.
    const V = build(w, [a], B.wall, 4, 30, false);
    expect(buildIds(w, a)).toEqual([V]);
    expect(exists(w, S)).toBe(true); // started: stays as a part-built structure
    expect(exists(w, T)).toBe(true); // B still has it queued
    expect(exists(w, U_)).toBe(false);
    expect(ordersOf(w, b).map((o) => o.t)).toEqual(['move', 'build']);
    expect(buildIds(w, b)[1]).toBe(T);
  });

  it('a wall run that loses all its builders keeps its started tiles; its reserved tiles go', () => {
    const w = flat();
    const a = w.spawnUnit(U.engineer, 9.5, 20.5);
    apply(w, { t: 'buildRun', ids: [a], from: [10, 20], to: [19, 20], depth: 1 });
    const run = w.runs.find((r) => r !== null)!;
    const sites = [...run.sites];
    expect(sites.length).toBe(10);
    // Run until the first tile is complete and the second started.
    for (let t = 0; t < 600 && !(flagsOf(w, sites[1]!) & BF_STARTED); t++) w.step();
    const started = sites.filter((s) => exists(w, s) && !isReserved(flagsOf(w, s)));
    const reserved = sites.filter((s) => exists(w, s) && isReserved(flagsOf(w, s)));
    expect(started.length).toBeGreaterThanOrEqual(2);
    expect(reserved.length).toBeGreaterThan(0);
    apply(w, { t: 'move', ids: [a], x: 5.5, z: 30.5 });
    for (const s of started) expect(exists(w, s), `started tile ${s} stays`).toBe(true);
    for (const s of reserved) expect(exists(w, s), `reserved tile ${s} removed`).toBe(false);
    expect(runById(w, run.id)).toBeNull();
  });

  it('a run another unit still works on keeps its reserved tiles', () => {
    const w = flat();
    const a = w.spawnUnit(U.engineer, 9.5, 20.5);
    const b = w.spawnUnit(U.engineer, 9.5, 22.5);
    apply(w, { t: 'buildRun', ids: [a, b], from: [10, 20], to: [19, 20], depth: 1 });
    const run = w.runs.find((r) => r !== null)!;
    apply(w, { t: 'move', ids: [a], x: 5.5, z: 30.5 });
    expect(run.sites.every((s) => exists(w, s))).toBe(true);
    expect(runById(w, run.id)).not.toBeNull();
  });

  it('decision: an orphaned reserved gate site stays (its walls were already converted)', () => {
    const w = flat();
    for (let x = 10; x <= 14; x++) w.placeBuilding(B.wall, x, 20, true);
    const a = w.spawnUnit(U.engineer, 40.5, 40.5);
    apply(w, { t: 'gate', ids: [a], tx: 12, ty: 20 });
    const gate = siteAt(w, 12, 20);
    expect(isReserved(flagsOf(w, gate))).toBe(true);
    apply(w, { t: 'move', ids: [a], x: 30.5, z: 30.5 });
    expect(exists(w, gate)).toBe(true);
  });

  it('stop clears the queue by the same rule (W25b, Richard 9 Oct: "stop should clear them"): the orphaned reserved site goes', () => {
    const w = flat();
    const a = w.spawnUnit(U.engineer, 40.5, 40.5);
    const X = build(w, [a], B.gun, 6, 6, true);
    apply(w, { t: 'stop', ids: [a] });
    expect(ordersOf(w, a)).toEqual([]);
    expect(exists(w, X)).toBe(false);
  });
});

describe('W25 acceptance 3: dequeue and clearQueue', () => {
  function threeQueued() {
    const w = flat();
    const a = w.spawnUnit(U.engineer, 40.5, 40.5);
    const X = build(w, [a], B.gun, 6, 6, true);
    const Y = build(w, [a], B.gun, 10, 6, true);
    const Z = build(w, [a], B.gun, 14, 6, true);
    return { w, a, X, Y, Z };
  }

  it('removing Y from A leaves X then Z, and Y’s orphaned site is removed', () => {
    const { w, a, X, Y, Z } = threeQueued();
    apply(w, { t: 'dequeue', id: a, order: oidAt(w, a, 1) });
    expect(buildIds(w, a)).toEqual([X, Z]);
    expect(exists(w, Y)).toBe(false);
    expect(exists(w, X) && exists(w, Z)).toBe(true);
  });

  it('a dequeued site another unit holds stays', () => {
    const { w, a, Y } = threeQueued();
    const b = w.spawnUnit(U.engineer, 44.5, 44.5);
    apply(w, { t: 'move', ids: [b], x: 46.5, z: 46.5 });
    apply(w, { t: 'assist', ids: [b], target: Y, queue: true });
    apply(w, { t: 'dequeue', id: a, order: oidAt(w, a, 1) });
    expect(exists(w, Y)).toBe(true);
  });

  it('dequeue names the order (W25c: by its id): when the queue moved on before the command ran, the same order is removed', () => {
    const { w, a, X, Y, Z } = threeQueued();
    // The render thread saw [X, Y, Z] and asks for Y (then at index 1); X is gone before the tick runs.
    const y = oidAt(w, a, 1);
    expect(w.submit({ t: 'dequeue', id: a, order: y })).toBeNull();
    w.orders[slot(w, a)]!.shift();
    w.removeBuilding(w.buildings.slotForId(X));
    w.step();
    expect(buildIds(w, a)).toEqual([Z]);
    expect(exists(w, Y)).toBe(false);
    // Asking for an order that is no longer queued is refused.
    expect(w.submit({ t: 'dequeue', id: a, order: y })).toMatch(/no longer|not in/);
  });

  it('removing the current order (index 0) moves the unit on to the next', () => {
    const { w, a, Y, Z } = threeQueued();
    apply(w, { t: 'dequeue', id: a, order: oidAt(w, a, 0) });
    expect(buildIds(w, a)).toEqual([Y, Z]);
    expect(w.pathKey[slot(w, a)]).toBe(`b${Y}`); // the path was planned afresh, to Y
  });

  it('clearQueue empties the queue under the same rule', () => {
    const { w, a, X, Y, Z } = threeQueued();
    const b = w.spawnUnit(U.engineer, 44.5, 44.5);
    apply(w, { t: 'move', ids: [b], x: 46.5, z: 46.5 });
    apply(w, { t: 'assist', ids: [b], target: Z, queue: true });
    apply(w, { t: 'clearQueue', ids: [a] });
    expect(ordersOf(w, a)).toEqual([]);
    expect(exists(w, X) || exists(w, Y)).toBe(false);
    expect(exists(w, Z)).toBe(true); // B still has it
    apply(w, { t: 'clearQueue', ids: [a, b] });
    expect(exists(w, Z)).toBe(false);
  });

  it('an invalid order id or unit id is refused with a reason', () => {
    const { w, a } = threeQueued();
    expect(w.submit({ t: 'dequeue', id: a, order: 999 })).toMatch(/no order 999/);
    expect(w.submit({ t: 'dequeue', id: a, order: -1 })).toMatch(/order id/);
    expect(w.submit({ t: 'dequeue', id: a, order: 0.5 })).toMatch(/order id/);
    expect(w.submit({ t: 'dequeue', id: 999_999, order: oidAt(w, a, 0) })).toMatch(/unit/);
    expect(w.submit({ t: 'clearQueue', ids: [a, 999_999] })).toMatch(/unit/);
    expect(w.submit({ t: 'clearQueue', ids: [] })).toMatch(/ids/);
    expect(w.submit({ t: 'clearQueue', ids: 'x' as unknown as number[] })).toMatch(/ids/);
  });

  it('a dequeue valid when sent but not at its tick is refused through the final-result path', () => {
    const { w, a } = threeQueued();
    const runner = new SimRunner(w, 0);
    const results: CommandResult[] = [];
    runner.onResult = (r) => results.push(r);
    const z = oidAt(w, a, 2);
    expect(runner.submitTracked({ t: 'dequeue', id: a, order: z }, 1)).toBeNull();
    expect(runner.submitTracked({ t: 'dequeue', id: a, order: z }, 2)).toBeNull();
    runner.stepOnce();
    expect(results.map((r) => [r.ref, r.ok])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(results[1]!.reason).toMatch(/completed or removed/);
  });
});

describe('W25 acceptance 4: Shift on every order kind', () => {
  /** A world with an engineer holding two move orders, and what each order kind needs. */
  function setup() {
    const w = flat();
    w.debug.allTiers = true; // wall tier 2 without research (upgrade)
    const a = w.spawnUnit(U.engineer, 30.5, 30.5);
    for (let x = 10; x <= 14; x++) w.placeBuilding(B.wall, x, 20, true); // gate fixture
    const upgradeTarget = w.placeBuilding(B.wall, 30, 4, true);
    const site = w.placeBuilding(B.gun, 36, 10, false); // a site to assist (nobody holds it)
    w.addWreck(0, 26.5, 36.5, 30);
    const wreck = w.wrecks.id(0);
    apply(w, { t: 'move', ids: [a], x: 40.5, z: 30.5 });
    apply(w, { t: 'move', ids: [a], x: 40.5, z: 34.5, queue: true });
    return { w, a, upgradeTarget, site, wreck };
  }
  const CASES: Array<[string, (f: ReturnType<typeof setup>, queue: boolean) => Command]> = [
    ['build', (f, queue) => ({ t: 'build', ids: [f.a], kind: B.wall, tx: 4, ty: 4, queue })],
    ['buildRun', (f, queue) => ({ t: 'buildRun', ids: [f.a], from: [4, 40], to: [8, 40], depth: 1, queue })],
    ['gate', (f, queue) => ({ t: 'gate', ids: [f.a], tx: 12, ty: 20, queue })],
    ['upgrade', (f, queue) => ({ t: 'upgrade', ids: [f.a], target: f.upgradeTarget, queue })],
    ['move', (f, queue) => ({ t: 'move', ids: [f.a], x: 20.5, z: 20.5, queue })],
    ['assist', (f, queue) => ({ t: 'assist', ids: [f.a], target: f.site, queue })],
    ['reclaim', (f, queue) => ({ t: 'reclaim', ids: [f.a], wreck: f.wreck, queue })],
  ];
  const KIND: Record<string, Order['t']> = { build: 'build', buildRun: 'run', gate: 'build', upgrade: 'build', move: 'move', assist: 'build', reclaim: 'reclaim' };

  for (const [name, make] of CASES) {
    it(`${name}: queue: true appends after the two moves; without it the queue is replaced`, () => {
      const f = setup();
      expect(ordersOf(f.w, f.a).map((o) => o.t)).toEqual(['move', 'move']);
      apply(f.w, make(f, true));
      expect(ordersOf(f.w, f.a).map((o) => o.t)).toEqual(['move', 'move', KIND[name]]);
      const g = setup();
      apply(g.w, make(g, false));
      expect(ordersOf(g.w, g.a).map((o) => o.t)).toEqual([KIND[name]]);
    });
  }

  it('the queue holds at most MAX_ORDERS and a full queue refuses a queued order', () => {
    const w = flat();
    const a = w.spawnUnit(U.engineer, 30.5, 30.5);
    for (let i = 0; i < MAX_ORDERS; i++) w.enqueue({ t: 'move', ids: [a], x: 1.5 + (i % 40), z: 1.5, queue: true });
    w.step();
    expect(ordersOf(w, a).length).toBe(MAX_ORDERS);
    expect(w.submit({ t: 'move', ids: [a], x: 5.5, z: 5.5, queue: true })).toMatch(/queue full/);
  });
});
