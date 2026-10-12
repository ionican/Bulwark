// W32 (PLAN-W32 tests 5 and 6): what removing a demolished building does to the world around it, and
// a building destroyed while it is being demolished. Each test first checks that demolition ran (an
// accepted command, demolish progress, a live order) before it checks what followed.

import { describe, expect, it } from 'vitest';
import { A, B, ITEM_NONE, U } from '../src/sim/kinds.ts';
import { CAT_STRUCTURES, GOAL_STRUCTURES, type World } from '../src/sim/world.ts';
import { T_ALIEN, T_BUILDING } from '../src/sim/schema.ts';
import { damageBuilding } from '../src/sim/combat.ts';
import { setTune, tuneFieldIndex } from '../src/sim/tuning.ts';
import { RESEARCH_INDEX } from '../src/sim/balance.ts';
import { flatWorld } from './fixtures.ts';
import { line } from './w31-fixtures.ts';
import { alive, demolish, demolishOf, demolishTargets, demolishedCount, refundCounter, steps, until, why } from './w32-fixtures.ts';

const fast = (w: World, mult = 10) => setTune(w, 'unit', U.engineer, tuneFieldIndex('unit', 'buildRate'), mult);

/** Submits a demolish, steps once and checks it is under way (progress, a live order). */
function start(w: World, eng: number, id: number) {
  expect(why(w.submit(demolish([eng], [id]))), 'demolish accepted').toBe('(accepted)');
  w.step();
  expect(demolishOf(w, id), 'demolish progress').toBeGreaterThan(0);
  expect(demolishTargets(w, eng), 'live demolish order').toEqual([id]);
}

describe('W32 removal effects (test 5)', () => {
  it('a 2 × 2 smelter: its footprint is free ground afterwards; items inside go with it; counted demolished, not lost', () => {
    const w = flatWorld(40, 40, { rich: true });
    const eng = w.spawnUnit(U.engineer, 10.5, 13.5);
    fast(w);
    const id = w.placeBuilding(B.smelter, 10, 10, true);
    const s = w.buildings.slotForId(id);
    w.buildings.cols.inBuf[s] = 3;
    w.buildings.cols.outBuf[s] = 1;
    const lost0 = w.buildingsLost;
    const wrecks0 = w.wrecks.count;
    start(w, eng, id);
    until(w, () => !alive(w, id));
    for (const [x, z] of [[10, 10], [11, 10], [10, 11], [11, 11]]) expect(w.occupancy[z! * 40 + x!], `tile ${x},${z}`).toBe(0);
    expect(w.canPlace(B.smelter, 10, 10)).toBe(true);
    expect(w.buildingsLost).toBe(lost0);
    expect(demolishedCount(w)).toBe(1);
    expect(w.wrecks.count, 'no wreck, no rubble object').toBe(wrecks0);
  });

  it('a belt line into the core: upstream of the removed belt stops delivering; nothing is duplicated; the item on the removed belt is gone', () => {
    const { w, belts, core } = line([1, 1, 1, 1, 1, 1, 1, 1], { fill: true });
    expect(core).toBeGreaterThanOrEqual(0);
    const eng = w.spawnUnit(U.engineer, 7.5, 22.5);
    const c = w.buildings.cols;
    const total = () => belts.reduce((n, id) => n + (alive(w, id) && c.item[w.buildings.slotForId(id)] !== ITEM_NONE ? 1 : 0), 0) + w.delivered[0]!;
    expect(total()).toBe(8);
    const gone = belts[3]!;
    const slot = w.buildings.slotForId(gone);
    start(w, eng, gone);
    let before = total();
    while (alive(w, gone)) {
      before = total();
      w.step();
      if (alive(w, gone)) expect(total(), 'conserved while the belt stands').toBe(before);
    }
    // the slot's columns are not cleared on removal: they read as the belt stood when it went
    const lostItem = c.item[slot] !== ITEM_NONE ? 1 : 0;
    expect(total()).toBe(before - lostItem);
    const upstream = belts.slice(0, 3);
    const onUpstream = () => upstream.reduce((n, id) => n + (c.item[w.buildings.slotForId(id)] !== ITEM_NONE ? 1 : 0), 0);
    const up0 = onUpstream();
    expect(up0).toBeGreaterThan(0);
    const after = total();
    steps(w, 200);
    expect(total(), 'nothing duplicated or lost after the removal').toBe(after);
    expect(onUpstream(), 'upstream items stay on their belts').toBe(up0);
    const delivered = w.delivered[0]!;
    steps(w, 100);
    expect(w.delivered[0], 'upstream delivers nothing').toBe(delivered);
    expect(w.occupancy[20 * w.terrain.w + 7], 'the gap is open ground').toBe(0);
  });

  it('a wall run with a demolished member still completes its remaining sites (the demolished tile stays open)', () => {
    const w = flatWorld(40, 40, { rich: true });
    fast(w);
    const builder = w.spawnUnit(U.engineer, 12.5, 13.5);
    const wrecker = w.spawnUnit(U.engineer, 10.5, 13.5);
    expect(why(w.submit({ t: 'buildRun', ids: [builder], from: [10, 10], to: [15, 10], depth: 1 }))).toBe('(accepted)');
    w.step();
    const at = (x: number) => w.occupancy[10 * 40 + x]! - 1;
    const run = w.runs.find((r) => r !== null)!;
    expect(run.sites.length).toBe(6);
    const done = (id: number) => alive(w, id) && (w.buildings.cols.flags[w.buildings.slotForId(id)]! & 1) !== 0;
    until(w, () => run.sites.some(done));
    const first = run.sites.find(done)!;
    const x0 = w.buildings.cols.tx[w.buildings.slotForId(first)]!;
    expect(run.sites.filter(done).length, 'the run is under way, not finished').toBeLessThan(6);
    start(w, wrecker, first);
    until(w, () => !alive(w, first));
    until(w, () => w.runs.every((r) => r === null), 3000);
    for (let x = 10; x <= 15; x++) if (x !== x0) expect(w.buildings.cols.flags[at(x)]! & 1, `wall at ${x} complete`).toBe(1);
    expect(at(x0), 'the demolished tile is not rebuilt').toBe(-1);
  });

  it('removing the last research station pauses research', () => {
    const w = flatWorld(40, 40, { rich: true });
    fast(w);
    const eng = w.spawnUnit(U.engineer, 11.5, 14.5);
    const lab = w.placeBuilding(B.lab, 10, 10, true);
    w.researchQueue.push(RESEARCH_INDEX.wallT2!);
    steps(w, 5);
    expect(w.researchProgress).toBeGreaterThan(0);
    start(w, eng, lab);
    until(w, () => !alive(w, lab));
    w.step();
    const p = w.researchProgress;
    steps(w, 50);
    expect(w.researchRate).toBe(0);
    expect(w.researchProgress, 'research paused').toBe(p);
  });

  it('aliens re-target: the one structure goal gone, the structures field falls back and no alien keeps the building as its target', () => {
    const w = flatWorld(40, 40, { rich: true });
    fast(w, 2);
    const eng = w.spawnUnit(U.engineer, 20.5, 23.5);
    const wall = w.placeBuilding(B.wall, 20, 20, true);
    const s = w.buildings.slotForId(wall);
    w.buildings.cols.maxHp[s] = 1e7;
    w.buildings.cols.hp[s] = 1e7;
    w.spawnAlien(A.breaker, 20.5, 16.5);
    steps(w, 2);
    expect(w.fieldGoal[CAT_STRUCTURES]).toBe(GOAL_STRUCTURES);
    const ac = w.aliens.cols;
    until(w, () => ac.tType[0] === T_BUILDING && ac.tId[0] === wall, 400);
    start(w, eng, wall);
    until(w, () => !alive(w, wall));
    steps(w, 3);
    expect(w.fieldGoal[CAT_STRUCTURES], 'the structures field fell back').not.toBe(GOAL_STRUCTURES);
    expect(ac.tType[0] === T_BUILDING && ac.tId[0] === wall, 'the alien no longer targets the removed wall').toBe(false);
    expect(w.buildingsLost).toBe(0);
    expect(demolishedCount(w)).toBe(1);
  });
});

