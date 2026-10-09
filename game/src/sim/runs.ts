// W24 wall runs. `buildRun` lays a straight run of wall sites, 1 to 4 rows deep, and gives each
// selected builder ONE order, "work on run R": the builder takes the next unclaimed tile in the
// run's build order, builds it, and moves on. So 1 to 512 tiles cost one order slot per builder,
// and a drag is never limited by the 64-order queue (world.ts MAX_ORDERS).
//
// Geometry (frozen, PLAN W24):
//   - the run goes along the dominant axis of from → to (ties: the x axis), `to` projected onto it;
//     at most MAX_RUN_LENGTH (128) tiles along the run
//   - depth rows are added on the side of the axis that `to` lies on (`to` on the axis: positive)
//   - build order: columns along the run starting from the end nearest the builders' centroid
//     (tie: the `from` end); within a column the axis row (through `from`) first, then outward
//   - tiles that are rock, already wall or otherwise blocked are skipped and counted
// The run is a record in a fixed-capacity table (RUN_CAPACITY = 32). A full table refuses the
// command before anything is created. Every run tile is an ordinary wall site, created reserved:
// it costs nothing and blocks nobody until build power first reaches it (schema.ts BF_STARTED);
// resources drain while each tile is built. Runs are always tier 1 (upgrades are the paid path).
// `cancelRun` removes the remaining reserved tiles. W25b: so does `stop` on the run's last builders
// (queue.ts dropOrphans, as when their run orders are replaced).
// W25c: an unshifted run plans the builders' own wall sites that the replacement would release
// (queue.ts ownWallSites) as its tiles, and keeps those sites in place (`reuse`) instead of skipping
// them as walls, so replacing an overlapping run leaves exactly the tiles asked for.

import { B, buildingInfo } from './kinds.ts';
import { BF_COMPLETE, constructionState, isReserved } from './schema.ts';
import { TILE_ROCK, tileAt, type Terrain } from './terrain.ts';
import type { World } from './world.ts';
import { ownWallSites, worldReplaceSource } from './queue.ts';

export const RUN_CAPACITY = 32;
export const MAX_RUN_LENGTH = 128;
export const MAX_RUN_DEPTH = 4;

export interface WallRun {
  id: number;
  /** Wall site ids in build order. */
  sites: number[];
  /** Tiles skipped when the run was laid. */
  skipped: number;
}

export interface RunPlan {
  /** Tiles to lay, in build order. */
  tiles: Array<[number, number]>;
  skipped: { rock: number; wall: number; blocked: number; total: number };
  /** W25: the skipped tiles themselves, in the same order (the drag preview draws them). */
  skippedAt: Array<[number, number]>;
  /** W25c: per tile, the id of the builders' own wall site kept there in place, or -1 (a new site). */
  reuse: number[];
  axis: 'x' | 'z';
  /** Which end the build starts from. */
  start: 'from' | 'to';
}

export interface RunCommand {
  ids: number[];
  from: [number, number];
  to: [number, number];
  depth: number;
  /** Appends to the builders' queues; without it their queues are replaced (W25c: see the header). */
  queue?: boolean;
}

/**
 * What planning a run reads (W25): the simulation passes its world (planRun), the render thread's
 * drag preview its latest snapshot (dragPlan.ts), so both lay out exactly the same tiles.
 */
export interface RunPlanSource {
  terrain: Terrain;
  /** A wall or gate stands on the tile (any construction state). */
  wallAt(x: number, y: number): boolean;
  /** A tier-1 wall may be placed on the tile (world.ts canPlaceOn). */
  canPlaceWall(x: number, y: number): boolean;
  /**
   * W25c: the builders' own wall site on the tile that an unshifted run keeps in place (queue.ts
   * ownWallSites), or -1. Absent: none (a queued run, or a source that does not know the queues).
   */
  keep?(x: number, y: number): number;
}

