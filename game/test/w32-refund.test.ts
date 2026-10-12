// W32 (PLAN-W32 tests 1–3): demolish refunds half the mass and rare a building cost (its laid cost and
// every upgrade step, a part-done upgrade at its stored progress), never energy, straight into the
// pool on the completing tick; it takes half the building's build time at the engineers' summed build
// power (with the economy's snap); a temporary turret goes on its first tick of work with no refund;
// the first tick of demolition stops any upgrade or repair on the building; progress is kept when the
// engineers stop and resumes from there.

import { describe, expect, it } from 'vitest';
import { B, U } from '../src/sim/kinds.ts';
import { BF_UPGRADING } from '../src/sim/schema.ts';
import type { World } from '../src/sim/world.ts';
import { setTune, tuneFieldIndex } from '../src/sim/tuning.ts';
import { RESEARCH_INDEX } from '../src/sim/balance.ts';
import { flatWorld } from './fixtures.ts';
import { setTier } from './w31-fixtures.ts';
import {
  alive,
  beltSpent,
  demolish,
  demolishOf,
  demolishTargets,
  demolishedCount,
  gateSpent,
  gunSpent,
  half,
  laidCost,
  orderList,
  refundCounter,
  steps,
  until,
  wallSpent,
  why,
} from './w32-fixtures.ts';

const TICK = 0.1;
const SNAP = 1e-4;
const ENGINEER_RATE = 5;

/** A flat world (no income: no commander, no extractor) with one engineer beside (10, 10). */
function world(opts: { rich?: boolean } = {}) {
  const w = flatWorld(40, 40, { rich: opts.rich ?? true });
  const eng = w.spawnUnit(U.engineer, 10.5, 13.5);
  return { w, eng };
}

const research = (w: World, id: string) => w.completeResearch(RESEARCH_INDEX[id]!);

/**
 * Demolishes `id` with `eng` (in range from the first tick); returns the ticks it took, and the pool
 * and refund-counter changes over the completing tick alone. Asserts the command was accepted and,
 * unless `instant`, that demolition was under way after its first tick.
 */
function demolishOne(w: World, eng: number, id: number, instant = false) {
  const lost0 = w.buildingsLost;
  const done0 = demolishedCount(w);
  expect(why(w.submit(demolish([eng], [id]))), 'demolish accepted').toBe('(accepted)');
  let ticks = 0;
  let pool = Array.from(w.pool);
  let counter = refundCounter(w);
  while (alive(w, id)) {
    pool = Array.from(w.pool);
    counter = refundCounter(w);
    w.step();
    ticks++;
    if (ticks === 1 && !instant) {
      expect(demolishOf(w, id), 'demolish progress after the first tick').toBeGreaterThan(0);
      expect(demolishTargets(w, eng), 'the live demolish order').toEqual([id]);
    }
    if (ticks > 5000) throw new Error('not demolished after 5000 ticks');
  }
  const after = refundCounter(w);
  return {
    ticks,
    pool: [w.pool[0]! - pool[0]!, w.pool[1]! - pool[1]!, w.pool[2]! - pool[2]!],
    counter: [after[0] - counter[0], after[1] - counter[1]],
    lost: w.buildingsLost - lost0,
    demolished: demolishedCount(w) - done0,
  };
}

function expectRefund(r: ReturnType<typeof demolishOne>, want: [number, number, number]) {
  expect(r.lost, 'not counted as lost').toBe(0);
  expect(r.demolished, 'demolished counter').toBe(1);
  expect(r.pool[0], 'mass into the pool on the completing tick').toBeCloseTo(want[0], 6);
  expect(r.pool[1], 'no energy').toBe(0);
  expect(r.pool[2], 'rare into the pool on the completing tick').toBeCloseTo(want[2], 6);
  // the counter isolates the refund from anything else on that tick
  expect(r.counter[0]).toBeCloseTo(want[0], 6);
  expect(r.counter[1]).toBeCloseTo(want[2], 6);
  expect(Math.abs(r.pool[0] - r.counter[0])).toBeLessThan(1e-6);
}

