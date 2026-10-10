// W24 run 3, Richard (10 Oct): "paint" a row of buildings. In build mode with any kind but walls,
// belt kinds and the gate, a left drag lays a row of that building along the drag's main axis,
// from the drag's start, footprints edge to edge (2 × 2 kinds step 2), at most 32. Each position
// passes the single-click placement rule (free ground, deposits for extractors, C2's own reserved
// site); blocked ones are skipped. The preview and the release use one planner (dragPlan.ts
// planDrag → buildingRowTiles); the release sends one build per placed position, the first with
// Shift's queue flag and the rest appended (as a belt line). Browser half: check-panel.mjs.

import { describe, expect, it } from 'vitest';
import { B, U, buildingInfo } from '../src/sim/kinds.ts';
import { decodeSnapshot, encodeSnapshot } from '../src/sim/snapshot.ts';
import { flatTerrain } from '../src/sim/terrain.ts';
import type { World } from '../src/sim/world.ts';
import { buildOccupancy } from '../src/render/picking.ts';
import { ROW_MAX, buildingRowTiles, dragLabel, paintsRow, planDrag, rowBuildCommands, type DragView } from '../src/dragPlan.ts';
import { flatWorld } from './fixtures.ts';

function viewOf(w: World): DragView {
  const snap = decodeSnapshot(encodeSnapshot(w));
  const b = snap.buildings;
  const occ = buildOccupancy({ count: b.count, id: b.id, kind: b.cols.kind, tx: b.cols.tx, ty: b.cols.ty, fw: b.cols.fw, fh: b.cols.fh }, w.terrain.w, w.terrain.h, new Int32Array(w.terrain.w * w.terrain.h));
  return { terrain: w.terrain, occupancy: occ, kinds: b.cols.kind, units: { count: snap.units.count, id: snap.units.id, x: snap.units.cols.x, z: snap.units.cols.z }, snapshot: snap };
}

