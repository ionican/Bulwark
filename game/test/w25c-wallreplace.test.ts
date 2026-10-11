// W25c finding 1 (Codex adversarial review, 9 Oct, high): replacing an overlapping wall run left
// holes. The new run was planned against the existing reservations before the replaced orders lost
// them, so it skipped the unit's own reserved tiles as walls; the cleanup then removed exactly
// those tiles. Probe: a reserved run at x = 10–14 replaced, without Shift, by x = 10–19 left only
// x = 15–19, and nothing was refused.
// Required: an unshifted order keeps the unit's own reserved tiles that the new run covers; the
// result is exactly the tiles the new order asks for; another unit's reservation stays with that
// unit; the drag preview shows the same tiles by the same rule.

import { describe, expect, it } from 'vitest';
import { B, U } from '../src/sim/kinds.ts';
import { isReserved } from '../src/sim/schema.ts';
import { decodeSnapshot, encodeSnapshot } from '../src/sim/snapshot.ts';
import { buildOccupancy } from '../src/render/picking.ts';
import { planWallDrag, type DragView } from '../src/dragPlan.ts';
import type { Command } from '../src/sim/commands.ts';
import type { World } from '../src/sim/world.ts';
import { flatWorld } from './fixtures.ts';

type Tile = [number, number];

/** Submits (validated) and steps once; fails on a refusal at submit or at the tick. */
function apply(w: World, cmd: Command): void {
  const why = w.submit(cmd);
  if (why) throw new Error(`refused: ${why}`);
  const n = w.applyRejected.length;
  w.step();
  if (w.applyRejected.length !== n) throw new Error(`refused at its tick: ${w.applyRejected[n]!.reason}`);
}

const run = (ids: number[], from: Tile, to: Tile, queue = false): Command => ({ t: 'buildRun', ids, from, to, depth: 1, queue });

/** Wall sites (any state) standing in the rectangle, as "x,y" sorted. */
function wallTiles(w: World, x0 = 0, y0 = 0, x1 = 47, y1 = 47): string[] {
  const out: string[] = [];
  const c = w.buildings.cols;
  for (let s = 0; s < w.buildings.highWater; s++) {
    if (!w.buildings.alive[s] || c.kind[s] !== B.wall) continue;
    const x = c.tx[s]!;
    const y = c.ty[s]!;
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out.push(`${x},${y}`);
  }
  return out.sort();
}
const tiles = (list: Tile[]) => list.map(([x, y]) => `${x},${y}`).sort();
const xs = (x0: number, x1: number, y: number): Tile[] => Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, y]);
const siteAt = (w: World, x: number, y: number) => {
  const s = w.occupancy[y * w.terrain.w + x]! - 1;
  return s < 0 ? -1 : w.buildings.id(s);
};
/** Tiles of the run(s) unit `id` works on, as "x,y" sorted. */
function runTilesOf(w: World, id: number): string[] {
  const out: string[] = [];
  for (const o of w.orders[w.units.slotForId(id)] ?? []) {
    if (o.t !== 'run') continue;
    const r = w.runs.find((x) => x?.id === o.run);
    for (const site of r?.sites ?? []) {
      const s = w.buildings.slotForId(site);
      if (s >= 0) out.push(`${w.buildings.cols.tx[s]},${w.buildings.cols.ty[s]}`);
    }
  }
  return out.sort();
}

/** The render thread's view of the latest snapshot, as main.ts builds it (with the snapshot for the replacement rule). */
function viewOf(w: World): DragView {
  const snap = decodeSnapshot(encodeSnapshot(w));
  const c = snap.buildings.cols;
  const occupancy = buildOccupancy({ count: snap.buildings.count, id: snap.buildings.id, kind: c.kind, tx: c.tx, ty: c.ty, fw: c.fw, fh: c.fh }, w.terrain.w, w.terrain.h, new Int32Array(w.terrain.w * w.terrain.h));
  return { terrain: w.terrain, occupancy, kinds: c.kind, units: { count: snap.units.count, id: snap.units.id, x: snap.units.cols.x, z: snap.units.cols.z }, snapshot: snap } as DragView;
}

/** Preview of an unshifted drag for `ids` (as the wall tool lays it), as "x,y" sorted. */
function preview(w: World, ids: number[], from: Tile, to: Tile, queue = false): string[] {
  const p = (planWallDrag as (...a: unknown[]) => ReturnType<typeof planWallDrag>)(viewOf(w), ids, from, to, 1, queue);
  if (typeof p === 'string') throw new Error(p);
  return tiles(p.tiles);
}

