// W32 review fix (Codex adversarial review, PLAN-W32 item 4): while a building has demolish progress
// no build or repair power reaches it from any order, whether or not demolish power arrives that
// tick. The case found: a wall-run builder still holding a wall the run just finished; the wall's
// upgrade starts, a demolish starts, the demolisher is stopped. The run order took the upgrading
// wall for an unfinished site and kept building the upgrade, so the paused demolition did not
// freeze it (the upgrade completed and the refund rose from 50 mass to 100 mass + 2 rare). Here the
// upgrade stays frozen with no upgrade spending, through a save/load too; the refund on resuming is
// the tier-1 refund plus the frozen partial; the run skips the wall and finishes its other tiles.

import { describe, expect, it } from 'vitest';
import { B, U } from '../src/sim/kinds.ts';
import { BF_COMPLETE, BF_UPGRADING } from '../src/sim/schema.ts';
import { deserializeWorld, serializeWorld } from '../src/sim/save.ts';
import type { World } from '../src/sim/world.ts';
import { flatWorld } from './fixtures.ts';
import { alive, demolish, demolishOf, refundCounter, setDemolish, steps, until, wallSpent, why } from './w32-fixtures.ts';
import { map1 } from '../../model/data/map1.ts';

const WALL_UP = map1.buildings.wall.tiers![0]!.upgradeCost;

/** The building at tile (x, z), or -1. */
function idAt(w: World, x: number, z: number): number {
  const s = w.occupancy[z * w.terrain.w + x]! - 1;
  return s < 0 ? -1 : w.buildings.id(s);
}

/** Unit `uid`'s first order, as the run branch sees it. */
const head = (w: World, uid: number) => w.orders[w.units.slotForId(uid)]?.[0];

/**
 * A 4-tile wall run on z = 10 from x = 10 by engineer R; stepped until its first tile (10, 10) is
 * finished while R's run order still holds it. Then, in one tick, engineer D (beside the wall) is
 * ordered to upgrade it and then to demolish it, and one tick of demolition runs; D is stopped.
 */
function scenario() {
  const w = flatWorld(40, 30, { rich: true });
  w.debug.allTiers = true;
  const r = w.spawnUnit(U.engineer, 10.5, 12.5);
  const d = w.spawnUnit(U.engineer, 10.5, 8.5);
  expect(why(w.submit({ t: 'buildRun', ids: [r], from: [10, 10], to: [13, 10], depth: 1 }))).toBe('(accepted)');
  steps(w, 1);
  const wall = idAt(w, 10, 10);
  expect(wall).toBeGreaterThanOrEqual(0);
  const ws = w.buildings.slotForId(wall);
  const c = w.buildings.cols;
  until(w, () => (c.flags[ws]! & BF_COMPLETE) !== 0, 2000);
  const o = head(w, r);
  expect(o && o.t === 'run' && o.site === wall, 'the run order still holds the finished wall').toBe(true);
  expect(why(w.submit({ t: 'upgrade', ids: [d], target: wall }))).toBe('(accepted)');
  expect(why(w.submit(demolish([d], [wall])))).toBe('(accepted)');
  steps(w, 1);
  expect(c.flags[ws]! & BF_UPGRADING, 'the upgrade started').not.toBe(0);
  expect(demolishOf(w, wall), 'one tick of demolition').toBeGreaterThan(0);
  expect(why(w.submit({ t: 'stop', ids: [d] }))).toBe('(accepted)');
  steps(w, 1);
  return { w, r, d, wall, ws };
}