describe('W32 refund amounts (test 1)', () => {
  it('a tier-1 wall: half of 100 mass, no rare, no energy', () => {
    const { w, eng } = world();
    const id = w.placeBuilding(B.wall, 10, 10, true);
    expectRefund(demolishOne(w, eng, id), half(wallSpent(1)));
    expect(half(wallSpent(1))).toEqual([50, 0, 0]);
  });

  it('a tier-3 wall: half of its laid cost and both upgrades (175 mass, 7 rare)', () => {
    const { w, eng } = world();
    const id = w.placeBuilding(B.wall, 10, 10, true);
    w.buildings.cols.tier[w.buildings.slotForId(id)] = 3;
    expectRefund(demolishOne(w, eng, id), half(wallSpent(3)));
    expect(half(wallSpent(3))).toEqual([175, 0, 7]);
  });

  it('a tier-2 gun turret: half of laid plus upgrade (160 mass, 3 rare)', () => {
    const { w, eng } = world();
    const id = w.placeBuilding(B.gun, 10, 10, true);
    w.buildings.cols.tier[w.buildings.slotForId(id)] = 2;
    expectRefund(demolishOne(w, eng, id), half(gunSpent(2)));
  });

  it('a belt laid Fast refunds 1.75 mass; a belt laid Slow and upgraded to Fast refunds the same', () => {
    const a = world();
    const fast = a.w.placeBuilding(B.belt, 10, 10, true, 0);
    setTier(a.w, fast, 3);
    expectRefund(demolishOne(a.w, a.eng, fast), half(beltSpent(3)));
    expect(half(beltSpent(3))[0]).toBe(1.75);

    const b = world();
    research(b.w, 'beltMedium');
    research(b.w, 'beltFast');
    const slow = b.w.placeBuilding(B.belt, 10, 10, true, 0);
    for (const to of [2, 3]) {
      expect(why(b.w.submit({ t: 'upgrade', ids: [b.eng], target: slow }))).toBe('(accepted)');
      until(b.w, () => b.w.buildings.cols.tier[b.w.buildings.slotForId(slow)] === to && !(b.w.buildings.cols.flags[b.w.buildings.slotForId(slow)]! & BF_UPGRADING));
    }
    expectRefund(demolishOne(b.w, b.eng, slow), half(beltSpent(3)));
  });

  it('a splitter, a 2 × 2 smelter and a 3-tile gate: half their laid cost', () => {
    const s = world();
    expectRefund(demolishOne(s.w, s.eng, s.w.placeBuilding(B.splitter, 10, 10, true, 0)), half([10, 20, 0]));
    const m = world();
    const smelter = m.w.placeBuilding(B.smelter, 10, 10, true);
    expectRefund(demolishOne(m.w, m.eng, smelter), half(laidCost('smelter')));
    const g = world();
    const gate = g.w.placeBuilding(B.gate, 9, 10, true, 0, 3, 1);
    expect(gate).toBeGreaterThanOrEqual(0);
    expectRefund(demolishOne(g.w, g.eng, gate), half(gateSpent(3)));
  });

  it('a temporary turret: removed on its first tick of work, refund 0', () => {
    const { w, eng } = world();
    const id = w.placeBuilding(B.tempTurret, 10, 10, true);
    const r = demolishOne(w, eng, id, true);
    expect(r.ticks).toBe(1);
    expectRefund(r, [0, 0, 0]);
  });
});

describe('W32 demolishing mid-upgrade or mid-repair (test 2)', () => {
  /** A tier-1 wall upgrading to tier 2 at `progress`; e2 holds the upgrade (an assist), e1 demolishes; both apply on the same tick. */
  function midUpgrade(progress: number) {
    const w = flatWorld(40, 40, { rich: true });
    research(w, 'wallT2');
    const e1 = w.spawnUnit(U.engineer, 10.5, 13.5);
    const e2 = w.spawnUnit(U.engineer, 11.5, 13.5);
    const id = w.placeBuilding(B.wall, 10, 10, true);
    const s = w.buildings.slotForId(id);
    const c = w.buildings.cols;
    c.flags[s] = c.flags[s]! | BF_UPGRADING;
    c.progress[s] = progress;
    return { w, e1, e2, id, s, c };
  }

  for (const progress of [0.4, 0.995]) {
    it(`an upgrade ${progress * 100}% done: refund 0.5 × (tier-1 cost + stored progress × upgrade cost); the upgrade does not advance from the first demolish tick; its build orders are dropped`, () => {
      const { w, e1, e2, id, s, c } = midUpgrade(progress);
      const p0 = c.progress[s]!; // the stored f32
      expect(why(w.submit({ t: 'assist', ids: [e2], target: id }))).toBe('(accepted)');
      const lost0 = w.buildingsLost;
      const before = refundCounter(w);
      const mass0 = w.pool[0]!;
      expect(why(w.submit(demolish([e1], [id])))).toBe('(accepted)');
      let ticks = 0;
      while (alive(w, id)) {
        w.step();
        ticks++;
        if (!alive(w, id)) break;
        if (ticks === 1) expect(demolishOf(w, id)).toBeGreaterThan(0);
        expect(c.progress[s], `upgrade progress at tick ${ticks}`).toBe(p0);
        expect(c.tier[s]).toBe(1);
        expect(c.flags[s]! & BF_UPGRADING).not.toBe(0);
        if (ticks >= 2) expect(orderList(w, e2).filter((o) => o.t === 'build'), 'the upgrade order dropped').toEqual([]);
        if (ticks > 2000) throw new Error('not demolished');
      }
      const up = [100, 200, 4];
      const want = [0.5 * (wallSpent(1)[0] + p0 * up[0]!), 0.5 * (wallSpent(1)[2] + p0 * up[2]!)];
      const after = refundCounter(w);
      expect(after[0] - before[0]).toBeCloseTo(want[0]!, 6);
      expect(after[1] - before[1]).toBeCloseTo(want[1]!, 6);
      // the only pool change in this world besides the refund is the assist's drain, which never ran
      expect(w.pool[0]! - mass0).toBeCloseTo(want[0]!, 6);
      expect(w.buildingsLost).toBe(lost0);
    });
  }

  it('a damaged wall with a repair order: its hit points do not change from the first demolish tick', () => {
    const w = flatWorld(40, 40, { rich: true });
    const e1 = w.spawnUnit(U.engineer, 10.5, 13.5);
    const e2 = w.spawnUnit(U.engineer, 11.5, 13.5);
    const id = w.placeBuilding(B.wall, 10, 10, true);
    const s = w.buildings.slotForId(id);
    const c = w.buildings.cols;
    c.hp[s] = c.maxHp[s]! * 0.3;
    const hp0 = c.hp[s]!;
    expect(why(w.submit({ t: 'repair', ids: [e2], target: id }))).toBe('(accepted)');
    expect(why(w.submit(demolish([e1], [id])))).toBe('(accepted)');
    let ticks = 0;
    while (alive(w, id)) {
      w.step();
      ticks++;
      if (!alive(w, id)) break;
      expect(c.hp[s], `hp at tick ${ticks}`).toBe(hp0);
      if (ticks >= 2) expect(orderList(w, e2).filter((o) => o.t === 'repair'), 'the repair order dropped').toEqual([]);
      if (ticks > 2000) throw new Error('not demolished');
    }
    expect(ticks).toBe(60);
  });
});

