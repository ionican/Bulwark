// W31 (PLAN-W31 tests 1–5): three belt speeds, defined as whole ticks per tile at 10 ticks/s:
// Slow 6, Medium 4, Fast 3 (Fast is build 170's belt, tick for tick). A belt tile's speed is its
// tier (1 Slow, 2 Medium, 3 Fast). Speed is crossing time, not throughput: a producer-fed line
// delivers one item per crossing time plus the one-tick producer refill. A mixed line moves at its
// slowest tile. Splitters and mergers have no tiers and move items at the Fast rate.

import { describe, expect, it } from 'vitest';
import { B, ITEM_MASS, ITEM_NONE } from '../src/sim/kinds.ts';
import type { World } from '../src/sim/world.ts';
import { beltLine, slot } from './w29-fixtures.ts';
import { flatWorld } from './fixtures.ts';
import { ROW, X0, deliveries, gaps, itemsOn, line, putItem, setTier } from './w31-fixtures.ts';

const NAMES = ['', 'Slow', 'Medium', 'Fast'];
const TICKS = [0, 6, 4, 3];
const STEP = [0, 1 / 6, 0.25, 0.4];
/**
 * Fast's stored positions on build 170 (commit 2f6fd0b), measured by stepping that tree: an item
 * entering a tile reads 0, then 0.4 and 0.8 (f32), then is on the next tile at 0.
 */
const MAIN_FAST_POSITIONS = [0, 0.4000000059604645, 0.800000011920929];

/** For an item put on the first tile now: the tick it entered each tile, and its stored position on every tick. */
function trace(w: World, ids: number[], ticks: number) {
  const c = w.buildings.cols;
  const entered: number[] = new Array(ids.length).fill(-1);
  const positions: number[][] = ids.map(() => []);
  entered[0] = w.tick;
  positions[0]!.push(c.itemPos[slot(w, ids[0]!)]!);
  for (let t = 0; t < ticks; t++) {
    const tick = w.tick;
    w.step();
    ids.forEach((id, k) => {
      const s = slot(w, id);
      if (c.item[s] === ITEM_NONE) return;
      if (entered[k] === -1) entered[k] = tick;
      positions[k]!.push(c.itemPos[s]!);
    });
  }
  return { entered, positions };
}

describe('W31 crossing time (test 1)', () => {
  for (const tier of [1, 2, 3]) {
    it(`${NAMES[tier]}: an item entering a tile enters the next after exactly ${TICKS[tier]} ticks, its stored (f32) position rising by ${STEP[tier]!.toFixed(4)} a tick`, () => {
      const { w, belts } = line([tier, tier, tier, tier, tier, tier]);
      putItem(w, belts[0]!, ITEM_MASS);
      const { entered, positions } = trace(w, belts, 40);
      expect(entered.every((t) => t >= 0), `the item reached every tile: ${entered}`).toBe(true);
      const crossings = entered.slice(1).map((t, k) => t - entered[k]!);
      expect(crossings).toEqual(new Array(belts.length - 1).fill(TICKS[tier]));
      // the positions on a middle tile, as stored: f32 sums of the step, from 0 until the item moves on
      const want: number[] = [0];
      for (let k = 1; k < TICKS[tier]!; k++) want.push(Math.fround(Math.min(1, want[k - 1]! + STEP[tier]!)));
      expect(positions[2]).toEqual(want);
      // and the step that would follow the last one reaches the end of the tile (no seventh tick for Slow)
      expect(Math.fround(Math.min(1, want[want.length - 1]! + STEP[tier]!))).toBe(1);
    });
  }

  it('Fast is build 170’s belt tick for tick: positions 0, 0.4, 0.8 (f32), 3 ticks a tile (commit 2f6fd0b)', () => {
    const { w, belts } = line([3, 3, 3, 3]);
    putItem(w, belts[0]!, ITEM_MASS);
    const { positions } = trace(w, belts, 12);
    expect(positions[1]).toEqual(MAIN_FAST_POSITIONS);
    expect(positions[2]).toEqual(MAIN_FAST_POSITIONS);
  });
});

describe('W31 saturated capacity (test 2)', () => {
  for (const tier of [1, 2, 3]) {
    it(`${NAMES[tier]}: a pre-filled 80-tile line into an always-accepting core delivers one item every ${TICKS[tier]} ticks after a 10 s warm-up`, () => {
      const { w } = line(new Array(80).fill(tier), { fill: true, mapW: 100 });
      deliveries(w, 100);
      const d = deliveries(w, 120);
      expect(d.length).toBeGreaterThan(10);
      expect(new Set(gaps(d))).toEqual(new Set([TICKS[tier]]));
    });
  }
});