/** Over `n` ticks: the wall's upgrade progress, tier, demolish progress and the rare spent (only the upgrade draws rare) do not move. */
function expectFrozen(w: World, ws: number, wall: number, n: number) {
  const c = w.buildings.cols;
  const p0 = c.progress[ws]!;
  const d0 = demolishOf(w, wall);
  const rare0 = w.spentTotal[2]!;
  const pool0 = w.pool[2]!;
  for (let t = 1; t <= n; t++) {
    w.step();
    expect(c.progress[ws], `upgrade progress at tick ${t}`).toBe(p0);
    expect(c.tier[ws], `tier at tick ${t}`).toBe(1);
    expect(demolishOf(w, wall), `demolish progress at tick ${t}`).toBe(d0);
  }
  expect(w.spentTotal[2]! - rare0, 'rare spent on the upgrade while demolition is paused').toBe(0);
  expect(w.pool[2]! - pool0, 'pool rare while demolition is paused').toBe(0);
  return p0;
}

/** D demolishes the wall again; the refund is half of the tier-1 wall plus the frozen partial upgrade. */
function expectRefund(w: World, d: number, wall: number, p0: number) {
  const before = refundCounter(w);
  expect(why(w.submit(demolish([d], [wall])))).toBe('(accepted)');
  until(w, () => !alive(w, wall), 3000);
  const after = refundCounter(w);
  expect(after[0] - before[0]).toBeCloseTo(0.5 * (wallSpent(1)[0] + p0 * WALL_UP.mass), 6);
  expect(after[1] - before[1]).toBeCloseTo(0.5 * (wallSpent(1)[2] + p0 * WALL_UP.rare), 6);
}

describe('W32 review: a paused demolition freezes an upgrade a wall-run builder holds', () => {
  it('the demolisher stopped: upgrade progress, tier and rare spending unchanged over 400 ticks; the refund on resuming is tier 1 plus the frozen partial', () => {
    const { w, d, wall, ws } = scenario();
    const p0 = expectFrozen(w, ws, wall, 400);
    expectRefund(w, d, wall, p0);
  });

  it('the same through a save and load while paused', () => {
    const { w: a, d, wall, ws } = scenario();
    const w = deserializeWorld(serializeWorld(a));
    const p0 = expectFrozen(w, ws, wall, 400);
    expectRefund(w, d, wall, p0);
  });

  it('the run builder leaves the wall being demolished at once and finishes the run\'s other three tiles', () => {
    const { w, r, wall } = scenario();
    const o = head(w, r);
    expect(o && o.t === 'run' ? o.site : null, 'the run order moved off the wall').not.toBe(wall);
    const others = [11, 12, 13].map((x) => idAt(w, x, 10));
    until(w, () => others.every((id) => id >= 0 && (w.buildings.cols.flags[w.buildings.slotForId(id)]! & BF_COMPLETE) !== 0), 3000);
    expect(alive(w, wall), 'the wall being demolished stands, paused').toBe(true);
  });

  it('repair power: a damaged wall being demolished (demolisher stopped) gains no hit points from a repair order given before', () => {
    const w = flatWorld(40, 30, { rich: true });
    const e = w.spawnUnit(U.engineer, 10.5, 12.5);
    const d = w.spawnUnit(U.engineer, 10.5, 8.5);
    const wall = w.placeBuilding(B.wall, 10, 10, true);
    const s = w.buildings.slotForId(wall);
    const c = w.buildings.cols;
    c.hp[s] = c.maxHp[s]! * 0.3;
    expect(why(w.submit({ t: 'repair', ids: [e], target: wall }))).toBe('(accepted)');
    expect(why(w.submit(demolish([d], [wall])))).toBe('(accepted)');
    steps(w, 1);
    expect(why(w.submit({ t: 'stop', ids: [d] }))).toBe('(accepted)');
    const hp0 = c.hp[s]!;
    for (let t = 0; t < 200; t++) {
      w.step();
      expect(c.hp[s], `hp at tick ${t}`).toBe(hp0);
    }
    // a set demolish progress with no order on it at all: the repair command is refused
    const other = w.placeBuilding(B.wall, 14, 10, true);
    setDemolish(w, other, 0.2);
    expect(w.submit({ t: 'repair', ids: [e], target: other })).toMatch(/being demolished/);
  });
});
