// W25 item 7: what a build-mode left-drag will lay, worked out on the render thread from the latest
// snapshot, read-only. Walls use the simulation's own run planner (runs.ts planRunOn, the function
// behind buildRun's planRun): the same axis choice, `to` projected onto the axis, the same depth
// rows, skip rules and 128-tile cap, so the preview and the sites laid on release cannot differ.
// Belt lines use beltLineTiles, which main.ts also uses to send the belt build commands.
//
// Not under render/: it reaches runs.ts and world.ts (canPlaceOn), which render code may not import.

import { B, buildingInfo, type Cost } from './sim/kinds.ts';
import { planRunOn, type RunPlan, type RunPlanSource } from './sim/runs.ts';
import type { Terrain } from './sim/terrain.ts';
import { canPlaceOn } from './sim/world.ts';

/** The render thread's view of the snapshot that planning reads. */
export interface DragView {
  terrain: Terrain;
  /** Building row + 1 per tile (render/picking.ts buildOccupancy); -1 = booked by a click just sent. */
  occupancy: Int32Array;
  /** Building kind per snapshot row. */
  kinds: ArrayLike<number>;
  /** Units: id and position per row (the builders' centroid picks the run's start end). */
  units: { count: number; id: ArrayLike<number>; x: ArrayLike<number>; z: ArrayLike<number> };
}

export interface DragPlan {
  kind: number;
  /** Tiles that will get a site (footprint anchor), in build order; belts carry their direction. */
  build: Array<[number, number, number]>;
  /** Tiles left out: rock, an existing wall, otherwise blocked. */
  skipped: Array<[number, number]>;
  /** Total construction cost of the built tiles: mass, energy, rare. */
  cost: Cost;
  /** Why nothing will be laid (a run over 128 tiles, an end off the map), or null. */
  refused: string | null;
}

/** runs.ts RunPlanSource over a snapshot view. */
export function runSource(v: DragView): RunPlanSource {
  const W = v.terrain.w;
  return {
    terrain: v.terrain,
    wallAt: (x, y) => {
      const row = v.occupancy[y * W + x]! - 1;
      return row >= 0 && buildingInfo(v.kinds[row]!).role === 'wall';
    },
    canPlaceWall: (x, y) => canPlaceOn(v.terrain, v.occupancy, B.wall, x, y),
  };
}

/** The wall run a drag from `from` to `to` lays for builders `ids` (runs.ts planRunOn). */
export function planWallDrag(v: DragView, ids: readonly number[], from: [number, number], to: [number, number], depth = 1): RunPlan | string {
  let n = 0;
  let cx = 0;
  let cz = 0;
  for (let r = 0; r < v.units.count; r++) {
    if (!ids.includes(v.units.id[r]!)) continue;
    cx += v.units.x[r]!;
    cz += v.units.z[r]!;
    n++;
  }
  return planRunOn(runSource(v), { from, to, depth }, n > 0 ? [cx / n, cz / n] : null);
}

/**
 * Belt tiles of a drag from (x0, z0) to (x1, z1): a straight line along the drag's main axis,
 * every piece facing along it; a drag that does not leave its tile is one piece facing `dirIfSingle`.
 */
export function beltLineTiles(x0: number, z0: number, x1: number, z1: number, dirIfSingle: number): Array<[number, number, number]> {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const out: Array<[number, number, number]> = [];
  if (dx === 0 && dz === 0) out.push([x0, z0, dirIfSingle]);
  else if (Math.abs(dx) >= Math.abs(dz)) {
    const dir = dx > 0 ? 0 : 2;
    for (let x = x0; x !== x1 + Math.sign(dx); x += Math.sign(dx)) out.push([x, z0, dir]);
  } else {
    const dir = dz > 0 ? 1 : 3;
    for (let z = z0; z !== z1 + Math.sign(dz); z += Math.sign(dz)) out.push([x0, z, dir]);
  }
  return out;
}

/** The whole drag plan for build kind `kind` (walls: a run 1 deep, as the wall tool lays; belts: a line). */
export function planDrag(v: DragView, kind: number, ids: readonly number[], from: [number, number], to: [number, number], beltDir = 0): DragPlan {
  const info = buildingInfo(kind);
  const plan: DragPlan = { kind, build: [], skipped: [], cost: [0, 0, 0], refused: null };
  if (kind === B.wall) {
    const run = planWallDrag(v, ids, from, to, 1);
    if (typeof run === 'string') plan.refused = run;
    else {
      for (const [x, y] of run.tiles) plan.build.push([x, y, 0]);
      plan.skipped = run.skippedAt;
    }
  } else {
    for (const [x, y, dir] of beltLineTiles(from[0], from[1], to[0], to[1], beltDir)) {
      if (canPlaceOn(v.terrain, v.occupancy, kind, x, y)) plan.build.push([x, y, dir]);
      else plan.skipped.push([x, y]);
    }
  }
  for (let k = 0; k < 3; k++) plan.cost[k] = info.cost[k]! * plan.build.length;
  return plan;
}

/** "18 tiles · 3 skipped · 1,800 mass · 2,700 energy" (or the refusal). */
export function dragLabel(p: DragPlan): string {
  if (p.refused) return `Nothing laid: ${p.refused}`;
  const names = ['mass', 'energy', 'rare'];
  const parts = [`${p.build.length} tile${p.build.length === 1 ? '' : 's'}`];
  if (p.skipped.length) parts.push(`${p.skipped.length} skipped`);
  p.cost.forEach((c, k) => {
    if (c > 0) parts.push(`${Math.round(c).toLocaleString('en-GB')} ${names[k]}`);
  });
  return parts.join(' · ');
}
