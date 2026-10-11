// W29 (PLAN-W29 item 10): the repair order. A repairing unit in build range restores hit points at
// buildPower × maxHp ÷ repairTime per second, free, where repairTime is the instance's own
// construction time, siteWork(kind, false, tier, fw, fh).time (never the upgrade time). Repair power
// is its own per-building array, so repair and an upgrade on one building both proceed.

import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world.ts';
import { flatWorld } from './fixtures.ts';
import { B, COMMANDER_INCOME, TICK_SECONDS, U, siteWork } from '../src/sim/kinds.ts';
import { BF_UPGRADING } from '../src/sim/schema.ts';
import { BUILD_RATE, RESEARCH_INDEX } from '../src/sim/balance.ts';

function setup(): { w: World; cmd: number; eng: number } {
  const w = flatWorld(40, 40, { rich: true });
  const cmd = w.spawnUnit(U.commander, 20.5, 24.5);
  const eng = w.spawnUnit(U.engineer, 22.5, 24.5);
  return { w, cmd, eng };
}

/** Hit points gained per tick over `ticks` ticks (the order already running). */
function gain(w: World, s: number, ticks: number): number {
  const h0 = w.buildings.cols.hp[s]!;
  for (let t = 0; t < ticks; t++) w.step();
  return (w.buildings.cols.hp[s]! - h0) / ticks;
}

describe('W29 repair', () => {
  it('restores hp at buildPower × maxHp ÷ construction time, costs nothing, and stops at full hp', () => {
    const { w, cmd } = setup();
    const gun = w.placeBuilding(B.gun, 20, 20, true);
    const s = w.buildings.slotForId(gun);
    const c = w.buildings.cols;
    const max = c.maxHp[s]!;
    c.hp[s] = max / 2;
    expect(w.submit({ t: 'repair', ids: [cmd], target: gun })).toBeNull();
    w.step();
    const pool = Array.from(w.pool);
    const spent = Array.from(w.spentTotal);
    const per = gain(w, s, 20);
    const time = siteWork(B.gun, false, 1, 2, 2).time;
    expect(per).toBeCloseTo((BUILD_RATE.commander * max * TICK_SECONDS) / time, 3);
    // free: the pool changed by the commander's income alone, and nothing was spent
    for (let k = 0; k < 3; k++) expect(w.pool[k]! - pool[k]!).toBeCloseTo(COMMANDER_INCOME[k]! * 20 * TICK_SECONDS, 6);
    expect(Array.from(w.spentTotal)).toEqual(spent);
    for (let t = 0; t < 2000 && w.orders[w.units.slotForId(cmd)]!.length; t++) w.step();
    expect(c.hp[s]).toBe(max);
    expect(w.orders[w.units.slotForId(cmd)]).toEqual([]);
  });

  it('several units on one building add their power', () => {
    const { w, cmd, eng } = setup();
    const gun = w.placeBuilding(B.gun, 20, 20, true);
    const s = w.buildings.slotForId(gun);
    const max = w.buildings.cols.maxHp[s]!;
    w.buildings.cols.hp[s] = 10;
    w.submit({ t: 'repair', ids: [cmd, eng], target: gun });
    w.step();
    const per = gain(w, s, 20);
    expect(per).toBeCloseTo(((BUILD_RATE.commander + BUILD_RATE.engineer) * max * TICK_SECONDS) / siteWork(B.gun, false, 1, 2, 2).time, 3);
  });

  it('Shift queues a repair after the orders already held', () => {
    const { w, cmd } = setup();
    const gun = w.placeBuilding(B.gun, 20, 20, true);
    w.buildings.cols.hp[w.buildings.slotForId(gun)] = 10;
    w.submit({ t: 'move', ids: [cmd], x: 5.5, z: 5.5 });
    w.submit({ t: 'repair', ids: [cmd], target: gun, queue: true });
    w.step();
    expect(w.orders[w.units.slotForId(cmd)]!.map((o) => o.t)).toEqual(['move', 'repair']);
    // without Shift it replaces the queue
    w.submit({ t: 'repair', ids: [cmd], target: gun });
    w.step();
    expect(w.orders[w.units.slotForId(cmd)]!.map((o) => o.t)).toEqual(['repair']);
  });

  it('is refused for a building that is not damaged or not finished', () => {
    const { w, cmd } = setup();
    const gun = w.placeBuilding(B.gun, 20, 20, true);
    expect(w.submit({ t: 'repair', ids: [cmd], target: gun })).toMatch(/not damaged/);
    const site = w.placeBuilding(B.gun, 10, 10, false);
    expect(w.submit({ t: 'repair', ids: [cmd], target: site })).toMatch(/not finished/);
  });

  it('repair and upgrade on one building at once: the upgrade drains its cost, the repair adds hp at the same rate as before the upgrade', () => {
    const { w, cmd, eng } = setup();
    w.completeResearch(RESEARCH_INDEX.gunT2!);
    const gun = w.placeBuilding(B.gun, 20, 20, true);
    const s = w.buildings.slotForId(gun);
    const c = w.buildings.cols;
    const max = c.maxHp[s]!;
    c.hp[s] = 20;
    // the oracle: the gun's own construction time, not the upgrade's
    const oracle = (BUILD_RATE.commander * max * TICK_SECONDS) / siteWork(B.gun, false, 1, 2, 2).time;
    expect(siteWork(B.gun, true, 1, 2, 2).time).not.toBe(siteWork(B.gun, false, 1, 2, 2).time);
    w.submit({ t: 'repair', ids: [cmd], target: gun });
    w.step();
    const before = gain(w, s, 10);
    expect(before).toBeCloseTo(oracle, 3);
    expect(w.submit({ t: 'upgrade', ids: [eng], target: gun })).toBeNull();
    w.step();
    expect(c.flags[s]! & BF_UPGRADING).not.toBe(0);
    const spent0 = w.spentTotal[0]!;
    const p0 = c.progress[s]!;
    const during = gain(w, s, 10);
    // hit points are f32: the per-tick gain carries their rounding (about 1e-6 at these values)
    expect(during).toBeCloseTo(before, 4);
    expect(during).toBeCloseTo(oracle, 3);
    expect(c.progress[s]!).toBeGreaterThan(p0);
    expect(w.spentTotal[0]!).toBeGreaterThan(spent0);
  });

  it('a 12-tile gate repairs at its scaled construction time (1,080 BP·s)', () => {
    const { w, cmd } = setup();
    expect(siteWork(B.gate, false, 1, 3, 4).time).toBe(1080);
    const gate = w.placeBuilding(B.gate, 19, 18, true, 1, 3, 4);
    expect(gate).toBeGreaterThanOrEqual(0);
    const s = w.buildings.slotForId(gate);
    const max = w.buildings.cols.maxHp[s]!;
    w.buildings.cols.hp[s] = 10;
    w.submit({ t: 'repair', ids: [cmd], target: gate });
    w.step();
    expect(gain(w, s, 20)).toBeCloseTo((BUILD_RATE.commander * max * TICK_SECONDS) / 1080, 3);
  });

  it('works on a damaged belt tile too, and in a belts: false world (this one)', () => {
    const { w, cmd } = setup();
    expect(w.belts).toBe(false);
    const belt = w.placeBuilding(B.belt, 20, 22, true, 0);
    const s = w.buildings.slotForId(belt);
    w.buildings.cols.hp[s] = 30;
    expect(w.submit({ t: 'repair', ids: [cmd], target: belt })).toBeNull();
    for (let t = 0; t < 50; t++) w.step();
    expect(w.buildings.cols.hp[s]).toBe(w.buildings.cols.maxHp[s]);
  });
});
