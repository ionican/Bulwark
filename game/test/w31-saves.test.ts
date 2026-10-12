// W31 (PLAN-W31 tests 10–12): research indices are append-only (saves store them as numbers), a
// build-170 save (fixture written by scripts/make-2f6fd0b-save.ts from commit 2f6fd0b) loads with
// its research unchanged and every belt Slow, a mixed-speed world continues identically after a
// save and load, and a mixed-speed command log replays to identical snapshots.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Command } from '../src/sim/commands.ts';
import { RESEARCH, RESEARCH_INDEX } from '../src/sim/balance.ts';
import { B, ITEM_NONE, U } from '../src/sim/kinds.ts';
import { deserializeWorld, serializeWorld } from '../src/sim/save.ts';
import { encodeSnapshot, snapshotBytes } from '../src/sim/snapshot.ts';
import type { World } from '../src/sim/world.ts';
import { flatWorld } from './fixtures.ts';
import { research, setTier } from './w31-fixtures.ts';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const snapOf = (w: World) => snapshotBytes(encodeSnapshot(w)).slice();
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const idsOf = (mask: number) => RESEARCH.filter((_, i) => mask & (1 << i)).map((n) => n.id);

/** RESEARCH ids on build 170 (commit 2f6fd0b), in index order. */
const MAIN_IDS = ['wallT2', 'wallT3', 'gunT2', 'areaT2', 'beam', 'shield', 'extractors', 'scanners', 'fieldEng', 'heavy', 'heavyT2'];

describe('W31 research indices (test 10)', () => {
  it('the build-170 nodes keep their indices', () => {
    expect(RESEARCH.slice(0, MAIN_IDS.length).map((n) => n.id)).toEqual(MAIN_IDS);
    MAIN_IDS.forEach((id, i) => expect(RESEARCH_INDEX[id]).toBe(i));
  });

  it('Medium belts and Fast belts are appended after heavyT2 (economy, new numbers, Fast needs Medium)', () => {
    expect(RESEARCH.slice(MAIN_IDS.length).map((n) => n.id)).toEqual(['beltMedium', 'beltFast']);
    const [m, f] = [RESEARCH[RESEARCH_INDEX.beltMedium!]!, RESEARCH[RESEARCH_INDEX.beltFast!]!];
    expect(m).toMatchObject({ label: 'Medium belts', branch: 'economy', cost: [50, 500, 5], seconds: 30, source: 'new' });
    expect(f).toMatchObject({ label: 'Fast belts', branch: 'economy', cost: [100, 1000, 15], seconds: 45, requires: 'beltMedium', source: 'new' });
  });

  it('a build-170 save with completed, running and queued research loads with the same research state', () => {
    const ref = JSON.parse(readFileSync(fixture('2f6fd0b-map1.json'), 'utf8'));
    expect(ref.research.ids).toEqual(MAIN_IDS);
    expect(ref.research.done.length).toBeGreaterThan(0);
    expect(ref.research.queued.length).toBeGreaterThan(0);
    const w = deserializeWorld(readFileSync(fixture('2f6fd0b-map1.save')));
    expect(idsOf(w.researchDone)).toEqual(ref.research.done);
    expect(RESEARCH[w.researchCurrent]?.id).toBe(ref.research.current);
    expect(w.researchProgress).toBe(ref.research.progress);
    expect(w.researchQueue.map((i) => RESEARCH[i]!.id)).toEqual(ref.research.queued);
  });
});

describe('W31 saves (test 11)', () => {
  it('a build-170 save loads with every belt at tier 1 (Slow): items on its belts advance 1/6 tile a tick', () => {
    const ref = JSON.parse(readFileSync(fixture('2f6fd0b-map1.json'), 'utf8'));
    const w = deserializeWorld(readFileSync(fixture('2f6fd0b-map1.save')));
    const c = w.buildings.cols;
    const belts: number[] = [];
    for (let s = 0; s < w.buildings.highWater; s++) if (w.buildings.alive[s] && c.kind[s] === B.belt) belts.push(s);
    expect(belts.length).toBe(ref.belts);
    expect(new Set(belts.map((s) => c.tier[s]))).toEqual(new Set([1]));
    const before = new Map(belts.filter((s) => c.item[s] !== ITEM_NONE && c.itemPos[s]! < 1).map((s) => [s, c.itemPos[s]!]));
    w.step();
    const moved = [...before].filter(([s, p]) => c.item[s] !== ITEM_NONE && c.itemPos[s]! > p);
    expect(moved.length).toBeGreaterThan(5);
    for (const [s, p] of moved) expect(c.itemPos[s], `belt slot ${s} from ${p}`).toBe(Math.fround(Math.min(1, p + 1 / 6)));
  });

  it('continuation: a mixed-speed world run on equals the same world saved and restored mid-run, every tick (mixed-speed transfers, a merger, a splitter with a blocked output, a pending batch upgrade, an upgrade completing)', () => {
    const SAVE_AT = 200;
    const a = mixedWorld();
    while (a.tick < SAVE_AT) a.step();
    const b = deserializeWorld(serializeWorld(a));
    expect(same(serializeWorld(b), serializeWorld(a))).toBe(true);
    expect(a.queue.some((q) => q.cmd.t === ('upgradeBelts' as Command['t'])), 'the batch upgrade is pending at the save').toBe(true);
    for (let t = 0; t < 400; t++) {
      a.step();
      b.step();
      expect(same(snapOf(b), snapOf(a)), `tick ${a.tick}`).toBe(true);
    }
    for (const w of [a, b]) {
      const c = w.buildings.cols;
      const at = (x: number, z: number) => w.occupancy[z * w.terrain.w + x]! - 1;
      expect([18, 19, 20].map((x) => c.tier[at(x, 19)]), 'the batch upgrade applied after the load').toEqual([2, 2, 2]);
      expect(c.tier[at(21, 19)], 'the single upgrade completed').toBe(2);
      expect(w.delivered[0]! + w.delivered[1]!).toBeGreaterThan(10);
      // the splitter's south output is a dead end: its three tiles hold items at the end of their tiles
      expect([35, 36, 37].map((x) => c.item[at(x, 20)] !== ITEM_NONE)).toEqual([true, true, true]);
    }
  });
});