/** Geometry and build order of a run, or the reason it is refused. Pure: creates nothing. */
export function planRun(w: World, cmd: RunCommand): RunPlan | string {
  // Which end is nearer the builders' centroid (no builders: none, and the from end is used).
  let n = 0;
  let cx = 0;
  let cz = 0;
  for (const id of cmd.ids) {
    const s = w.units.slotForId(id);
    if (s < 0) continue;
    cx += w.units.cols.x[s]!;
    cz += w.units.cols.z[s]!;
    n++;
  }
  const W = w.terrain.w;
  const slots = new Set<number>();
  if (!cmd.queue) for (const id of cmd.ids) if (w.units.slotForId(id) >= 0) slots.add(w.units.slotForId(id));
  const own = slots.size ? ownWallSites(worldReplaceSource(w, slots)) : null;
  const src: RunPlanSource = {
    terrain: w.terrain,
    wallAt: (x, y) => {
      const occ = w.occupancy[y * W + x]! - 1;
      return occ >= 0 && buildingInfo(w.buildings.cols.kind[occ]!).role === 'wall';
    },
    canPlaceWall: (x, y) => w.canPlace(B.wall, x, y),
    keep: own?.size ? (x, y) => own.get(y * W + x) ?? -1 : undefined,
  };
  return planRunOn(src, cmd, n > 0 ? [cx / n, cz / n] : null);
}

/** planRun over any source; `centroid` is the builders' mean position (null: no builders). */
export function planRunOn(src: RunPlanSource, cmd: { from: [number, number]; to: [number, number]; depth: number }, centroid: [number, number] | null): RunPlan | string {
  const [fx, fy] = cmd.from;
  const [tx, ty] = cmd.to;
  const W = src.terrain.w;
  const H = src.terrain.h;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
  if (!inside(fx, fy) || !inside(tx, ty)) return `run ends must be on the map (0..${W - 1}, 0..${H - 1})`;
  const dx = tx - fx;
  const dy = ty - fy;
  const axis: 'x' | 'z' = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'z';
  const along = axis === 'x' ? dx : dy;
  const across = axis === 'x' ? dy : dx;
  const length = Math.abs(along) + 1;
  if (length > MAX_RUN_LENGTH) return `a run is at most ${MAX_RUN_LENGTH} tiles long (this one is ${length})`;
  const step = Math.sign(along) || 1;
  const side = across < 0 ? -1 : 1;
  // Which end is nearer the builders' centroid (tie, or no builders: the from end).
  let start: 'from' | 'to' = 'from';
  if (centroid) {
    const [cx, cz] = centroid;
    const endX = axis === 'x' ? fx + along : fx;
    const endY = axis === 'x' ? fy : fy + along;
    const d2 = (x: number, y: number) => (x + 0.5 - cx) ** 2 + (y + 0.5 - cz) ** 2;
    if (d2(endX, endY) < d2(fx, fy)) start = 'to';
  }
  const tiles: Array<[number, number]> = [];
  const reuse: number[] = [];
  const skippedAt: Array<[number, number]> = [];
  const skipped = { rock: 0, wall: 0, blocked: 0, total: 0 };
  for (let i = 0; i < length; i++) {
    const u = start === 'from' ? i : length - 1 - i;
    for (let v = 0; v < cmd.depth; v++) {
      const x = axis === 'x' ? fx + step * u : fx + side * v;
      const y = axis === 'x' ? fy + side * v : fy + step * u;
      const keep = inside(x, y) && src.keep ? src.keep(x, y) : -1;
      if (keep >= 0) {
        tiles.push([x, y]);
        reuse.push(keep);
        continue;
      }
      if (!inside(x, y)) skipped.blocked++;
      else if (tileAt(src.terrain, x, y) === TILE_ROCK) skipped.rock++;
      else if (src.wallAt(x, y)) skipped.wall++; // wall or gate
      else if (!src.canPlaceWall(x, y)) skipped.blocked++;
      else {
        tiles.push([x, y]);
        reuse.push(-1);
        continue;
      }
      skipped.total++;
      skippedAt.push([x, y]);
    }
  }
  return { tiles, skipped, skippedAt, reuse, axis, start };
}

