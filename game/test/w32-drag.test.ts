// W32 (PLAN-W32 test 7): the demolish drag. On a line crossing six walls, a 2 × 2 smelter (twice), a
// wall already being demolished, the core and an unfinished site, the preview (dragPlan.ts, on the
// snapshot) targets 8 buildings in drag order and skips the core and the site; the command's own plan
// (validate.ts planDemolish, on the world) applies the same skip rule (kinds.ts demolishSkip) and
// gives the same targets, counts and refund; the release reuses the cached preview plan.

import { describe, expect, it } from 'vitest';
import type { Command } from '../src/sim/commands.ts';
import { B, U } from '../src/sim/kinds.ts';
import type { World } from '../src/sim/world.ts';
import { decodeSnapshot, encodeSnapshot, type Snapshot } from '../src/sim/snapshot.ts';
import { buildOccupancy } from '../src/render/picking.ts';
import * as dragPlan from '../src/dragPlan.ts';
import * as validate from '../src/sim/validate.ts';
import * as kinds from '../src/sim/kinds.ts';
import type { DragView } from '../src/dragPlan.ts';
import { flatWorld } from './fixtures.ts';
import { demolish, setDemolish } from './w32-fixtures.ts';

const snapOf = (w: World) => decodeSnapshot(encodeSnapshot(w));
function viewOf(w: World, s: Snapshot): DragView {
  const c = s.buildings.cols;
  const occupancy = buildOccupancy({ count: s.buildings.count, id: s.buildings.id, kind: c.kind, tx: c.tx, ty: c.ty, fw: c.fw, fh: c.fh }, w.terrain.w, w.terrain.h, new Int32Array(w.terrain.w * w.terrain.h));
  return { terrain: w.terrain, occupancy, kinds: c.kind, units: { count: s.units.count, id: s.units.id, x: s.units.cols.x, z: s.units.cols.z }, snapshot: s };
}

interface Preview {
  all: number[];
  targets: number[];
  tiles: Array<[number, number, number, number]>;
  skipped: Array<[number, number]>;
  skips: { core: number; site: number };
  refund: number[];
  itemsLost: boolean;
}
type PlanFn = (v: DragView, from: [number, number], to: [number, number]) => Preview;
interface Plan {
  units: number[];
  ids: number[];
  refund: number[];
  skipped: { duplicate: number; gone: number; core: number; site: number };
}

/** z = 10 from x = 2: walls 2..7, a smelter at (8, 9), a wall at 10 being demolished, the core at (11, 9), a wall site at 14. */
function layout() {
  const w = flatWorld(40, 30, { rich: true });
  const eng = w.spawnUnit(U.engineer, 6.5, 13.5);
  const walls = [2, 3, 4, 5, 6, 7].map((x) => w.placeBuilding(B.wall, x, 10, true));
  const smelter = w.placeBuilding(B.smelter, 8, 9, true);
  const marked = w.placeBuilding(B.wall, 10, 10, true);
  setDemolish(w, marked, 0.3);
  const core = w.placeBuilding(B.core, 11, 9, true);
  const site = w.placeBuilding(B.wall, 14, 10, false);
  for (const id of [...walls, smelter, marked, core, site]) expect(id).toBeGreaterThanOrEqual(0);
  return { w, eng, walls, smelter, marked, core, site };
}

describe('W32 demolish drag plan (test 7)', () => {
  it('8 targets in drag order (the part-demolished wall included), skipped {core 1, site 1}; the command plans the same targets, counts and refund', () => {
    const { w, eng, walls, smelter, marked, core, site } = layout();
    const plan = (dragPlan as unknown as { planDemolishPreview?: PlanFn }).planDemolishPreview;
    const planDemolish = (validate as unknown as { planDemolish?: (w: World, cmd: Command) => Plan | string }).planDemolish;
    expect([typeof plan, typeof planDemolish], 'planDemolishPreview and planDemolish').toEqual(['function', 'function']);
    const p = plan!(viewOf(w, snapOf(w)), [2, 10], [16, 10]);
    expect(p.targets).toEqual([...walls, smelter, marked]);
    expect(p.all).toEqual([...walls, smelter, marked, core, site]);
    expect(p.skips).toEqual({ core: 1, site: 1 });
    expect(p.refund).toEqual([7 * 50 + 60, 0, 0]);
    expect(p.itemsLost).toBe(false);
    // each target's footprint is marked: the smelter's 2 × 2 once
    expect(p.tiles).toEqual([...[2, 3, 4, 5, 6, 7].map((x) => [x, 10, 1, 1]), [8, 9, 2, 2], [10, 10, 1, 1]]);
    // the skipped tiles on the line: three of the core's, the site's
    expect(p.skipped).toEqual([
      [11, 10],
      [12, 10],
      [13, 10],
      [14, 10],
    ]);
    const cmdPlan = planDemolish!(w, demolish([eng], p.all));
    expect(typeof cmdPlan, `refused: ${String(cmdPlan)}`).toBe('object');
    const cp = cmdPlan as Plan;
    expect(cp.ids).toEqual(p.targets);
    expect(cp.skipped).toEqual({ duplicate: 0, gone: 0, ...p.skips });
    expect(cp.refund).toEqual(p.refund);
    // both sides read one rule
    const skip = (kinds as unknown as { demolishSkip?: (kind: number, flags: number) => string | null }).demolishSkip;
    expect(typeof skip).toBe('function');
    expect([skip!(B.core, 1), skip!(B.wall, 0), skip!(B.wall, 1 | 32)]).toEqual(['core', 'site', null]);
  });

  it('the release reuses the cached preview plan while the tick and tiles match; a new tick or tile plans again', () => {
    const { w } = layout();
    const Cache = (dragPlan as unknown as { DemolishPreviewCache?: new () => { get(tick: number, from: [number, number], to: [number, number], view: () => DragView): Preview } }).DemolishPreviewCache;
    expect(typeof Cache, 'DemolishPreviewCache').toBe('function');
    const cache = new Cache!();
    const s = snapOf(w);
    let made = 0;
    const view = () => {
      made++;
      return viewOf(w, s);
    };
    const a = cache.get(s.tick, [2, 10], [16, 10], view);
    const b = cache.get(s.tick, [2, 10], [16, 10], view);
    expect(b, 'the release sends the plan the preview showed').toBe(a);
    expect(made).toBe(1);
    const c = cache.get(s.tick, [2, 10], [7, 10], view);
    expect(c).not.toBe(a);
    expect(c.targets.length).toBe(6);
    const d = cache.get(s.tick + 1, [2, 10], [7, 10], view);
    expect(d).not.toBe(c);
    expect(made).toBe(3);
  });
});
