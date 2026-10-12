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
// Paint a row (Richard, 10 Oct): any other kind but the gate — a turret, a generator, an extractor —
// is laid as a row along the drag's main axis from its start, footprints edge to edge, at most
// ROW_MAX (buildingRowTiles). Each position passes the single-click placement rule (placeableOn,
// which main.ts's click uses too) with the queue flag it will be sent with: the first placed takes
// Shift's, the rest append (rowBuildCommands, as a belt line); blocked positions are skipped. The
// preview and the release both go through planDrag, so they cannot differ.
//
// W31: belt lines are laid at a speed (planDrag's `tier`; the cost is the laid cost, kinds.ts
// beltLaidWork) and the label names it ("5 tiles · Medium · 8 mass"); DragPlanCache keys on it, so
// switching speed while paused recomputes the preview. placeableOn takes the simulation's rule for a
// reserved site of the builders' own (queue.ts heldReservedSite): unshifted, a site at another belt
// speed may be replaced. planBeltUpgrade is the upgrade tool's drag: every belt tile on the dragged
// line, the complete belts that can go up one speed as targets ({ id, expectedTier }), the rest of
// the belt pieces on it (splitter, merger, Fast, upgrading, locked) as skipped tiles.
//
// Not under render/: it reaches runs.ts and world.ts (canPlaceOn), which render code may not import.

import { B, BELT_SPEED_NAMES, beltUpgradeSkip, buildingFootprint, buildingInfo, beltLaidWork, isBelt, siteWork, type Cost } from './sim/kinds.ts';
import type { Command } from './sim/commands.ts';
import { planRunOn, type RunPlan, type RunPlanSource } from './sim/runs.ts';
import { heldReservedSite, ownWallSites, type QueueSource, type ReplaceSource, type SiteSource } from './sim/queue.ts';
import { BF_COMPLETE, Q_BUILD, Q_RUN, isReserved } from './sim/schema.ts';
import { snapshotRules } from './snapshotRules.ts';
import { rowOf } from './render/siteReadout.ts';
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
  /** W31: the speed a belt line is laid at (1 Slow .. 3 Fast); 1 for every other kind. */
  tier: number;
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
    tierOf: (id) => {
      const r = rowOf(s, id);
      return r >= 0 ? c.tier[r]! : 0;
    },
  };
}

/** Kinds a build-mode drag lays as a row: all but walls (a run), belt kinds (a line) and the gate (its own tool). */
export const paintsRow = (kind: number): boolean => kind !== B.wall && kind !== B.gate && !isBelt(kind);

/** Most buildings one drag lays as a row. */
export const ROW_MAX = 32;

/**
 * Footprint anchors of a row of `kind` from anchor `from` towards anchor `to`: along x when the drag
 * moves at least as far in x as in z (as a belt line chooses), else along z; from `from`, stepping
 * one footprint, as many as fit up to `to` (at least one: a drag under one footprint is a single
 * building at the start), at most ROW_MAX.
 */
export function buildingRowTiles(kind: number, from: [number, number], to: [number, number]): Array<[number, number]> {
  const [fw, fh] = buildingFootprint(kind);
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const alongX = Math.abs(dx) >= Math.abs(dz);
  const d = alongX ? dx : dz;
  const step = (alongX ? fw : fh) * (d < 0 ? -1 : 1);
  const n = Math.min(ROW_MAX, Math.floor(Math.abs(d) / Math.abs(step)) + 1);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) out.push(alongX ? [from[0] + i * step, from[1]] : [from[0], from[1] + i * step]);
  return out;
}

/**
 * The single-click placement rule on a snapshot view: the tiles are free ground (or the deposit an
 * extractor needs), or (run 3 C2) it is exactly a reserved site the builders `ids` hold themselves
 * and the order is unshifted (queue.ts ownReservedSite; W31: at any belt speed, heldReservedSite, as
 * validation takes it: at the same speed the order goes to that site, at another it replaces it).
 */
export function placeableOn(v: DragView, ids: readonly number[], kind: number, tx: number, ty: number, dir: number, queue: boolean): boolean {
  if (canPlaceOn(v.terrain, v.occupancy, kind, tx, ty)) return true;
  return !queue && !!v.snapshot && ids.length > 0 && heldReservedSite(snapshotSiteSource(v.snapshot, v.occupancy), ids, kind, tx, ty, dir, false) >= 0;
}

