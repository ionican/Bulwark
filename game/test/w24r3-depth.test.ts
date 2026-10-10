// W24 run 3, criterion 2 (wall-run depth, Codex R1-11): the depth chosen in the panel reaches the
// drag preview as well as the command. The preview plans with the depth (dragPlan.ts planDrag), so
// depths 2–4 on both axes preview exactly the tiles the simulation lays, and the preview cache is
// keyed on the depth, so changing it while paused (same snapshot tick) redraws the preview.

import { describe, expect, it } from 'vitest';
import { B, U } from '../src/sim/kinds.ts';
import { DragPlanCache, planDrag, type DragView } from '../src/dragPlan.ts';
import { planRun } from '../src/sim/runs.ts';
import { decodeSnapshot, encodeSnapshot } from '../src/sim/snapshot.ts';
import { buildOccupancy } from '../src/render/picking.ts';
import { flatWorld } from './fixtures.ts';

describe('run 3 criterion 2: wall-run depth in the drag preview', () => {
  it('the drag preview plans with the depth: depths 2–4 on both axes lay exactly the tiles the simulation lays', () => {
    const w = flatWorld(60, 60, { rich: true });
    const e = w.spawnUnit(U.engineer, 30.5, 30.5);
    w.step();
    const snap = decodeSnapshot(encodeSnapshot(w));
    const b = snap.buildings;
    const occ = buildOccupancy({ count: b.count, id: b.id, kind: b.cols.kind, tx: b.cols.tx, ty: b.cols.ty, fw: b.cols.fw, fh: b.cols.fh }, 60, 60, new Int32Array(60 * 60));
    const v: DragView = { terrain: w.terrain, occupancy: occ, kinds: b.cols.kind, units: { count: snap.units.count, id: snap.units.id, x: snap.units.cols.x, z: snap.units.cols.z }, snapshot: snap };
    const ends: Array<[[number, number], [number, number]]> = [
      [[10, 10], [24, 12]], // along x, rows towards +z
      [[40, 10], [38, 24]], // along z, rows towards -x
    ];
    for (const depth of [2, 3, 4])
      for (const [from, to] of ends) {
        const plan = planDrag(v, B.wall, [e], from, to, 0, false, depth);
        const sim = planRun(w, { ids: [e], from, to, depth });
        if (typeof sim === 'string') throw new Error(sim);
        expect(plan.build.map(([x, y]) => [x, y]), `depth ${depth} ${JSON.stringify(from)}→${JSON.stringify(to)}`).toEqual(sim.tiles);
        expect(plan.build.length).toBe(15 * depth);
      }
  });

  it('the preview is worked out again when only the depth changes (paused: same tick)', () => {
    const w = flatWorld(40, 40, { rich: true });
    const e = w.spawnUnit(U.engineer, 20.5, 20.5);
    const snap = decodeSnapshot(encodeSnapshot(w));
    const b = snap.buildings;
    const occ = buildOccupancy({ count: b.count, id: b.id, kind: b.cols.kind, tx: b.cols.tx, ty: b.cols.ty, fw: b.cols.fw, fh: b.cols.fh }, 40, 40, new Int32Array(40 * 40));
    const v: DragView = { terrain: w.terrain, occupancy: occ, kinds: b.cols.kind, units: { count: snap.units.count, id: snap.units.id, x: snap.units.cols.x, z: snap.units.cols.z }, snapshot: snap };
    const cache = new DragPlanCache();
    const a = cache.get(v, snap.tick, B.wall, [e], [5, 5], [12, 5], 0, false, 1);
    expect(a.build.length).toBe(8);
    expect(cache.get(v, snap.tick, B.wall, [e], [5, 5], [12, 5], 0, false, 1), 'nothing changed: the same plan object').toBe(a);
    const c = cache.get(v, snap.tick, B.wall, [e], [5, 5], [12, 5], 0, false, 3);
    expect(c).not.toBe(a);
    expect(c.build.length).toBe(24);
  });
});
