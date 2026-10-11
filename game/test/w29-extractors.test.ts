// W29 (PLAN-W29 items 1, 3, 4, 15): with belts on, extractor output goes into the extractor's own
// buffer, not the pool; a full buffer stops digging. `belts: false` worlds keep the instant economy.

import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world.ts';
import { createWorld } from '../src/sim/scenarios.ts';
import { flatTerrain } from '../src/sim/terrain.ts';
import { B, BUILDING_KINDS, COMMANDER_INCOME, ITEM_MASS, ITEM_NAMES, ITEM_RARE, buildingInfo } from '../src/sim/kinds.ts';
import { BF_IDLE } from '../src/sim/schema.ts';
import { EXTRACTOR_BUFFER_SECONDS, RARE_EXTRACTOR_OUTPUT } from '../src/sim/balance.ts';
import { decodeSnapshot, encodeSnapshot } from '../src/sim/snapshot.ts';
import { ROW, beltLine, slot, steps } from './w29-fixtures.ts';

const cores = (w: World) => {
  let n = 0;
  for (let s = 0; s < w.buildings.highWater; s++) if (w.buildings.alive[s] && w.buildings.cols.kind[s] === B.core) n++;
  return n;
};

describe('W29 item kinds and the belts option', () => {
  it('mass and rare items are appended after the part item', () => {
    expect(ITEM_MASS).toBe(5);
    expect(ITEM_RARE).toBe(6);
    expect(ITEM_NAMES[5]).toBe('mass');
    expect(ITEM_NAMES[6]).toBe('rare');
  });

  it('`new World` defaults to belts off; only map 1 and the sandbox turn them on and get a core', () => {
    expect(new World(1, flatTerrain(20, 20), { waves: false }).belts).toBe(false);
    for (const s of ['map1', 'sandbox'] as const) {
      const w = createWorld(1, s);
      expect(w.belts, s).toBe(true);
      expect(cores(w), s).toBe(1);
    }
    for (const s of ['stress', 'empty'] as const) {
      const w = createWorld(1, s);
      expect(w.belts, s).toBe(false);
      expect(cores(w), `${s}: no belts: false scenario has a core`).toBe(0);
    }
    expect(BUILDING_KINDS[BUILDING_KINDS.length - 1]).toBe('core');
  });
});

describe('W29 extractors with belts on', () => {
  it('no extractor income reaches the pool without a belt; the buffer fills to its cap and digging stops', () => {
    const { w, extractor } = beltLine(10, { belt: false });
    const s = slot(w, extractor);
    const c = w.buildings.cols;
    const pool0 = w.pool[0]!;
    steps(w, 100);
    expect(w.pool[0]).toBe(pool0);
    expect(w.incomeRate[0]).toBe(0);
    expect(c.stock[s]).toBeCloseTo(10, 4);
    expect(c.flags[s]! & BF_IDLE, 'digging').toBe(0);
    const cap = EXTRACTOR_BUFFER_SECONDS * buildingInfo(B.massExtractor).income![0];
    expect(cap).toBe(180);
    steps(w, 1800);
    expect(c.stock[s]).toBe(cap);
    expect(c.flags[s]! & BF_IDLE, 'a full buffer stops digging').not.toBe(0);
    expect(w.pool[0]).toBe(pool0);
    // the not-digging flag is in the snapshot (the renderer stops the animation by it)
    const snap = decodeSnapshot(encodeSnapshot(w));
    const r = Array.from(snap.buildings.id.subarray(0, snap.buildings.count)).indexOf(extractor);
    expect(snap.buildings.cols.flags[r]! & BF_IDLE).not.toBe(0);
    expect(snap.buildings.cols.stock[r]).toBe(cap);
  });

  it('a rare extractor buffers 45 rare at most (180 s of 0.25/s)', () => {
    const { w, extractor } = beltLine(10, { kind: 'rare', belt: false });
    steps(w, 2000);
    expect(w.buildings.cols.stock[slot(w, extractor)]).toBe(EXTRACTOR_BUFFER_SECONDS * RARE_EXTRACTOR_OUTPUT);
    expect(w.pool[2]).toBe(createWorld(1, 'empty').pool[2]);
  });

  it('`belts: false` worlds behave as before: extractor income goes straight to the pool, no core', () => {
    const { w, extractor } = beltLine(10, { belts: false });
    const pool0 = w.pool[0]!;
    steps(w, 100);
    expect(w.pool[0]! - pool0).toBeCloseTo(10, 6);
    expect(w.incomeRate[0]).toBe(1);
    expect(w.buildings.cols.stock[slot(w, extractor)]).toBe(0);
    // map 1 with belts off by hand: the commander's income plus the extractor's, at once
    const m = createWorld(1, 'empty');
    expect(m.belts).toBe(false);
    m.spawnStartUnits();
    m.placeBuilding(B.massExtractor, 54, 50, true);
    const p0 = m.pool[0]!;
    steps(m, 10);
    expect(m.pool[0]! - p0).toBeCloseTo(COMMANDER_INCOME[0] + 1, 6);
  });

  it('the commander income stays instant with belts on, and incomeRate counts it', () => {
    const w = createWorld(1, 'sandbox');
    const p0 = w.pool[0]!;
    steps(w, 10);
    expect(w.pool[0]! - p0).toBeCloseTo(COMMANDER_INCOME[0], 9);
    expect(w.incomeRate[0]).toBe(COMMANDER_INCOME[0]);
  });

  it('the extractor output comes out as items onto a belt whose back faces it', () => {
    const { w, belts } = beltLine(10);
    steps(w, 9);
    const first = slot(w, belts[0]!);
    expect(w.buildings.cols.item[first]).toBe(0);
    w.step();
    expect(w.buildings.cols.item[first]).toBe(ITEM_MASS);
    expect(w.buildings.cols.ty[first]).toBe(ROW);
  });
});
