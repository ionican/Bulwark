// W25 item 7: what a build-mode left-drag will lay, worked out on the render thread from the latest
// snapshot, read-only. Walls use the simulation's own run planner (runs.ts planRunOn, the function
// behind buildRun's planRun): the same axis choice, `to` projected onto the axis, the same depth
// rows, skip rules and 128-tile cap, so the preview and the sites laid on release cannot differ.
// Belt lines use beltLineTiles, which main.ts also uses to send the belt build commands.
// W25c: a drag without Shift replaces the builders' queues, and the run then keeps their own wall
// sites that it covers (queue.ts ownWallSites, the simulation's rule); the preview applies the same
// function to the snapshot's queues and run-site list, so it shows those tiles as laid too.
//
// Run 3: the wall-run depth chosen in the sandbox panel reaches the preview (planDrag's `depth`), and
// DragPlanCache works the plan out again when any input changes, the depth included, so changing it
// while paused (the same snapshot tick) redraws the preview (Codex R1-11). snapshotSiteSource is the
// snapshot side of queue.ts ownReservedSite (C2: the placement preview and the build-bar click).
//
// Not under render/: it reaches runs.ts and world.ts (canPlaceOn), which render code may not import.

import { B, buildingFootprint, buildingInfo, type Cost } from './sim/kinds.ts';
import { planRunOn, type RunPlan, type RunPlanSource } from './sim/runs.ts';
import { ownWallSites, type QueueSource, type ReplaceSource, type SiteSource } from './sim/queue.ts';
import { BF_COMPLETE, Q_BUILD, Q_RUN, isReserved } from './sim/schema.ts';
import { runSitesOf, type Snapshot } from './sim/snapshot.ts';
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
  /**
   * W25c: the snapshot the view was made from (its queues, run sites and building columns), for the
   * replacement rule of a drag without Shift. Absent: no own sites are kept (as a queued drag).
   */
  snapshot?: Snapshot;
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

/** queue.ts QueueSource over a snapshot: its queues (build and run orders) and run-site list. */
export function snapshotQueueSource(s: Snapshot): QueueSource {
  const q = s.queues;
  return {
    units: s.units.count,
    holds: (r, hold) => {
      for (let i = q.first[r]!, end = i + q.count[r]!; i < end; i++) {
        if (q.kind[i] === Q_BUILD) hold(q.target[i]!, -1);
        else if (q.kind[i] === Q_RUN) hold(-1, q.run[i]!);
      }
    },
    runSites: (run) => runSitesOf(s, run),
  };
}

/** queue.ts ReplaceSource over a snapshot: the queues of builders `ids` are the ones replaced. */
export function snapshotReplaceSource(s: Snapshot, ids: readonly number[]): ReplaceSource {
  const b = s.buildings;
  let rowOf: Map<number, number> | null = null;
  return {
    ...snapshotQueueSource(s),
    replaced: (r) => ids.includes(s.units.id[r]!),
    wallSiteTile: (id) => {
      if (!rowOf) {
        rowOf = new Map();
        for (let r = 0; r < b.count; r++) rowOf.set(b.id[r]!, r);
      }
      const r = rowOf.get(id);
      const c = b.cols;
      if (r === undefined || c.kind[r] !== B.wall || c.fw[r] !== 1 || c.fh[r] !== 1 || c.flags[r]! & BF_COMPLETE) return -1;
      return c.ty[r]! * s.mapW + c.tx[r]!;
    },
  };
}

/**
 * queue.ts SiteSource over a snapshot (run 3 C2): every unit row is live. `occupancy` is the snapshot's
 * DragView.occupancy (building row + 1 per tile): the site anchored at (tx, ty) covers that tile, so
 * one lookup finds it. A tile booked by a click just sent (-1) hides the row under it, so that case
 * scans the building rows instead.
 */
