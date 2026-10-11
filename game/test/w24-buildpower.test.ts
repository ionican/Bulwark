// W24 acceptance 1 (build power): commander 8 BP, engineer 5 BP, as a game-side adjustment.
// A 100 build-power-second site takes 125 ticks (±1) with the commander alone, 200 with one
// engineer, 56 (±1) with the commander and two engineers.

import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world.ts';
import { B, U, UNIT_INFO, buildingInfo } from '../src/sim/kinds.ts';
import { ADJUSTMENTS, BUILD_RATE } from '../src/sim/balance.ts';
import { BF_COMPLETE, BF_STARTED } from '../src/sim/schema.ts';
import { flatTerrain } from '../src/sim/terrain.ts';
import { map1 } from '../../model/data/map1.ts';

/**
 * Ticks from the first tick of build power to completion of a mass extractor (100 BP·s), built by
 * the given units standing in range from the start, with resources to spare.
 */
function ticksToBuild(builders: number[]): { ticks: number; firstPowerTick: number } {
  const w = new World(1, flatTerrain(30, 30, { deposits: [{ kind: 'mass', tx: 10, ty: 10 }] }), { waves: false });
  w.pool.set([1e6, 1e6, 1e6]);
  const site = w.placeBuilding(B.massExtractor, 10, 10, false);
  // In range (buildRange from the footprint edge) and off the footprint, so nobody walks.
  const spots: Array<[number, number]> = [
    [13.5, 10.5],
    [13.5, 11.5],
    [8.5, 10.5],
  ];
  const ids = builders.map((kind, i) => w.spawnUnit(kind, spots[i]![0], spots[i]![1]));
  w.enqueue({ t: 'assist', ids, target: site });
  const s = w.buildings.slotForId(site);
  let firstPowerTick = -1;
  while (!(w.buildings.cols.flags[s]! & BF_COMPLETE)) {
    const tick = w.tick;
    w.step();
    if (firstPowerTick < 0 && w.buildings.cols.flags[s]! & BF_STARTED) firstPowerTick = tick;
    if (w.tick > 5000) throw new Error('site never completed');
  }
  // Ticks during which build power was applied: from the first one to the completing one, inclusive.
  return { ticks: w.tick - firstPowerTick, firstPowerTick };
}

describe('build power (W24)', () => {
  it('is 8 for the commander and 5 for an engineer, listed as a game-side adjustment; map1.ts keeps 10', () => {
    expect(BUILD_RATE.commander).toBe(8);
    expect(BUILD_RATE.engineer).toBe(5);
    expect(UNIT_INFO.commander.buildRate).toBe(8);
    expect(UNIT_INFO.engineer.buildRate).toBe(5);
    expect(map1.commander.buildRate).toBe(10); // the W12 model is unchanged
    const adj = ADJUSTMENTS.find((a) => a.what === 'Commander build power');
    expect(adj?.from).toBe('10 BP');
    expect(adj?.to).toBe('8 BP');
    expect(adj?.why).toMatch(/2026-10-08/);
  });

  it('the test site is 100 build-power-seconds', () => {
    expect(buildingInfo(B.massExtractor).buildTime).toBe(100);
  });

  it('commander alone: 125 ticks (±1)', () => {
    const r = ticksToBuild([U.commander]);
    expect(r.firstPowerTick).toBe(0); // in range from the first tick
    console.log(`commander alone: ${r.ticks} ticks`);
    expect(Math.abs(r.ticks - 125)).toBeLessThanOrEqual(1);
  });

  it('one engineer: 200 ticks', () => {
    const r = ticksToBuild([U.engineer]);
    console.log(`one engineer: ${r.ticks} ticks`);
    expect(Math.abs(r.ticks - 200)).toBeLessThanOrEqual(1);
  });

  it('commander and two engineers: 56 ticks (±1)', () => {
    const r = ticksToBuild([U.commander, U.engineer, U.engineer]);
    console.log(`commander and two engineers: ${r.ticks} ticks`);
    expect(Math.abs(r.ticks - 56)).toBeLessThanOrEqual(1);
  });
});
