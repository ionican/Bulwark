// W31 review fixes (Codex adversarial review, 12 Oct):
//   1  an unshifted belt drag over the issuers' own reserved sites at another speed: the preview and
//      what the release does agree. The drag replaces the whole owned reserved line at its speed
//      (PLAN-W31 item 5: the unshifted order frees the old sites by the W25 rule, then the new ones
//      are placed); a site another unit also holds is skipped and stays.
//   2  upgradeBelts with a unit id given twice: the recipients are deduplicated before the capacity
//      check, the queue replacement and the orders, so every belt flagged upgrading has an order.
//   3  upgradeBelts (and a single upgrade) whose only unit is gone before it applies is refused at
//      its tick: no flag and no queue changes.

import { describe, expect, it } from 'vitest';
import type { Command } from '../src/sim/commands.ts';
import { B, U } from '../src/sim/kinds.ts';
import { BF_UPGRADING, isReserved } from '../src/sim/schema.ts';
import type { World } from '../src/sim/world.ts';
import { decodeSnapshot, encodeSnapshot, type Snapshot } from '../src/sim/snapshot.ts';
import { buildOccupancy } from '../src/render/picking.ts';
import * as dragPlan from '../src/dragPlan.ts';
import { planDrag, type DragPlan, type DragView } from '../src/dragPlan.ts';
import { flatWorld } from './fixtures.ts';
import { research, setTier } from './w31-fixtures.ts';

const snapOf = (w: World) => decodeSnapshot(encodeSnapshot(w));
function viewOf(w: World, s: Snapshot): DragView {
  const c = s.buildings.cols;
  const occupancy = buildOccupancy({ count: s.buildings.count, id: s.buildings.id, kind: c.kind, tx: c.tx, ty: c.ty, fw: c.fw, fh: c.fh }, w.terrain.w, w.terrain.h, new Int32Array(w.terrain.w * w.terrain.h));
  return { terrain: w.terrain, occupancy, kinds: c.kind, units: { count: s.units.count, id: s.units.id, x: s.units.cols.x, z: s.units.cols.z }, snapshot: s };
}
const at = (w: World, x: number, z: number) => w.occupancy[z * w.terrain.w + x]! - 1;
/** The belt at (x, z): its tier and whether it is a reserved site, or null. */
function beltAt(w: World, x: number, z: number): { tier: number; reserved: boolean } | null {
  const s = at(w, x, z);
  const c = w.buildings.cols;
  return s >= 0 && c.kind[s] === B.belt ? { tier: c.tier[s]!, reserved: isReserved(c.flags[s]!) } : null;
}

describe('W31 review 1: a belt drag over the issuers’ own reserved sites at another speed', () => {
  /** A world with both belt researches, engineer `eng` far off holding reserved Slow sites at x 10..13, z 5 (facing +x), and engineer `other`. */
  function world() {
    const w = flatWorld(40, 30);
    research(w, 'beltMedium');
    research(w, 'beltFast');
    const eng = w.spawnUnit(U.engineer, 5.5, 25.5);
    const other = w.spawnUnit(U.engineer, 30.5, 25.5);
    for (let x = 10; x <= 13; x++) expect(w.submit({ t: 'build', ids: [eng], kind: B.belt, tx: x, ty: 5, dir: 0, tier: 1, queue: x > 10 } as Command), `Slow site ${x}`).toBeNull();
    w.step();
    for (let x = 10; x <= 13; x++) expect(beltAt(w, x, 5)).toEqual({ tier: 1, reserved: true });
    return { w, eng, other };
  }
  /** What the release sends for `plan` (dragPlan.ts beltLineRelease), applied in order: the clear first (its tick), then the builds. */
  function release(w: World, plan: DragPlan, ids: number[], queue: boolean) {
    const rel = (dragPlan as unknown as { beltLineRelease?: (p: DragPlan, ids: number[], queue: boolean) => { clear: Command | null; builds: Command[] } }).beltLineRelease;
    expect(typeof rel, 'dragPlan.beltLineRelease').toBe('function');
    const { clear, builds } = rel!(plan, ids, queue);
    if (clear) {
      expect(w.submit(clear)).toBeNull();
      w.step();
    }
    for (const c of builds) expect(w.submit(c), JSON.stringify(c)).toBeNull();
    w.step();
  }

  it('an unshifted Fast drag over four owned reserved Slow sites previews four Fast tiles and lays them', () => {
    const { w, eng } = world();
    const plan = planDrag(viewOf(w, snapOf(w)), B.belt, [eng], [10, 5], [13, 5], 0, false, 1, 3);
    expect([plan.build.length, plan.skipped.length], 'preview: tiles to lay, skipped').toEqual([4, 0]);
    release(w, plan, [eng], false);
    expect([10, 11, 12, 13].map((x) => beltAt(w, x, 5))).toEqual(Array(4).fill({ tier: 3, reserved: true }));
  });

  it('two free tiles then four owned: six Fast; a site another unit also holds is skipped and stays Slow', () => {
    const { w, eng, other } = world();
    const shared = w.buildings.id(at(w, 12, 5));
    expect(w.submit({ t: 'assist', ids: [other], target: shared, queue: false } as Command)).toBeNull();
    w.step();
    const plan = planDrag(viewOf(w, snapOf(w)), B.belt, [eng], [8, 5], [13, 5], 0, false, 1, 3);
    expect(plan.build.map(([x]) => x), 'preview: tiles to lay').toEqual([8, 9, 10, 11, 13]);
    expect(plan.skipped).toEqual([[12, 5]]);
    release(w, plan, [eng], false);
    const got = [8, 9, 10, 11, 12, 13].map((x) => beltAt(w, x, 5)?.tier);
    expect(got).toEqual([3, 3, 3, 3, 1, 3]);
    expect(got.filter((t) => t === 3).length, 'laid = previewed').toBe(plan.build.length);
  });

  it('with Shift the owned sites are skipped and left as they are', () => {
    const { w, eng } = world();
    const plan = planDrag(viewOf(w, snapOf(w)), B.belt, [eng], [10, 5], [13, 5], 0, true, 1, 3);
    expect([plan.build.length, plan.skipped.length]).toEqual([0, 4]);
    release(w, plan, [eng], true);
    expect([10, 11, 12, 13].map((x) => beltAt(w, x, 5)?.tier)).toEqual([1, 1, 1, 1]);
  });
});

