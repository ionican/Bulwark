// W25 item 7: the drag preview's tiles are the simulation's. The render thread plans a wall drag
// from the latest snapshot (dragPlan.ts planWallDrag over runs.ts planRunOn) and must lay out
// exactly what the simulation's planRun lays when the buildRun command arrives: the same tiles in
// the same order, the same skipped tiles (rock, wall, blocked), the same refusals (the 128-tile
// cap, an end off the map). Belt lines: the preview's built and skipped tiles are the ones the
// placement sends and the simulation accepts.

import { describe, expect, it } from 'vitest';
import { B, U } from '../src/sim/kinds.ts';
import { decodeSnapshot, encodeSnapshot, type Snapshot } from '../src/sim/snapshot.ts';
import { MAX_RUN_LENGTH, planRun } from '../src/sim/runs.ts';
import { buildOccupancy } from '../src/render/picking.ts';
import { beltLineTiles, planDrag, planWallDrag, type DragView } from '../src/dragPlan.ts';
import { World } from '../src/sim/world.ts';
import { flatWorld } from './fixtures.ts';

const ROCKS: Array<[number, number]> = [
  [14, 10],
  [15, 11],
  [30, 20],
  [31, 20],
];

/** A 160 × 40 world (wide enough for the 128-tile cap) with rock, walls, a reserved wall site, a turret and a gate. */
function fixture() {
  const w = flatWorld(160, 40, { rich: true, terrain: { rocks: ROCKS } });
  const a = w.spawnUnit(U.engineer, 4.5, 12.5);
  const b = w.spawnUnit(U.engineer, 150.5, 30.5);
  for (const x of [18, 19, 20]) w.placeBuilding(B.wall, x, 10, true); // complete walls
  w.placeBuilding(B.wall, 22, 11, false); // a reserved wall site counts as wall
  w.placeBuilding(B.gun, 24, 10, true); // 2 × 2: blocked
  for (let x = 40; x <= 44; x++) w.placeBuilding(B.wall, x, 30, true);
  expect(w.convertToGate(42, 30)).toBeGreaterThanOrEqual(0); // a gate counts as wall
  return { w, a, b };
}

function viewOf(w: World): { snap: Snapshot; view: DragView } {
  const snap = decodeSnapshot(encodeSnapshot(w));
  const c = snap.buildings.cols;
  const occupancy = buildOccupancy({ count: snap.buildings.count, id: snap.buildings.id, kind: c.kind, tx: c.tx, ty: c.ty, fw: c.fw, fh: c.fh }, w.terrain.w, w.terrain.h, new Int32Array(w.terrain.w * w.terrain.h));
  return { snap, view: { terrain: w.terrain, occupancy, kinds: c.kind, units: { count: snap.units.count, id: snap.units.id, x: snap.units.cols.x, z: snap.units.cols.z } } };
}

const CASES: Array<{ name: string; from: [number, number]; to: [number, number]; depth: number; ids: 'a' | 'b' | 'ab' | 'none' }> = [
  { name: 'along x through rock, walls, a site and a turret', from: [10, 10], to: [30, 10], depth: 1, ids: 'a' },
  { name: 'depth 2, rows towards +z', from: [10, 10], to: [30, 12], depth: 2, ids: 'a' },
  { name: 'depth 4, rows towards -z (to above the axis)', from: [12, 14], to: [33, 9], depth: 4, ids: 'ab' },
  { name: 'along z, builders at the far end', from: [15, 2], to: [16, 30], depth: 3, ids: 'b' },
  { name: 'a tie goes along x', from: [5, 5], to: [12, 12], depth: 2, ids: 'none' },
  { name: 'through the gate and its walls', from: [36, 30], to: [48, 31], depth: 2, ids: 'a' },
  { name: 'a single tile', from: [8, 20], to: [8, 20], depth: 1, ids: 'a' },
  { name: 'exactly 128 tiles', from: [10, 35], to: [10 + MAX_RUN_LENGTH - 1, 35], depth: 1, ids: 'b' },
  { name: '129 tiles: over the cap', from: [10, 35], to: [10 + MAX_RUN_LENGTH, 36], depth: 1, ids: 'a' },
  { name: 'an end off the map', from: [10, 35], to: [10, 45], depth: 1, ids: 'a' },
];

describe('W25 item 7: the drag preview plans exactly what the simulation lays', () => {
  for (const c of CASES) {
    it(`wall run: ${c.name}`, () => {
      const { w, a, b } = fixture();
      const ids = c.ids === 'a' ? [a] : c.ids === 'b' ? [b] : c.ids === 'ab' ? [a, b] : [];
      const { view } = viewOf(w);
      const sim = planRun(w, { ids, from: c.from, to: c.to, depth: c.depth });
      const preview = planWallDrag(view, ids, c.from, c.to, c.depth);
      expect(preview).toEqual(sim);
      if (c.name.startsWith('129')) expect(sim).toMatch(/at most 128/);
      if (c.name.startsWith('exactly')) expect(typeof sim !== 'string' && sim.tiles.length).toBe(MAX_RUN_LENGTH);
      if (c.name.startsWith('along x')) {
        if (typeof sim === 'string') throw new Error(sim);
        expect(sim.skipped).toEqual({ rock: 1, wall: 3, blocked: 2, total: 6 });
        expect(sim.skippedAt).toEqual([[14, 10], [18, 10], [19, 10], [20, 10], [24, 10], [25, 10]]);
      }
    });
  }

  it('the sites the buildRun command lays stand on the previewed tiles', () => {
    const { w, a } = fixture();
    const { view } = viewOf(w);
    const plan = planDrag(view, B.wall, [a], [10, 10], [30, 12]);
    expect(w.submit({ t: 'buildRun', ids: [a], from: [10, 10], to: [30, 12], depth: 1 })).toBeNull();
    w.step();
    const run = w.runs.find((r) => r !== null)!;
    const laid = run.sites.map((id) => {
      const s = w.buildings.slotForId(id);
      return [w.buildings.cols.tx[s]!, w.buildings.cols.ty[s]!];
    });
    expect(laid).toEqual(plan.build.map(([x, y]) => [x, y]));
    expect(plan.cost).toEqual([100 * laid.length, 150 * laid.length, 0]); // wall: 100 mass, 150 energy (W12)
  });

  it('belt line: the previewed pieces are the ones placed, the skipped ones are refused', () => {
    const { w, a } = fixture();
    const { view } = viewOf(w);
    const plan = planDrag(view, B.belt, [a], [8, 10], [27, 10], 0);
    const line = beltLineTiles(8, 10, 27, 10, 0);
    expect(plan.build.length + plan.skipped.length).toBe(line.length);
    for (const [x, y, dir] of line) {
      const placed = plan.build.some(([px, py, pd]) => px === x && py === y && pd === dir);
      expect(placed, `${x},${y}`).toBe(w.canPlace(B.belt, x, y));
      expect(w.submit({ t: 'build', ids: [a], kind: B.belt, tx: x, ty: y, dir, queue: true }) === null, `${x},${y} accepted`).toBe(placed);
    }
    expect(plan.skipped).toEqual([[14, 10], [18, 10], [19, 10], [20, 10], [24, 10], [25, 10]]);
  });
});