describe('Richard 10 Oct: a drag paints a row of buildings', () => {
  it('which kinds paint a row: everything but walls, belt kinds and the gate', () => {
    for (const k of [B.generator, B.gun, B.lab, B.massExtractor, B.shield, B.heavy, B.depot]) expect(paintsRow(k), buildingInfo(k).label).toBe(true);
    for (const k of [B.wall, B.belt, B.splitter, B.merger, B.gate]) expect(paintsRow(k), buildingInfo(k).label).toBe(false);
  });

  it('the row runs along the drag’s main axis from its start, footprints edge to edge', () => {
    // 2 × 2: step 2 along x (|dx| ≥ |dz|), as many as fit up to the end
    expect(buildingRowTiles(B.generator, [10, 10], [17, 12])).toEqual([[10, 10], [12, 10], [14, 10], [16, 10]]);
    // along z when it dominates; backwards too
    expect(buildingRowTiles(B.generator, [10, 10], [11, 4])).toEqual([[10, 10], [10, 8], [10, 6], [10, 4]]);
    // 3 × 3 steps 3; 1 × 1 steps 1
    expect(buildingRowTiles(B.lab, [5, 5], [13, 5])).toEqual([[5, 5], [8, 5], [11, 5]]);
    expect(buildingRowTiles(B.tempTurret, [5, 5], [8, 5])).toEqual([[5, 5], [6, 5], [7, 5], [8, 5]]);
  });

  it('a drag shorter than one footprint is one building at the start', () => {
    expect(buildingRowTiles(B.generator, [10, 10], [11, 10])).toEqual([[10, 10]]);
    expect(buildingRowTiles(B.generator, [10, 10], [10, 10])).toEqual([[10, 10]]);
  });

  it(`at most ${32} per drag`, () => {
    expect(ROW_MAX).toBe(32);
    const row = buildingRowTiles(B.tempTurret, [0, 0], [100, 0]);
    expect(row.length).toBe(32);
    expect(row[31]).toEqual([31, 0]);
  });

  it('blocked positions are skipped: an existing building, rock, an extractor off its deposit', () => {
    const w = flatWorld(60, 30, { rich: true, terrain: { rocks: [[15, 11]], deposits: [{ tx: 30, ty: 10, kind: 'mass' }, { tx: 34, ty: 10, kind: 'mass' }] } });
    const e = w.spawnUnit(U.engineer, 5.5, 20.5);
    w.enqueue({ t: 'build', ids: [e], kind: B.gun, tx: 12, ty: 10, dir: 0, queue: false });
    w.step();
    const v = viewOf(w);
    const p = planDrag(v, B.generator, [e], [10, 10], [19, 10], 0, false);
    expect(p.build.map(([x, y]) => [x, y])).toEqual([[10, 10], [16, 10], [18, 10]]);
    expect(p.skipped).toEqual([[12, 10], [14, 10]]);
    const m = planDrag(v, B.massExtractor, [e], [30, 10], [37, 10], 0, false);
    expect(m.build.map(([x, y]) => [x, y]), 'only on the mass deposits').toEqual([[30, 10], [34, 10]]);
    expect(m.skipped).toEqual([[32, 10], [36, 10]]);
    expect(dragLabel(p).startsWith(`${buildingInfo(B.generator).label} × 3 (2 skipped)`), dragLabel(p)).toBe(true);
  });

  it('C2: the builders’ own reserved site is placeable as the first, unshifted position only', () => {
    const w = flatWorld(40, 30, { rich: true });
    const e = w.spawnUnit(U.engineer, 2.5, 25.5);
    w.enqueue({ t: 'build', ids: [e], kind: B.generator, tx: 10, ty: 10, dir: 0, queue: true });
    w.step();
    const v = viewOf(w);
    expect(planDrag(v, B.generator, [e], [10, 10], [15, 10], 0, false).build.map(([x, y]) => [x, y])).toEqual([[10, 10], [12, 10], [14, 10]]);
    // Shift: every position appends, so the reserved site is blocked
    const q = planDrag(v, B.generator, [e], [10, 10], [15, 10], 0, true);
    expect(q.build.map(([x, y]) => [x, y])).toEqual([[12, 10], [14, 10]]);
    expect(q.skipped).toEqual([[10, 10]]);
    // later positions append, so a reserved site of theirs further along is skipped
    const r = planDrag(v, B.generator, [e], [8, 10], [13, 10], 0, false);
    expect(r.build.map(([x, y]) => [x, y])).toEqual([[8, 10], [12, 10]]);
    expect(r.skipped).toEqual([[10, 10]]);
  });

  it('the release: one build per placed position, the first takes Shift’s flag, the rest append', () => {
    const w = flatWorld(40, 30, { rich: true });
    const e = w.spawnUnit(U.engineer, 2.5, 25.5);
    const v = viewOf(w);
    const plan = planDrag(v, B.generator, [e], [10, 10], [17, 10], 1, false);
    const cmds = rowBuildCommands(plan, [e], false);
    expect(cmds).toEqual([10, 12, 14, 16].map((x, i) => ({ t: 'build', ids: [e], kind: B.generator, tx: x, ty: 10, dir: 1, queue: i > 0 })));
    expect(rowBuildCommands(plan, [e], true).map((c) => c.queue)).toEqual([true, true, true, true]);
    // the simulation accepts them: four reserved generator sites, in the builder's queue in order
    for (const c of cmds) expect(w.submit(c)).toBeNull();
    w.step();
    expect(w.applyRejected).toEqual([]);
    const sites = [10, 12, 14, 16].map((x) => w.occupancy[10 * 40 + x]! - 1);
    expect(sites.every((s) => s >= 0 && w.buildings.cols.kind[s] === B.generator)).toBe(true);
    expect((w.orders[w.units.slotForId(e)] ?? []).length).toBe(4);
  });
});