describe('W31 determinism (test 12)', () => {
  it('two runs of the same mixed-speed command log produce identical snapshots every tick', () => {
    const start = () => {
      const w = flatWorld(50, 30, { rich: true, belts: true, terrain: { deposits: [{ tx: 6, ty: 10, kind: 'mass' }] } });
      w.placeBuilding(B.core, 30, 9, true);
      w.placeBuilding(B.massExtractor, 6, 10, true);
      research(w, 'beltMedium');
      research(w, 'beltFast');
      const e = [w.spawnUnit(U.engineer, 12.5, 13.5), w.spawnUnit(U.engineer, 20.5, 13.5)];
      for (let x = 8; x < 30; x++) w.enqueue({ t: 'build', ids: e, kind: B.belt, tx: x, ty: 10, dir: 0, tier: x < 14 ? 1 : x < 22 ? 3 : 2, queue: true } as Command, 0);
      return { w, e };
    };
    const a = start();
    const b = start();
    for (let t = 0; t < 700; t++) {
      if (t === 400)
        // the same batch upgrade, by building id, sent to both at the same tick
        for (const { w, e } of [a, b]) {
          const targets = [8, 9, 10, 11].map((x) => ({ id: w.buildings.id(w.occupancy[10 * 50 + x]! - 1), expectedTier: 1 }));
          w.enqueue({ t: 'upgradeBelts', ids: e, targets, queue: false } as unknown as Command);
        }
      a.w.step();
      b.w.step();
      expect(same(snapOf(b.w), snapOf(a.w)), `tick ${a.w.tick}`).toBe(true);
    }
    expect(a.w.delivered[0]).toBeGreaterThan(0);
  });
});

/**
 * The continuation world (60 × 40, belts on, rich, both belt researches done):
 *   mass extractor (10, 19) → z = 19 east: x 12–17 Fast, 18–25 Slow, merger at 26, 27–33 Medium,
 *   splitter at 34 → north output (34, 18) and on east at z = 18, Fast, into the core (40–42, 18–20);
 *   south output (34, 20) and on to (37, 20), Slow, a dead end (it fills and blocks that output)
 *   rare extractor (25, 25) → x = 26 north from z = 24 to 20, Medium, into the merger's side
 * Commands: a single upgrade of (21, 19) at tick 195 (completes after the save at 200), and a batch
 * upgrade of (18–20, 19) applied at tick 230.
 */
function mixedWorld(): World {
  const w = flatWorld(60, 40, { rich: true, belts: true, terrain: { deposits: [{ tx: 10, ty: 19, kind: 'mass' }, { tx: 25, ty: 25, kind: 'rare' }] } });
  research(w, 'beltMedium');
  research(w, 'beltFast');
  w.placeBuilding(B.core, 40, 18, true);
  w.placeBuilding(B.massExtractor, 10, 19, true);
  w.placeBuilding(B.rareExtractor, 25, 25, true);
  const lay = (x: number, z: number, dir: number, tier: number) => setTier(w, w.placeBuilding(B.belt, x, z, true, dir), tier);
  for (let x = 12; x <= 33; x++) if (x !== 26) lay(x, 19, 0, x <= 17 ? 3 : x <= 25 ? 1 : 2);
  w.placeBuilding(B.merger, 26, 19, true, 0);
  w.placeBuilding(B.splitter, 34, 19, true, 0);
  for (let x = 34; x <= 39; x++) lay(x, 18, 0, 3);
  for (let x = 34; x <= 37; x++) lay(x, 20, 0, 1);
  for (let z = 24; z >= 20; z--) lay(26, z, 3, 2);
  const e1 = w.spawnUnit(U.engineer, 21.5, 21.5);
  const e2 = w.spawnUnit(U.engineer, 19.5, 21.5);
  const at = (x: number, z: number) => w.buildings.id(w.occupancy[z * w.terrain.w + x]! - 1);
  w.enqueue({ t: 'upgrade', ids: [e1], target: at(21, 19) }, 195);
  w.enqueue({ t: 'upgradeBelts', ids: [e2], targets: [18, 19, 20].map((x) => ({ id: at(x, 19), expectedTier: 1 })), queue: false } as unknown as Command, 230);
  return w;
}