/** Null if a run with `tiles` new sites fits the run table and the building table. */
export function runCapacityProblem(w: World, tiles: number): string | null {
  if (!w.runs.some((r) => r === null)) return `the run table is full (${RUN_CAPACITY} runs): finish or cancel one first`;
  if (w.buildings.count + tiles > w.buildings.capacity) return `not enough room in the building table for ${tiles} wall sites`;
  return null;
}

/** New sites a plan lays (its tiles less the sites it keeps in place, W25c). */
export const newSites = (plan: RunPlan): number => plan.reuse.reduce((n, id) => (id >= 0 ? n : n + 1), 0);

/**
 * Lays the run's reserved wall sites and records it; a tile with a kept site (`reuse`, W25c) takes
 * that site into the run in place. Returns the run id, or -1 (nothing created).
 */
export function createRun(w: World, plan: RunPlan): number {
  if (runCapacityProblem(w, newSites(plan))) return -1;
  const sites: number[] = [];
  plan.tiles.forEach(([x, y], i) => {
    const kept = plan.reuse[i]!;
    const id = kept >= 0 && w.buildings.slotForId(kept) >= 0 ? kept : w.placeBuilding(B.wall, x, y, false);
    if (id >= 0) sites.push(id);
  });
  const slot = w.runs.indexOf(null);
  const id = w.nextRunId++;
  w.runs[slot] = { id, sites, skipped: plan.skipped.total };
  return id;
}

export function runById(w: World, id: number): WallRun | null {
  for (const r of w.runs) if (r && r.id === id) return r;
  return null;
}

/** Removes the run's reserved (never started) sites and the run itself. Started tiles stay as sites. */
export function cancelRun(w: World, id: number): void {
  const i = w.runs.findIndex((r) => r !== null && r.id === id);
  if (i < 0) return;
  const run = w.runs[i]!;
  for (const site of run.sites) {
    const s = w.buildings.slotForId(site);
    if (s >= 0 && isReserved(w.buildings.cols.flags[s]!)) w.removeBuilding(s);
  }
  w.runs[i] = null;
}

/** True if site `id` is still to be built (exists and is not complete). */
function open(w: World, id: number): boolean {
  const s = w.buildings.slotForId(id);
  return s >= 0 && !(w.buildings.cols.flags[s]! & BF_COMPLETE);
}

/**
 * The next tile builder slot `self` should take on run `run`: the first site in build order that
 * is unfinished and not held by another unit's active run order. -1 when none is left.
 */
export function claimNext(w: World, run: WallRun, self: number): number {
  for (const site of run.sites) {
    if (!open(w, site)) continue;
    let taken = false;
    for (let u = 0; u < w.units.highWater && !taken; u++) {
      if (u === self || !w.units.alive[u]) continue;
      const o = w.orders[u]?.[0];
      if (o && o.t === 'run' && o.run === run.id && o.site === site) taken = true;
    }
    if (!taken) return site;
  }
  return -1;
}

/** Frees every run with no unfinished tile left (after construction, each tick). */
export function stepRuns(w: World): void {
  for (let i = 0; i < w.runs.length; i++) {
    const r = w.runs[i];
    if (!r) continue;
    let anyOpen = false;
    for (let k = 0; k < r.sites.length && !anyOpen; k++) anyOpen = open(w, r.sites[k]!);
    if (!anyOpen) w.runs[i] = null;
  }
}

/** Complete tiles of a run, counted now (the snapshot's run table). */
export function runCompleteCount(w: World, run: WallRun): number {
  let n = 0;
  for (const id of run.sites) {
    const s = w.buildings.slotForId(id);
    if (s >= 0 && w.buildings.cols.flags[s]! & BF_COMPLETE) n++;
  }
  return n;
}

/** Reserved, started and complete tile counts of a run (debug hook, tests). */
export function runProgress(w: World, run: WallRun): { reserved: number; started: number; complete: number; gone: number } {
  const out = { reserved: 0, started: 0, complete: 0, gone: 0 };
  for (const id of run.sites) {
    const s = w.buildings.slotForId(id);
    if (s < 0) out.gone++;
    else out[constructionState(w.buildings.cols.flags[s]!)]++;
  }
  return out;
}
