// W31 (PLAN-W31 tests 15 and 16): the hover readout names a belt's speed in words with its tiles a
// second in every state (healthy, damaged, reserved, under construction, and the speed it is going
// to while upgrading); the build menu has three belt entries with their own identities, `B` picks
// the fastest unlocked one, the drag-plan cache keys on the speed, and the upgrade tool's drag
// preview counts per destination speed with its cost.

import { describe, expect, it } from 'vitest';
import { B, U, buildingInfo } from '../src/sim/kinds.ts';
import { BF_COMPLETE, BF_STARTED, BF_UPGRADING } from '../src/sim/schema.ts';
import type { World } from '../src/sim/world.ts';
import { buildingReadout } from '../src/render/buildingReadout.ts';
import { siteReadout } from '../src/render/siteReadout.ts';
import { decodeSnapshot, encodeSnapshot, type Snapshot } from '../src/sim/snapshot.ts';
import { buildOccupancy } from '../src/render/picking.ts';
import * as dragPlan from '../src/dragPlan.ts';
import { DragPlanCache, planDrag, dragLabel, type DragView } from '../src/dragPlan.ts';
import * as buildbar from '../src/ui/buildbar.ts';
import * as tools from '../src/tools.ts';
import { flatWorld } from './fixtures.ts';
import { research, setTier } from './w31-fixtures.ts';

const snapOf = (w: World) => decodeSnapshot(encodeSnapshot(w));
function viewOf(w: World, s: Snapshot): DragView {
  const c = s.buildings.cols;
  const occupancy = buildOccupancy({ count: s.buildings.count, id: s.buildings.id, kind: c.kind, tx: c.tx, ty: c.ty, fw: c.fw, fh: c.fh }, w.terrain.w, w.terrain.h, new Int32Array(w.terrain.w * w.terrain.h));
  return { terrain: w.terrain, occupancy, kinds: c.kind, units: { count: s.units.count, id: s.units.id, x: s.units.cols.x, z: s.units.cols.z }, snapshot: s };
}

describe('W31 belt readouts (test 15)', () => {
  function world() {
    const w = flatWorld(40, 40, { belts: true });
    const at = (x: number, tier: number, complete: boolean) => {
      const id = w.placeBuilding(B.belt, x, 10, complete, 0);
      setTier(w, id, tier);
      return { id, s: w.buildings.slotForId(id) };
    };
    const c = w.buildings.cols;
    const healthy = at(5, 1, true);
    const damaged = at(7, 2, true);
    c.hp[damaged.s] = 40;
    const reserved = at(9, 3, false);
    const building = at(11, 2, false);
    c.flags[building.s] = BF_STARTED;
    c.progress[building.s] = 0.3;
    const upgrading = at(13, 1, true);
    c.flags[upgrading.s] = BF_COMPLETE | BF_STARTED | BF_UPGRADING;
    return { w, healthy, damaged, reserved, building, upgrading };
  }

  it('healthy and damaged belts: "Conveyor belt · Slow (1.7 tiles/s)", "… · Medium (2.5 tiles/s)" (and the hit points when damaged)', () => {
    const { w, healthy, damaged } = world();
    const s = snapOf(w);
    expect(buildingReadout(s, healthy.id, false)?.lines).toEqual(['Conveyor belt · Slow (1.7 tiles/s)']);
    const d = buildingReadout(s, damaged.id, true)!;
    expect(d.lines[0]).toBe('Conveyor belt · Medium (2.5 tiles/s)');
    expect(d.lines).toContain('hp 40 / 100');
    expect(d.lines).toContain('right-click: repair');
  });

  it('reserved and constructing sites: the speed they are being laid at', () => {
    const { w, reserved, building } = world();
    const s = snapOf(w);
    expect(siteReadout(null, s, reserved.id)?.lines[0]).toBe('Conveyor belt · Fast (3.3 tiles/s)');
    expect(siteReadout(null, s, reserved.id)?.lines[1]).toBe('reserved — not started');
    expect(siteReadout(null, s, building.id)?.lines[0]).toBe('Conveyor belt · Medium (2.5 tiles/s)');
    expect(siteReadout(null, s, building.id)?.lines[1]).toBe('30% complete');
  });

  it('upgrading: the speed now and the speed it is going to', () => {
    expect(buildingInfo(B.belt).tiers?.length, 'belts upgrade Slow → Medium → Fast').toBe(2);
    const { w, upgrading } = world();
    const s = snapOf(w);
    expect(siteReadout(null, s, upgrading.id)?.lines[0]).toBe('Conveyor belt · Slow (1.7 tiles/s) — upgrading to Medium (2.5 tiles/s)');
    expect(buildingReadout(s, upgrading.id, false)).toBeNull();
  });

  it('other kinds keep their readouts (an undamaged wall has none)', () => {
    const w = flatWorld(40, 40);
    const id = w.placeBuilding(B.wall, 5, 5, true);
    expect(buildingReadout(snapOf(w), id, false)).toBeNull();
  });
});

