// W29 (PLAN-W29 items 4, 12, 15): saves. A belts world round-trips and steps on identically,
// including the 10 s delivery ring (so HUD rates and snapshots match after a load near a window
// boundary). A populated save written by commit d82db0b (save 3, state format 6; fixture made by
// scripts/make-d82db0b-save.ts) loads by explicit migration as an instant-economy world: its
// per-kind statistics read the same by name, and it runs on deterministically.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createWorld } from '../src/sim/scenarios.ts';
import { SAVE_VERSION, deserializeWorld, serializeWorld } from '../src/sim/save.ts';
import { SNAPSHOT_VERSION, encodeSnapshot, snapshotBytes } from '../src/sim/snapshot.ts';
import { statsReport } from '../src/sim/stats.ts';
import { B, ITEM_MASS } from '../src/sim/kinds.ts';
import type { World } from '../src/sim/world.ts';
import { itemsOnBelts } from './w29-fixtures.ts';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const snapOf = (w: World) => snapshotBytes(encodeSnapshot(w)).slice();
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** The sandbox with an extractor belted to the core, run until items are on the belt and the ring is part full. */
function beltWorld(): World {
  const w = createWorld(5, 'sandbox');
  const core = w.buildings.slotForId(w.coreId);
  const c = w.buildings.cols;
  // the mass deposit at (54, 50): east along z = 50 to the core's column, then south into the core's top
  w.placeBuilding(B.massExtractor, 54, 50, true);
  const tx = c.tx[core]!;
  for (let x = 56; x < tx; x++) w.placeBuilding(B.belt, x, 50, true, 0);
  for (let z = 50; z < c.ty[core]!; z++) w.placeBuilding(B.belt, tx, z, true, 1);
  return w;
}

describe('W29 saves', () => {
  it('a save read from a Node Buffer view that shares a larger pool (non-zero byteOffset) loads like the plain bytes', () => {
    const w = beltWorld();
    for (let i = 0; i < 80; i++) w.step();
    const bytes = serializeWorld(w);
    // readFileSync and Buffer.concat return views into a pooled ArrayBuffer: the save starts part-way in
    const view = Buffer.concat([Buffer.alloc(13, 7), Buffer.from(bytes), Buffer.alloc(5, 9)]).subarray(13, 13 + bytes.length);
    expect(view.byteOffset).toBeGreaterThan(0);
    const a = deserializeWorld(bytes);
    const b = deserializeWorld(view);
    expect(same(snapOf(b), snapOf(a))).toBe(true);
  });

  it('the save and snapshot versions are bumped', () => {
    expect(SAVE_VERSION).toBe(4);
    expect(SNAPSHOT_VERSION).toBe(7);
  });

  it('a belts world round-trips and steps identically, every tick across delivery-window boundaries', () => {
    const w = beltWorld();
    for (let t = 0; t < 230; t++) w.step();
    expect(itemsOnBelts(w, ITEM_MASS)).toBeGreaterThan(0);
    expect(w.delivered[0]).toBeGreaterThan(0);
    const saved = serializeWorld(w);
    const loaded = deserializeWorld(saved.slice());
    expect(loaded.belts).toBe(true);
    expect(same(serializeWorld(loaded), saved)).toBe(true);
    for (let t = 0; t < 250; t++) {
      w.step();
      loaded.step();
      expect(same(snapOf(loaded), snapOf(w)), `tick ${w.tick}`).toBe(true);
      expect(Array.from(loaded.incomeRate)).toEqual(Array.from(w.incomeRate));
    }
  });

  it('a populated d82db0b save loads as an instant-economy world with the same per-kind statistics', () => {
    const ref = JSON.parse(readFileSync(fixture('d82db0b-map1.json'), 'utf8'));
    expect([ref.saveVersion, ref.stateFormat]).toEqual([3, 6]);
    const w = deserializeWorld(readFileSync(fixture('d82db0b-map1.save')));
    expect(w.belts).toBe(false);
    expect(w.coreId).toBe(-1);
    expect(w.tick).toBe(ref.tick);
    expect(w.kills).toBe(ref.kills);
    expect(w.buildings.count).toBe(ref.buildings);
    expect(w.projectiles.count).toBe(ref.projectiles);
    expect(ref.projectiles).toBeGreaterThan(0);
    let queued = 0;
    for (let s = 0; s < w.units.highWater; s++) if (w.units.alive[s]) queued += w.orders[s]?.length ?? 0;
    expect(queued).toBe(ref.queuedOrders);
    expect(Array.from(w.pool)).toEqual(ref.pool);
    const got = statsReport(w.stats);
    // every old kind reads the same by name; the new core row is zero
    expect(got.shooters.commander).toEqual(ref.stats.shooters.commander);
    expect(got.shooters.commander.shots).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(ref.stats.shooters)) expect(got.shooters[k], k).toEqual(v);
    for (const [k, v] of Object.entries(ref.stats.aliens)) expect(got.aliens[k], k).toEqual(v);
    expect(got.shooters.core).toEqual({ shots: 0, hpRemoved: 0, kills: 0 });
  });

  it('the d82db0b save runs on deterministically (straight on, and through a save and load half-way)', () => {
    const bytes = readFileSync(fixture('d82db0b-map1.save'));
    const a = deserializeWorld(bytes);
    let b = deserializeWorld(bytes);
    for (let t = 0; t < 300; t++) {
      a.step();
      b.step();
      if (t === 150) b = deserializeWorld(serializeWorld(b));
    }
    expect(same(snapOf(a), snapOf(b))).toBe(true);
    expect(a.kills).toBeGreaterThanOrEqual(47);
  });
});