/** `n` complete Slow belts at x 2.., z 5 (Medium researched) and engineer `eng`. */
function beltRow(n: number) {
  const w = flatWorld(80, 20);
  research(w, 'beltMedium');
  const ids: number[] = [];
  for (let k = 0; k < n; k++) {
    const id = w.placeBuilding(B.belt, 2 + k, 5, true, 0);
    setTier(w, id, 1);
    ids.push(id);
  }
  const eng = w.spawnUnit(U.engineer, 2.5, 12.5);
  return { w, ids, eng };
}
const batch = (ids: number[], targets: number[], queue: boolean): Command => ({ t: 'upgradeBelts', ids, targets: targets.map((id) => ({ id, expectedTier: 1 })), queue }) as unknown as Command;
/** Belts flagged upgrading that no unit's queue has a build order on. */
function stranded(w: World, ids: number[]): number[] {
  const ordered = new Set<number>();
  for (let s = 0; s < w.units.highWater; s++) for (const o of w.orders[s] ?? []) if (o.t === 'build') ordered.add(o.id);
  return ids.filter((id) => w.buildings.cols.flags[w.buildings.slotForId(id)]! & BF_UPGRADING && !ordered.has(id));
}
const flagged = (w: World, ids: number[]) => ids.filter((id) => w.buildings.cols.flags[w.buildings.slotForId(id)]! & BF_UPGRADING).length;

describe('W31 review 2: upgradeBelts with a unit id given twice', () => {
  it('unshifted, ids [eng, eng], 40 targets: 40 flagged, 40 orders, none stranded', () => {
    const { w, ids, eng } = beltRow(40);
    expect(w.submit(batch([eng, eng], ids, false))).toBeNull();
    w.step();
    expect(flagged(w, ids)).toBe(40);
    expect(stranded(w, ids)).toEqual([]);
    expect(w.orders[w.units.slotForId(eng)]!.length).toBe(40);
  });

  it('shifted onto 10 queued moves, ids [eng, eng], 40 targets: 50 orders, none stranded', () => {
    const { w, ids, eng } = beltRow(40);
    for (let k = 0; k < 10; k++) expect(w.submit({ t: 'move', ids: [eng], x: 3.5 + k, z: 15.5, queue: true } as Command)).toBeNull();
    w.step();
    expect(w.submit(batch([eng, eng], ids, true))).toBeNull();
    w.step();
    expect(flagged(w, ids)).toBe(40);
    expect(stranded(w, ids)).toEqual([]);
    expect(w.orders[w.units.slotForId(eng)]!.length).toBe(50);
  });

  it('the capacity check counts a duplicated id once: 60 queued + 4 targets fits; 61 + 4 does not', () => {
    for (const [queued, ok] of [
      [60, true],
      [61, false],
    ] as const) {
      const { w, ids, eng } = beltRow(4);
      for (let k = 0; k < queued; k++) w.submit({ t: 'move', ids: [eng], x: 3.5 + (k % 30), z: 15.5, queue: true } as Command);
      w.step();
      const r = w.submit(batch([eng, eng], ids, true));
      expect(r === null, `${queued} queued: ${r}`).toBe(ok);
    }
  });
});

describe('W31 review 3: the only unit is gone before the upgrade applies', () => {
  it('upgradeBelts: refused at its tick; no belt flagged, no queue changed', () => {
    const { w, ids, eng } = beltRow(3);
    expect(w.submit(batch([eng], ids, false))).toBeNull();
    w.units.remove(w.units.slotForId(eng));
    w.step();
    expect(flagged(w, ids)).toBe(0);
    expect(w.applyRejected.at(-1)?.reason).toMatch(/no live unit/);
  });

  it('a single upgrade: refused at its tick; the belt is not flagged', () => {
    const { w, ids, eng } = beltRow(1);
    expect(w.submit({ t: 'upgrade', ids: [eng], target: ids[0]!, queue: false } as Command)).toBeNull();
    w.units.remove(w.units.slotForId(eng));
    w.step();
    expect(flagged(w, ids)).toBe(0);
    expect(w.applyRejected.at(-1)?.reason).toMatch(/no live unit/);
  });

  it('with one of two units gone the batch applies to the one left', () => {
    const { w, ids, eng } = beltRow(3);
    const e2 = w.spawnUnit(U.engineer, 4.5, 12.5);
    expect(w.submit(batch([eng, e2], ids, false))).toBeNull();
    w.units.remove(w.units.slotForId(eng));
    w.step();
    expect(flagged(w, ids)).toBe(3);
    expect(stranded(w, ids)).toEqual([]);
  });
});