describe('W31 UI identity (test 16)', () => {
  type Entry = { id: string; kind: string; tier: number; label: string };
  const entries = () => (buildbar as unknown as { BUILD_ENTRIES?: Array<[string, Entry[]]> }).BUILD_ENTRIES ?? [];

  it('the build menu has three belt entries, Slow, Medium and Fast, with distinct ids; a locked entry names its research', () => {
    const belts = entries()
      .flatMap(([, list]) => list)
      .filter((e) => e.kind === 'belt');
    expect(belts.map((e) => e.tier)).toEqual([1, 2, 3]);
    expect(belts.map((e) => e.label)).toEqual(['Belt — Slow', 'Belt — Medium', 'Belt — Fast']);
    expect(new Set(belts.map((e) => e.id)).size).toBe(3);
    const all = entries().flatMap(([, list]) => list);
    expect(new Set(all.map((e) => e.id)).size, 'every entry id is unique').toBe(all.length);
    const lock = (buildbar as unknown as { entryLock: (e: Entry, done: (id: string) => boolean) => string | null }).entryLock;
    expect(typeof lock, 'entryLock').toBe('function');
    const none = () => false;
    expect(belts.map((e) => lock(e, none))).toEqual([null, 'Medium belts', 'Fast belts']);
    const medium = (id: string) => id === 'beltMedium';
    expect(belts.map((e) => lock(e, medium))).toEqual([null, null, 'Fast belts']);
  });

  it('B selects Slow, then Medium, then Fast as each research completes', () => {
    const fastest = (tools as unknown as { fastestBeltTier: (done: (id: string) => boolean) => number }).fastestBeltTier;
    expect(typeof fastest, 'fastestBeltTier').toBe('function');
    expect(fastest(() => false)).toBe(1);
    expect(fastest((id) => id === 'beltMedium')).toBe(2);
    expect(fastest((id) => id === 'beltMedium' || id === 'beltFast')).toBe(3);
    // the tool carries the speed; another kind resets it
    const t = new tools.Tools(() => true);
    t.choose('build', B.belt, 3);
    expect((t as unknown as { tier: number }).tier).toBe(3);
    t.choose('build', B.gun);
    expect((t as unknown as { tier: number }).tier).toBe(1);
  });

  it('the drag-plan cache keys on the speed: a paused switch Slow → Fast (same tick, same tiles) changes the preview cost', () => {
    const w = flatWorld(30, 20);
    const eng = w.spawnUnit(U.engineer, 5.5, 8.5);
    const s = snapOf(w);
    const v = viewOf(w, s);
    const cache = new DragPlanCache();
    const inputs = () => ({ view: v, ids: [eng] });
    const get = cache.get.bind(cache) as unknown as (...a: unknown[]) => ReturnType<DragPlanCache['get']>;
    const slow = get(s.tick, B.belt, [5, 5], [9, 5], 0, false, 1, inputs, 1);
    expect(slow.cost[0]).toBeCloseTo(5 * 0.5, 9);
    expect(get(s.tick, B.belt, [5, 5], [9, 5], 0, false, 1, inputs, 1), 'nothing changed').toBe(slow);
    const fast = get(s.tick, B.belt, [5, 5], [9, 5], 0, false, 1, inputs, 3);
    expect(fast).not.toBe(slow);
    expect(fast.cost[0]).toBeCloseTo(5 * 3.5, 9);
    expect(dragLabel(fast)).toMatch(/Fast/);
    const direct = (planDrag as unknown as (...a: unknown[]) => ReturnType<typeof planDrag>)(v, B.belt, [eng], [5, 5], [9, 5], 0, false, 1, 2);
    expect(direct.cost[0]).toBeCloseTo(5 * 1.5, 9);
    expect(dragLabel(direct)).toMatch(/5 tiles · Medium · 8 mass/);
  });

  it('the upgrade drag preview: per-destination counts and cost ("8 to Medium · 4 to Fast · 3 skipped · 16 mass"), skipped tiles listed, one target per belt with its expected speed', () => {
    const w = flatWorld(40, 20);
    research(w, 'beltMedium');
    research(w, 'beltFast');
    const eng = w.spawnUnit(U.engineer, 5.5, 8.5);
    // x 2..9 Slow, 10..13 Medium, 14 Fast (top), 15 Slow and upgrading, 16 a splitter
    const ids: number[] = [];
    for (let x = 2; x <= 15; x++) {
      const id = w.placeBuilding(B.belt, x, 5, true, 0);
      setTier(w, id, x <= 9 ? 1 : x <= 13 ? 2 : x === 14 ? 3 : 1);
      ids.push(id);
    }
    const c = w.buildings.cols;
    c.flags[w.buildings.slotForId(ids[13]!)] = c.flags[w.buildings.slotForId(ids[13]!)]! | BF_UPGRADING;
    w.placeBuilding(B.splitter, 16, 5, true, 0);
    const s = snapOf(w);
    const plan = (dragPlan as unknown as { planBeltUpgrade: (v: DragView, from: [number, number], to: [number, number], dir: number) => { targets: Array<{ id: number; expectedTier: number }>; skipped: Array<[number, number]>; toMedium: number; toFast: number; cost: number[] } }).planBeltUpgrade;
    const label = (dragPlan as unknown as { upgradeLabel: (p: unknown) => string }).upgradeLabel;
    expect([typeof plan, typeof label], 'planBeltUpgrade and upgradeLabel').toEqual(['function', 'function']);
    const p = plan(viewOf(w, s), [2, 5], [16, 5], 0);
    expect(label(p)).toBe('8 to Medium · 4 to Fast · 3 skipped · 16 mass');
    expect(p.targets).toEqual([...ids.slice(0, 8).map((id) => ({ id, expectedTier: 1 })), ...ids.slice(8, 12).map((id) => ({ id, expectedTier: 2 }))]);
    expect(p.skipped).toEqual([
      [14, 5],
      [15, 5],
      [16, 5],
    ]);
    expect(eng).toBeGreaterThanOrEqual(0);
    // without Fast belts researched, the Medium belts are skipped too
    const w2 = flatWorld(40, 20);
    research(w2, 'beltMedium');
    for (let x = 2; x <= 5; x++) setTier(w2, w2.placeBuilding(B.belt, x, 5, true, 0), x <= 3 ? 1 : 2);
    const p2 = plan(viewOf(w2, snapOf(w2)), [2, 5], [5, 5], 0);
    expect(label(p2)).toBe('2 to Medium · 2 skipped · 2 mass');
    expect(buildingInfo(B.belt).label).toBe('Conveyor belt');
  });
});