describe('W32 destroyed mid-demolish (test 6)', () => {
  it('aliens destroy a building being demolished: no refund, counted lost, the demolish orders dropped', () => {
    const w = flatWorld(40, 40, { rich: true });
    const eng = w.spawnUnit(U.engineer, 10.5, 13.5);
    const id = w.placeBuilding(B.wall, 10, 10, true);
    start(w, eng, id);
    steps(w, 10);
    expect(demolishOf(w, id)).toBeGreaterThan(0);
    const refund0 = refundCounter(w);
    const lost0 = w.buildingsLost;
    // an alien's hit, through the function alien shots land with
    damageBuilding(w, w.buildings.slotForId(id), 1e9, T_ALIEN, A.breaker);
    w.step();
    expect(alive(w, id)).toBe(false);
    expect(refundCounter(w)).toEqual(refund0);
    expect(w.buildingsLost).toBe(lost0 + 1);
    expect(demolishedCount(w)).toBe(0);
    w.step();
    expect(demolishTargets(w, eng)).toEqual([]);
  });

  it('lethal sandbox damage on the tick demolition would have completed: no refund, not demolished, counted lost', () => {
    const make = () => {
      const w = flatWorld(40, 40, { rich: true });
      w.scenario = 'sandbox';
      const eng = w.spawnUnit(U.engineer, 10.5, 13.5);
      const id = w.placeBuilding(B.wall, 10, 10, true);
      return { w, eng, id };
    };
    // the control: undisturbed, it completes on tick T
    const a = make();
    start(a.w, a.eng, a.id);
    until(a.w, () => !alive(a.w, a.id));
    const T = a.w.tick - 1;
    expect(demolishedCount(a.w)).toBe(1);
    expect(refundCounter(a.w)[0]).toBe(50);
    const b = make();
    start(b.w, b.eng, b.id);
    b.w.enqueue({ t: 'damage', target: b.id, amount: 1e9 }, T);
    const lost0 = b.w.buildingsLost;
    until(b.w, () => b.w.tick > T);
    expect(alive(b.w, b.id)).toBe(false);
    expect(refundCounter(b.w)).toEqual([0, 0]);
    expect(demolishedCount(b.w)).toBe(0);
    expect(b.w.buildingsLost).toBe(lost0 + 1);
  });
});