/** The build commands a row plan sends on release, in order: the first takes `queue`, the rest append. */
export function rowBuildCommands(plan: DragPlan, ids: number[], queue: boolean): Array<Extract<Command, { t: 'build' }>> {
  return plan.build.map(([tx, ty, dir], i) => ({ t: 'build', ids, kind: plan.kind, tx, ty, dir, queue: queue || i > 0 }));
}

/**
 * W31: what an upgrade-tool drag along belts will do (planBeltUpgrade), as the preview shows it; the
 * command's own plan on the world is validate.ts BeltUpgradePlan. `kind`, `build` and `skipped` are
 * the shape render/dragPreview.ts draws.
 */
export interface BeltUpgradePreview {
  kind: number;
  /** One per belt to upgrade one speed step, in drag order (the upgradeBelts command's targets). */
  targets: Array<{ id: number; expectedTier: number }>;
  /** Their tiles, with the belt's direction (the preview's build marks). */
  build: Array<[number, number, number]>;
  /** Belt pieces on the line that will not be upgraded: splitter, merger, Fast, upgrading, locked, unfinished. */
  skipped: Array<[number, number]>;
  toMedium: number;
  toFast: number;
  cost: Cost;
}

/**
 * The belts an upgrade drag from `from` to `to` upgrades (the tiles of beltLineTiles, as a belt drag
 * lays them; `dir` for a drag that stays on one tile, where it does not matter). A complete belt not
 * upgrading, below Fast and with its next speed researched becomes a target at its current tier; any
 * other belt piece on the line is skipped. Tiles without a belt piece are not counted.
 */
export function planBeltUpgrade(v: DragView, from: [number, number], to: [number, number], dir: number): BeltUpgradePreview {
  const plan: BeltUpgradePreview = { kind: B.belt, targets: [], build: [], skipped: [], toMedium: 0, toFast: 0, cost: [0, 0, 0] };
  const s = v.snapshot;
  if (!s) return plan;
  const c = s.buildings.cols;
  const researched = snapshotRules(s).researched;
  const W = v.terrain.w;
  for (const [x, z] of beltLineTiles(from[0], from[1], to[0], to[1], dir)) {
    if (x < 0 || z < 0 || x >= W || z >= v.terrain.h) continue;
    const r = (v.occupancy[z * W + x] ?? 0) - 1;
    if (r < 0 || !isBelt(c.kind[r]!)) continue;
    const tier = c.tier[r]!;
    // kinds.ts beltUpgradeSkip: the rule the upgradeBelts command applies (validate.ts planBeltUpgrades)
    if (beltUpgradeSkip(c.kind[r]!, c.flags[r]!, tier, researched)) {
      plan.skipped.push([x, z]);
      continue;
    }
    plan.targets.push({ id: s.buildings.id[r]!, expectedTier: tier });
    plan.build.push([x, z, c.dir[r]!]);
    if (tier === 1) plan.toMedium++;
    else plan.toFast++;
    const { cost } = siteWork(B.belt, true, tier, 1, 1);
    for (let k = 0; k < 3; k++) plan.cost[k] = plan.cost[k]! + cost[k]!;
  }
  return plan;
}

/** "8 to Medium · 4 to Fast · 3 skipped · 16 mass" (a zero count is left out; "nothing to upgrade" when no target). */
export function upgradeLabel(p: BeltUpgradePreview): string {
  const parts: string[] = [];
  if (p.toMedium) parts.push(`${p.toMedium} to Medium`);
  if (p.toFast) parts.push(`${p.toFast} to Fast`);
  if (!parts.length) parts.push('nothing to upgrade');
  if (p.skipped.length) parts.push(`${p.skipped.length} skipped`);
  costParts(p.cost, parts);
  return parts.join(' · ');
}

/** Appends "1,800 mass", "2,700 energy", "5 rare" for each non-zero cost. */
function costParts(cost: Cost, parts: string[]): void {
  const names = ['mass', 'energy', 'rare'];
  cost.forEach((c, k) => {
    if (c > 0) parts.push(`${Math.round(c).toLocaleString('en-GB')} ${names[k]}`);
  });
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
 * belts: a line; paintsRow kinds: a row, `from` and `to` being footprint anchors). `queue`: Shift is
 * held, so the builders' queues are appended to, not replaced. `dir`: belts' and rows' direction.
 */
