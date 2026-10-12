// W29 (PLAN-W29 items 4, 5, 9, 15): items travel by belt to the core at the existing conveyor rate
// and enter the pool when the core takes them; the pool is conserved; the core takes mass and rare
// only; a cut belt stops delivery until the tile is laid again.

import { describe, expect, it } from 'vitest';
import { B, COMMANDER_INCOME, ITEM_MASS, ITEM_SALVAGE, U } from '../src/sim/kinds.ts';
import { BF_IDLE } from '../src/sim/schema.ts';
import { FAST, ROW, beltLine, itemsOnBelts, slot, steps } from './w29-fixtures.ts';

/** Ticks from an item's insertion on the first belt tile to its delivery, for a belt of n tiles. */
function travelTicks(n: number): number {
  const { w, belts } = beltLine(n, { mapW: n + 20 });
  const first = slot(w, belts[0]!);
  const c = w.buildings.cols;
  let inserted = -1;
  for (let t = 0; t < 400; t++) {
    const tick = w.tick;
    const before = w.delivered[0]!;
    w.step();
    if (inserted < 0 && c.item[first] === ITEM_MASS) inserted = tick;
    if (w.delivered[0]! > before) return tick - inserted;
  }
  return -1;
}

describe('W29 delivery by belt', () => {
  it('travel is measured from insertion and keeps the conveyor rate: 3 ticks per tile (10 tiles 3 s, 51 tiles 15.3 s)', () => {
    expect(travelTicks(10)).toBe(30);
    expect(travelTicks(51)).toBe(153);
    expect(travelTicks(1)).toBe(3);
  });

  it('a delivered item enters the pool when the core takes it, one mass per item', () => {
    const { w } = beltLine(10);
    const pool0 = w.pool[0]!;
    steps(w, 9 + 30); // the first item is put on the belt at tick 9 and taken at tick 39
    expect(w.delivered[0]).toBe(0);
    expect(w.pool[0]).toBe(pool0);
    w.step();
    expect(w.delivered[0]).toBe(1);
    expect(w.pool[0]).toBe(pool0 + 1);
  });

  it('conservation over 60 s, tick-aligned: pool change = delivered + commander income − exact spending; delivered = dug − buffer − belt', () => {
    const { w, extractor, coreX } = beltLine(12);
    w.spawnUnit(U.commander, coreX + 5.5, ROW + 6.5);
    steps(w, 50);
    // something to spend on: a generator site the commander builds during the window
    w.enqueue({ t: 'build', ids: [w.commanderId], kind: B.generator, tx: coreX + 4, ty: ROW + 8 });
    const p0 = w.pool[0]!;
    const d0 = w.delivered[0]!;
    const s0 = w.spentTotal[0]!;
    for (let t = 0; t < 600; t++) w.step();
    const spent = w.spentTotal[0]! - s0;
    expect(spent).toBeGreaterThan(0);
    const delivered = w.delivered[0]! - d0;
    expect(delivered).toBeGreaterThan(50);
    expect(w.pool[0]! - p0).toBeCloseTo(delivered + COMMANDER_INCOME[0] * 60 - spent, 6);
    const buffer = w.buildings.cols.stock[slot(w, extractor)]!;
    expect(w.delivered[0]).toBeCloseTo(w.dug[0]! - buffer - itemsOnBelts(w, ITEM_MASS), 3);
    // incomeRate counts delivered mass (10 s rolling) plus the commander
    expect(w.incomeRate[0]).toBeCloseTo(1 + COMMANDER_INCOME[0], 6);
  });

  it('rare items arrive and add rare', () => {
    const { w } = beltLine(10, { kind: 'rare' });
    const r0 = w.pool[2]!;
    steps(w, 400);
    expect(w.delivered[1]).toBeGreaterThanOrEqual(9);
    expect(w.pool[2]).toBe(r0 + w.delivered[1]!);
    expect(w.delivered[0]).toBe(0);
    expect(w.pool[0]).toBe(beltLine(10, { kind: 'rare' }).w.pool[0]);
  });

  it('a salvage item reaching the core is refused and the belt backs up', () => {
    const { w, belts, extractor } = beltLine(10);
    const last = slot(w, belts[belts.length - 1]!);
    const c = w.buildings.cols;
    c.item[last] = ITEM_SALVAGE;
    c.itemPos[last] = 0;
    steps(w, 300);
    expect(c.item[last]).toBe(ITEM_SALVAGE);
    expect(c.itemPos[last]).toBe(1);
    expect(w.delivered[0]).toBe(0);
    expect(itemsOnBelts(w, ITEM_MASS)).toBe(belts.length - 1);
    expect(c.stock[slot(w, extractor)]).toBeGreaterThan(15);
  });

  it('a belt cut stops delivery; the buffer fills; laying the tile again resumes delivery and the stored output flows out', () => {
    const { w, belts, extractor } = beltLine(10);
    steps(w, 200);
    expect(w.delivered[0]).toBeGreaterThan(10);
    const cut = slot(w, belts[4]!);
    const cx = w.buildings.cols.tx[cut]!;
    // destroyed by damage (as under alien fire): removed at 0 hp, its item lost
    w.buildings.cols.hp[cut] = 0;
    w.step();
    expect(w.buildings.slotForId(belts[4]!)).toBe(-1);
    steps(w, 30); // what was past the gap drains
    const stopped = w.delivered[0]!;
    steps(w, 2000);
    expect(w.delivered[0]).toBe(stopped);
    const s = slot(w, extractor);
    expect(w.buildings.cols.stock[s]).toBe(180);
    expect(w.buildings.cols.flags[s]! & BF_IDLE).not.toBe(0);
    expect(w.placeBuilding(B.belt, cx, ROW, true, 0, undefined, undefined, FAST)).toBeGreaterThanOrEqual(0);
    steps(w, 300);
    // 30 s: more than the 30 items one extractor digs, because the stored output flows out at belt speed
    expect(w.delivered[0]! - stopped).toBeGreaterThan(60);
    expect(w.buildings.cols.stock[s]).toBeLessThan(150);
  });

  it('the core takes one item per input cell per tick: two belts into two cells deliver on the same tick', () => {
    const { w, belts, coreX } = beltLine(10);
    // a second line into the core's west face one row down; the last five tiles of both lines loaded by hand
    const second: number[] = [];
    for (let x = coreX - 5; x < coreX; x++) second.push(w.placeBuilding(B.belt, x, ROW + 1, true, 0, undefined, undefined, FAST));
    const c = w.buildings.cols;
    for (const id of [...second, ...belts.slice(-5)]) {
      c.item[slot(w, id)] = ITEM_MASS;
      c.itemPos[slot(w, id)] = 0;
    }
    steps(w, 2);
    expect(w.delivered[0]).toBe(0);
    w.step();
    expect(w.delivered[0]).toBe(2);
    steps(w, 12);
    expect(w.delivered[0]).toBe(10);
  });
});