/** An engineer far from the work (nothing starts during the test) and a flat, rich world. */
function setup() {
  const w = flatWorld(48, 48, { rich: true });
  const a = w.spawnUnit(U.engineer, 44.5, 44.5);
  const b = w.spawnUnit(U.engineer, 44.5, 40.5);
  return { w, a, b };
}

describe('W25c finding 1: an unshifted run keeps the unit’s own reserved tiles it covers', () => {
  it('extension (the review probe): x 10–14 replaced by x 10–19 leaves exactly x 10–19, the first five sites kept', () => {
    const { w, a } = setup();
    apply(w, run([a], [10, 20], [14, 20]));
    const kept = xs(10, 14, 20).map(([x, y]) => siteAt(w, x, y));
    const want = tiles(xs(10, 19, 20));
    expect(preview(w, [a], [10, 20], [19, 20])).toEqual(want);
    apply(w, run([a], [10, 20], [19, 20]));
    expect(wallTiles(w)).toEqual(want);
    expect(runTilesOf(w, a)).toEqual(want);
    expect(xs(10, 14, 20).map(([x, y]) => siteAt(w, x, y))).toEqual(kept);
    for (const [x, y] of xs(10, 19, 20)) expect(isReserved(w.buildings.cols.flags[w.buildings.slotForId(siteAt(w, x, y))]!), `${x},${y} reserved`).toBe(true);
    expect(w.runs.filter((r) => r !== null).length).toBe(1);
    expect(w.applyRejected).toEqual([]);
  });

  it('shortening: x 10–19 replaced by x 10–14 leaves exactly x 10–14', () => {
    const { w, a } = setup();
    apply(w, run([a], [10, 20], [19, 20]));
    const want = tiles(xs(10, 14, 20));
    expect(preview(w, [a], [10, 20], [14, 20])).toEqual(want);
    apply(w, run([a], [10, 20], [14, 20]));
    expect(wallTiles(w)).toEqual(want);
    expect(runTilesOf(w, a)).toEqual(want);
  });

  it('another unit’s reservation stays with that unit: A’s new run gets only the free tiles', () => {
    const { w, a, b } = setup();
    apply(w, run([b], [10, 20], [14, 20])); // B's run
    apply(w, run([a], [15, 20], [17, 20])); // A's own run
    const bSites = xs(10, 14, 20).map(([x, y]) => siteAt(w, x, y));
    const want = tiles(xs(15, 19, 20));
    expect(preview(w, [a], [10, 20], [19, 20])).toEqual(want);
    apply(w, run([a], [10, 20], [19, 20]));
    expect(runTilesOf(w, b)).toEqual(tiles(xs(10, 14, 20)));
    expect(xs(10, 14, 20).map(([x, y]) => siteAt(w, x, y))).toEqual(bSites);
    expect(runTilesOf(w, a)).toEqual(want);
    expect(wallTiles(w)).toEqual(tiles(xs(10, 19, 20)));
  });

  it('a run A shares with B stays B’s: A’s replacement does not take its tiles', () => {
    const { w, a, b } = setup();
    apply(w, run([a, b], [10, 20], [14, 20]));
    const want = tiles(xs(15, 19, 20));
    expect(preview(w, [a], [10, 20], [19, 20])).toEqual(want);
    apply(w, run([a], [10, 20], [19, 20]));
    expect(runTilesOf(w, b)).toEqual(tiles(xs(10, 14, 20)));
    expect(runTilesOf(w, a)).toEqual(want);
  });

  it('crossing run: the old run goes except the tile the new one crosses, which stays in the new run', () => {
    const { w, a } = setup();
    apply(w, run([a], [10, 20], [14, 20])); // along x
    const crossing = siteAt(w, 12, 20);
    const want = tiles(Array.from({ length: 11 }, (_, i): Tile => [12, 15 + i])); // along z, through (12, 20)
    expect(preview(w, [a], [12, 15], [12, 25])).toEqual(want);
    apply(w, run([a], [12, 15], [12, 25]));
    expect(wallTiles(w)).toEqual(want);
    expect(runTilesOf(w, a)).toEqual(want);
    expect(siteAt(w, 12, 20)).toBe(crossing);
  });

  it('with Shift nothing is replaced: the new run skips the unit’s own reserved tiles (preview too)', () => {
    const { w, a } = setup();
    apply(w, run([a], [10, 20], [14, 20]));
    const want = tiles(xs(15, 19, 20));
    expect(preview(w, [a], [10, 20], [19, 20], true)).toEqual(want);
    apply(w, run([a], [10, 20], [19, 20], true));
    expect(wallTiles(w)).toEqual(tiles(xs(10, 19, 20)));
    expect(w.orders[w.units.slotForId(a)]!.length).toBe(2);
  });
});