export function planDrag(v: DragView, kind: number, ids: readonly number[], from: [number, number], to: [number, number], dir = 0, queue = false, depth = 1, tier = 1): DragPlan {
  const belt = kind === B.belt;
  const unit = belt ? beltLaidWork(tier).cost : buildingInfo(kind).cost;
  const plan: DragPlan = { kind, build: [], skipped: [], cost: [0, 0, 0], tier: belt ? tier : 1, refused: null };
  if (kind === B.wall) {
    const run = planWallDrag(v, ids, from, to, depth, queue);
    if (typeof run === 'string') plan.refused = run;
    else {
      for (const [x, y] of run.tiles) plan.build.push([x, y, 0]);
      plan.skipped = run.skippedAt;
    }
  } else if (paintsRow(kind)) {
    for (const [x, y] of buildingRowTiles(kind, from, to)) {
      // checked with the queue flag rowBuildCommands sends it with
      if (placeableOn(v, ids, kind, x, y, dir, queue || plan.build.length > 0)) plan.build.push([x, y, dir]);
      else plan.skipped.push([x, y]);
    }
  } else {
    for (const [x, y, d] of beltLineTiles(from[0], from[1], to[0], to[1], dir)) {
      if (canPlaceOn(v.terrain, v.occupancy, kind, x, y)) plan.build.push([x, y, d]);
      else plan.skipped.push([x, y]);
    }
  }
  for (let k = 0; k < 3; k++) plan.cost[k] = unit[k]! * plan.build.length;
  return plan;
}

/**
 * "18 tiles · 3 skipped · 1,800 mass · 2,700 energy" (or the refusal); a row: "Energy generator × 5
 * (2 skipped) · 750 mass"; W31, a belt line names its speed: "5 tiles · Medium · 8 mass".
 */
export function dragLabel(p: DragPlan): string {
  if (p.refused) return `Nothing laid: ${p.refused}`;
  const parts = paintsRow(p.kind)
    ? [`${buildingInfo(p.kind).label} × ${p.build.length}${p.skipped.length ? ` (${p.skipped.length} skipped)` : ''}`]
    : [`${p.build.length} tile${p.build.length === 1 ? '' : 's'}`];
  if (p.kind === B.belt) parts.push(BELT_SPEED_NAMES[p.tier]!);
  if (p.skipped.length && !paintsRow(p.kind)) parts.push(`${p.skipped.length} skipped`);
  costParts(p.cost, parts);
  return parts.join(' · ');
}

/**
 * The drag plan, worked out again only when an input changes: the snapshot tick, the kind, the end
 * tiles, the belt direction, Shift, the wall depth (run 3) and the belt speed (W31). `inputs` (the
 * snapshot view and the builders) is called only then, so a frame with nothing changed returns the
 * same plan object without building either. (The builders are not compared, as before run 3: a
 * selection change during a drag shows from the next snapshot.)
 */
export class DragPlanCache {
  private plan: DragPlan | null = null;
  private readonly key = { tick: -1, kind: -1, fx: 0, fy: 0, tx: 0, ty: 0, dir: -1, queue: false, depth: -1, tier: -1 };

  get(tick: number, kind: number, from: [number, number], to: [number, number], dir: number, queue: boolean, depth: number, inputs: () => { view: DragView; ids: readonly number[] }, tier = 1): DragPlan {
    const k = this.key;
    if (!this.plan || k.tick !== tick || k.kind !== kind || k.fx !== from[0] || k.fy !== from[1] || k.tx !== to[0] || k.ty !== to[1] || k.dir !== dir || k.queue !== queue || k.depth !== depth || k.tier !== tier) {
      Object.assign(k, { tick, kind, fx: from[0], fy: from[1], tx: to[0], ty: to[1], dir, queue, depth, tier });
      const { view, ids } = inputs();
      this.plan = planDrag(view, kind, ids, from, to, dir, queue, depth, tier);
    }
    return this.plan;
  }

  clear(): void {
    this.plan = null;
  }
}
