// W29 (PLAN-W29 items 6, 11, 18): a belt tile costs 0.5 mass in both economy modes, with its build
// time unchanged; the build bar shows "0.5M". The numbers live in balance.ts.

import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world.ts';
import { flatTerrain } from '../src/sim/terrain.ts';
import { B, U, buildingInfo } from '../src/sim/kinds.ts';
import { BELT_COST_MASS, CORE_HP, CORE_PASS_SECONDS, CORE_REPAIR_TIME, EXTRACTOR_BUFFER_SECONDS } from '../src/sim/balance.ts';
import { costLabel } from '../src/ui/buildbar.ts';

describe('W29 belt cost', () => {
  it('the W29 numbers are in balance.ts', () => {
    expect([BELT_COST_MASS, EXTRACTOR_BUFFER_SECONDS, CORE_HP, CORE_PASS_SECONDS, CORE_REPAIR_TIME]).toEqual([0.5, 180, 4000, 5, 200]);
  });

  it('belt costs [0.5, 0, 0] with its build time unchanged; splitter and merger unchanged', () => {
    expect(buildingInfo(B.belt).cost).toEqual([0.5, 0, 0]);
    expect(buildingInfo(B.belt).buildTime).toBe(4);
    expect(buildingInfo(B.splitter).cost).toEqual([10, 20, 0]);
    expect(buildingInfo(B.merger).cost).toEqual([10, 20, 0]);
  });

  for (const belts of [true, false]) {
    it(`building one belt tile spends 0.5 mass (belts ${belts ? 'on' : 'off'})`, () => {
      const w = new World(1, flatTerrain(30, 30), { waves: false, belts });
      const cmd = w.spawnUnit(U.commander, 10.5, 10.5);
      w.enqueue({ t: 'build', ids: [cmd], kind: B.belt, tx: 12, ty: 10, dir: 0 });
      for (let t = 0; t < 30; t++) w.step();
      const s = w.buildings.slotForId(w.buildings.id(0));
      expect(w.buildings.cols.progress[s]).toBe(1);
      // progress is stored as f32, so the drain over a build is the cost to about 1e-8 (economy.ts PROGRESS_SNAP)
      expect(w.spentTotal[0]).toBeCloseTo(0.5, 6);
      expect(w.spentTotal[1]).toBe(0);
    });
  }

  it('the build bar labels the belt 0.5M, not 0M or 1M', () => {
    expect(costLabel('belt')).toBe('0.5M 0E');
  });
});