describe('W32 demolish time (test 3)', () => {
  /** Ticks predicted for `time` BP·s of building at `power` BP: half of it, finished with the economy's snap. */
  const predicted = (builtTime: number, power: number) => Math.ceil(((1 - SNAP) * (0.5 * builtTime)) / (power * TICK));

  it('one engineer: a tier-1 wall (60 BP·s built) goes on the tick predicted by half its build time ÷ build rate', () => {
    const { w, eng } = world();
    const id = w.placeBuilding(B.wall, 10, 10, true);
    const r = demolishOne(w, eng, id);
    expect(r.ticks).toBe(predicted(60, ENGINEER_RATE));
    expect(r.ticks).toBe(60);
  });

  it('a tier-3 wall takes half its total build time (60 + 60 + 90 BP·s)', () => {
    const { w, eng } = world();
    const id = w.placeBuilding(B.wall, 10, 10, true);
    w.buildings.cols.tier[w.buildings.slotForId(id)] = 3;
    expect(demolishOne(w, eng, id).ticks).toBe(predicted(210, ENGINEER_RATE));
  });

  it('two engineers: about half the time; a second engineer joining a demolish under way is accepted and speeds it up', () => {
    const a = world();
    const e2 = a.w.spawnUnit(U.engineer, 11.5, 13.5);
    const id = a.w.placeBuilding(B.wall, 10, 10, true);
    expect(why(a.w.submit(demolish([a.eng, e2], [id])))).toBe('(accepted)');
    const both = until(a.w, () => !alive(a.w, id));
    expect(both).toBe(predicted(60, 2 * ENGINEER_RATE));
    expect(Math.abs(both - 30)).toBeLessThanOrEqual(1);

    const b = world();
    const late = b.w.spawnUnit(U.engineer, 11.5, 13.5);
    const wall = b.w.placeBuilding(B.wall, 10, 10, true);
    expect(why(b.w.submit(demolish([b.eng], [wall])))).toBe('(accepted)');
    steps(b.w, 20);
    expect(demolishOf(b.w, wall)).toBeCloseTo(20 / 60, 5);
    expect(why(b.w.submit(demolish([late], [wall]))), 'joining a demolish under way').toBe('(accepted)');
    const rest = until(b.w, () => !alive(b.w, wall));
    expect(20 + rest).toBeLessThan(60);
    expect(rest).toBe(20);
  });

  it('a temporary turret is removed on its first tick of work with the engineer build rate tuned to 0.25', () => {
    const { w, eng } = world();
    setTune(w, 'unit', U.engineer, tuneFieldIndex('unit', 'buildRate'), 0.25);
    const id = w.placeBuilding(B.tempTurret, 10, 10, true);
    expect(demolishOne(w, eng, id, true).ticks).toBe(1);
  });

  it('progress is kept when the engineer is stopped and resumes from that value', () => {
    const { w, eng } = world();
    const id = w.placeBuilding(B.wall, 10, 10, true);
    expect(why(w.submit(demolish([eng], [id])))).toBe('(accepted)');
    steps(w, 20);
    const kept = demolishOf(w, id);
    expect(kept).toBeCloseTo(20 / 60, 5);
    expect(why(w.submit({ t: 'stop', ids: [eng] }))).toBe('(accepted)');
    steps(w, 30);
    expect(alive(w, id)).toBe(true);
    expect(demolishOf(w, id), 'progress kept while nobody works').toBe(kept);
    expect(why(w.submit(demolish([eng], [id])))).toBe('(accepted)');
    w.step();
    expect(demolishOf(w, id)).toBeGreaterThan(kept);
    const rest = until(w, () => !alive(w, id));
    expect(1 + rest).toBe(40);
  });
});