export function snapshotSiteSource(s: Snapshot, occupancy: Int32Array): SiteSource {
  const c = s.buildings.cols;
  return {
    ...snapshotQueueSource(s),
    liveId: (r) => s.units.id[r]!,
    reservedSiteAt: (kind, tx, ty, dir) => {
      const [fw, fh] = buildingFootprint(kind);
      const at = (r: number) => c.kind[r] === kind && c.tx[r] === tx && c.ty[r] === ty && c.dir[r] === (dir & 3) && c.fw[r] === fw && c.fh[r] === fh && isReserved(c.flags[r]!);
      const o = occupancy[ty * s.mapW + tx];
      if (o === -1) {
        for (let r = 0; r < s.buildings.count; r++) if (at(r)) return s.buildings.id[r]!;
        return -1;
      }
      const r = (o ?? 0) - 1;
      return r >= 0 && at(r) ? s.buildings.id[r]! : -1;
    },
  };
}

/**
 * The wall run a drag from `from` to `to` lays for builders `ids` (runs.ts planRunOn). Without
 * `queue` (Shift), the builders' own wall sites the run covers are kept (W25c, header).
 */
export function planWallDrag(v: DragView, ids: readonly number[], from: [number, number], to: [number, number], depth = 1, queue = false): RunPlan | string {
  let n = 0;
  let cx = 0;
  let cz = 0;
  for (let r = 0; r < v.units.count; r++) {
    if (!ids.includes(v.units.id[r]!)) continue;
    cx += v.units.x[r]!;
    cz += v.units.z[r]!;
    n++;
  }
  const src = runSource(v);
  if (!queue && v.snapshot && n > 0) {
    const own = ownWallSites(snapshotReplaceSource(v.snapshot, ids));
    const W = v.terrain.w;
    if (own.size) src.keep = (x, y) => own.get(y * W + x) ?? -1;
  }
  return planRunOn(src, { from, to, depth }, n > 0 ? [cx / n, cz / n] : null);
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

/**
 * The whole drag plan for build kind `kind` (walls: a run `depth` rows deep, as the wall tool lays;
 * belts: a line). `queue`: Shift is held, so the builders' queues are appended to, not replaced.
 */
export function planDrag(v: DragView, kind: number, ids: readonly number[], from: [number, number], to: [number, number], beltDir = 0, queue = false, depth = 1): DragPlan {
  const info = buildingInfo(kind);
  const plan: DragPlan = { kind, build: [], skipped: [], cost: [0, 0, 0], refused: null };
  if (kind === B.wall) {
    const run = planWallDrag(v, ids, from, to, depth, queue);
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

/**
 * The drag plan, worked out again only when an input changes: the snapshot tick, the kind, the end
 * tiles, the belt direction, Shift and the wall depth (run 3). `inputs` (the snapshot view and the
 * builders) is called only then, so a frame with nothing changed returns the same plan object without
 * building either. (The builders are not compared, as before run 3: a selection change during a drag
 * shows from the next snapshot.)
 */
export class DragPlanCache {
  private plan: DragPlan | null = null;
  private readonly key = { tick: -1, kind: -1, fx: 0, fy: 0, tx: 0, ty: 0, dir: -1, queue: false, depth: -1 };

  get(tick: number, kind: number, from: [number, number], to: [number, number], dir: number, queue: boolean, depth: number, inputs: () => { view: DragView; ids: readonly number[] }): DragPlan {
    const k = this.key;
    if (!this.plan || k.tick !== tick || k.kind !== kind || k.fx !== from[0] || k.fy !== from[1] || k.tx !== to[0] || k.ty !== to[1] || k.dir !== dir || k.queue !== queue || k.depth !== depth) {
      Object.assign(k, { tick, kind, fx: from[0], fy: from[1], tx: to[0], ty: to[1], dir, queue, depth });
      const { view, ids } = inputs();
      this.plan = planDrag(view, kind, ids, from, to, dir, queue, depth);
    }
    return this.plan;
  }

  clear(): void {
    this.plan = null;
  }
}