describe('W31 producer-fed throughput (test 3)', () => {
  /**
   * One mass extractor (its buffer held full) feeding a one-tile line into the core: producers run
   * before belts, so the extractor refills the tile one tick after it empties. On build 170 (commit
   * 2f6fd0b) the author measured this fixture at 150 items in 60 s, deliveries 4 ticks apart.
   */
  const WANT = [0, { gap: 7, count: 86 }, { gap: 5, count: 120 }, { gap: 4, count: 150 }] as const;
  for (const tier of [1, 2, 3] as const) {
    it(`${NAMES[tier]}: deliveries exactly ${WANT[tier].gap} ticks apart, ${WANT[tier].count} ± 1 in 60 s`, () => {
      const { w, belts, extractor } = beltLine(1);
      setTier(w, belts[0]!, tier);
      const s = slot(w, extractor);
      const full = () => {
        w.buildings.cols.stock[s] = 180;
      };
      deliveries(w, 100, full);
      const d = deliveries(w, 600, full);
      expect(new Set(gaps(d))).toEqual(new Set([WANT[tier].gap]));
      expect(Math.abs(d.length - WANT[tier].count)).toBeLessThanOrEqual(1);
    });
  }
});

describe('W31 mixed line (test 4)', () => {
  it('Fast → Slow → Fast and all-Slow, saturated: the same leave rate (Slow’s, one per 6 ticks); no item lost or duplicated', () => {
    const mixed = [...new Array(40).fill(3), ...new Array(5).fill(1), ...new Array(5).fill(3)];
    const slow = new Array(50).fill(1);
    const rates: number[][] = [];
    for (const tiers of [mixed, slow]) {
      const { w, belts } = line(tiers, { fill: true, mapW: 70 });
      const total = belts.length;
      for (let t = 0; t < 100; t++) {
        w.step();
        expect(itemsOn(w, belts) + w.delivered[0]!, `items conserved at tick ${w.tick}`).toBe(total);
      }
      const d = deliveries(w, 120);
      expect(itemsOn(w, belts) + w.delivered[0]!).toBe(total);
      rates.push(gaps(d));
    }
    expect(new Set(rates[0])).toEqual(new Set([6]));
    expect(rates[0]).toEqual(rates[1]);
  });
});

describe('W31 junctions (test 5)', () => {
  /** Slow belt → junction → Slow belt along +x (a splitter turns items to its sides: belts north and south of it). */
  function junction(kind: number) {
    const w = flatWorld(30, 30, { belts: true });
    const z = 10;
    const ids: number[] = [];
    ids.push(w.placeBuilding(B.belt, 5, z, true, 0));
    ids.push(w.placeBuilding(kind, 6, z, true, 0));
    if (kind === B.splitter) {
      ids.push(w.placeBuilding(B.belt, 6, z + 1, true, 1));
      w.placeBuilding(B.belt, 6, z - 1, true, 3);
    } else ids.push(w.placeBuilding(B.belt, 7, z, true, 0));
    for (const id of [ids[0]!, ids[2]!]) setTier(w, id, 1);
    return { w, ids };
  }

  for (const [name, kind] of [
    ['splitter', B.splitter],
    ['merger', B.merger],
  ] as const) {
    it(`the ${name} between Slow belts is crossed in 3 ticks (the Fast rate) and has no tiers: upgrade is refused with a reason`, () => {
      const { w, ids } = junction(kind);
      putItem(w, ids[0]!, ITEM_MASS);
      const { entered } = trace(w, ids, 30);
      expect(entered[2]! - entered[1]!, `across the ${name}`).toBe(3);
      const eng = w.spawnUnit(1, 6.5, 12.5);
      expect(w.submit({ t: 'upgrade', ids: [eng], target: ids[1]! })).toMatch(/has no upgrades/);
    });

    it(`the Slow belts either side of the ${name} keep their own speed (6 ticks a tile)`, () => {
      const { w, ids } = junction(kind);
      putItem(w, ids[0]!, ITEM_MASS);
      const { entered } = trace(w, ids, 30);
      expect(entered[1]! - entered[0]!, 'the Slow belt before it').toBe(6);
    });
  }
});

describe('W31 fixture sanity', () => {
  it('the line fixture lays its belts into the core', () => {
    const { w, belts } = line([1, 2, 3]);
    expect(w.buildings.cols.tx[slot(w, belts[2]!)]).toBe(X0 + 2);
    expect(w.buildings.cols.ty[slot(w, belts[2]!)]).toBe(ROW);
  });
});
