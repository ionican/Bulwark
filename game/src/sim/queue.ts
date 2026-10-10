// W25 build queue (Supreme Commander style). Each unit has its own order queue (world.ts orders,
// MAX_ORDERS); an order goes onto the queue of every unit it was given to, and units that share an
// item build it together, each when it reaches that item in its own queue (units.ts works only on
// a unit's first order, so a unit never works on an item it has not queued, except by an explicit
// assist order).
//
// Ownership is the queues themselves: a site is held while any live unit's queue refers to it, by a
// build order on the site or a run order on the wall run it belongs to. When orders are replaced
// (an order without `queue`) or removed (dequeue, clearQueue, stop), dropOrphans removes each reserved
// site those orders referred to that no queue holds any more; it cost nothing, so there is no
// refund. A started site stays as a part-built structure, as in SupCom. A wall run whose last run
// order went loses its reserved tiles (those no unit holds by an assist order) and its run-table
// slot, as cancelRun does; its started tiles stay. A gate site is never removed this way: its walls
// were converted when the gate was ordered (gate.ts), so removing the site would destroy them.
// W25b (Richard, 9 Oct: "stop should clear them"): `stop` clears by the same rule. A unit's death
// and an unreachable site are unchanged from W24: their sites stay.
//
// W25c (review finding 1): an unshifted wall run keeps the builders' own wall sites that it covers.
// The new run used to be planned against the reservations its own replacement was about to remove,
// so it skipped them as walls, and dropOrphans then removed them: holes. Now the sites the
// replacement would release (ownWallSites: unfinished 1 × 1 wall sites that only the replaced
// queues hold) are planned as part of the new run and join it in place (runs.ts createRun), before
// dropOrphans runs, so they are held again and stay. Sites another unit holds stay that unit's.
// The same function runs on the simulation's state (worldReplaceSource) and on the render thread's
// snapshot (dragPlan.ts), so the drag preview shows what will be laid.
//
// Also here: the queue as the snapshot carries it (order kind, target, run id, position, order id),
// and `dequeue`'s lookup by order id (W25c).
//
// Run 3 C2 (Codex R1-2, R2-1): an unshifted single build on a reserved site of exactly that kind,
// anchor and direction gives the issuers that site, when at least one live issuing unit holds it
// and no live unit outside the issuers does (ownReservedSite). A site nobody holds (its owner died)
// is not "own". The same function runs on the simulation's state (validation and application) and
// on the snapshot (dragPlan.ts snapshotSiteSource: the placement preview and the build-bar click).
// Run 3 C3 (Codex R1-1, R2-2): orphansOf is dropOrphans' rule without the removal, so an unshifted
// wall run with a full run table can be planned first (replacementProblem): the runs and sites the
// replacement releases, by the same rule (a gate site is never released), less the sites the new
// run keeps in place. Capacity is credited only for what will actually be removed.

import { B, buildingFootprint } from './kinds.ts';
import { RUN_CAPACITY, newSites, runById, type RunCommand, type RunPlan } from './runs.ts';
import { BF_COMPLETE, Q_BUILD, Q_MOVE, Q_PRODUCE, Q_RECLAIM, Q_RUN, isReserved } from './schema.ts';
import type { Order } from './units.ts';
import type { World } from './world.ts';

/** Snapshot order kind (schema.ts Q_*) of an order. */
export function orderKind(o: Order): number {
  switch (o.t) {
    case 'move':
      return Q_MOVE;
    case 'build':
      return Q_BUILD;
    case 'run':
      return Q_RUN;
    case 'produce':
      return Q_PRODUCE;
    case 'reclaim':
      return Q_RECLAIM;
  }
}

/**
 * Index in unit slot `slot`'s queue of the order with id `oid` (W25c), or -1 when the unit does not
 * hold it (completed, removed, or never given to this unit). Order ids are unique within a world, so
 * a dequeue sent from an older snapshot removes the order it named or nothing: two moves, or two
 * produce orders, can no longer stand in for each other (the review's finding 3).
 */
export function dequeueIndex(w: World, slot: number, oid: number): number {
  const orders = w.orders[slot] ?? [];
  return orders.findIndex((o) => o.oid === oid);
}

/** True if building `id` is a site dropOrphans may remove: reserved, and never a gate (see the header). */
export function removableSite(w: World, id: number): boolean {
  const s = w.buildings.slotForId(id);
  return s >= 0 && isReserved(w.buildings.cols.flags[s]!) && w.buildings.cols.kind[s] !== B.gate;
}

/** The runs freed and the sites removed (in removal order) by dropOrphans; see orphansOf. */
export interface Orphans {
  runs: number[];
  sites: number[];
}

const NO_SLOTS: ReadonlySet<number> = new Set();

/**
 * What dropOrphans removes after `removed` left the queues, worked out without changing anything:
 * the reserved sites they referred to that no live unit's queue holds, and the runs left with no
 * run order (with their reserved tiles nobody holds). Run 3 C3: `skip` are unit slots whose queues
 * count as already replaced (planning before the replacement), `keep` sites that count as held
 * (the new run's reused sites).
 */
export function orphansOf(w: World, removed: readonly Order[], skip: ReadonlySet<number> = NO_SLOTS, keep: readonly number[] = []): Orphans {
  const out: Orphans = { runs: [], sites: [] };
  const sites = new Set<number>();
  const runs = new Set<number>();
  for (const o of removed) {
    if (o.t === 'build') sites.add(o.id);
    else if (o.t === 'run') runs.add(o.run);
  }
  if (!sites.size && !runs.size) return out;
  const heldSites = new Set<number>(keep);
  const heldRuns = new Set<number>();
  for (let s = 0; s < w.units.highWater; s++) {
    if (!w.units.alive[s] || skip.has(s)) continue;
    for (const o of w.orders[s] ?? []) {
      if (o.t === 'build') heldSites.add(o.id);
      else if (o.t === 'run') heldRuns.add(o.run);
    }
  }
  // Tiles of runs still being worked on are held by those run orders.
  for (const r of w.runs) if (r && heldRuns.has(r.id)) for (const site of r.sites) heldSites.add(site);
  // Sets iterate in insertion order (queue order), so removal order is deterministic.
  const gone = new Set<number>();
  const drop = (id: number) => {
    if (heldSites.has(id) || gone.has(id) || !removableSite(w, id)) return;
    gone.add(id);
    out.sites.push(id);
  };
  for (const id of runs) {
    if (heldRuns.has(id)) continue;
    const run = runById(w, id);
    if (!run) continue;
    out.runs.push(id);
    for (const site of run.sites) drop(site);
  }
  for (const id of sites) drop(id);
  return out;
}

/**
 * After `removed` left the queues (replaced or dequeued): removes the reserved sites they referred
 * to that no live unit's queue holds any more, and frees runs left with no run order. `keep`: sites
 * held regardless (run 3 C3: the new run's reused sites, before it is laid).
 */
export function dropOrphans(w: World, removed: readonly Order[], keep: readonly number[] = []): void {
  const o = orphansOf(w, removed, NO_SLOTS, keep);
  for (const id of o.runs) {
    const i = w.runs.findIndex((r) => r !== null && r.id === id);
    if (i >= 0) w.runs[i] = null;
  }
  for (const id of o.sites) w.removeBuilding(w.buildings.slotForId(id));
}

/**
 * Run 3 C3: null if an unshifted wall run with plan `plan` fits the run table and the building
 * table once the builders' replaced orders have released what they hold (orphansOf, with the new
 * run's reused sites kept); otherwise why not. Pure.
 */
export function replacementProblem(w: World, cmd: RunCommand, plan: RunPlan): string | null {
  const slots = new Set<number>();
  const removed: Order[] = [];
  for (const id of cmd.ids) {
    const s = w.units.slotForId(id);
    if (s < 0 || slots.has(s)) continue;
    slots.add(s);
    removed.push(...(w.orders[s] ?? []));
  }
  const freed = orphansOf(w, removed, slots, plan.reuse.filter((id) => id >= 0));
  if (w.runs.filter((r) => r === null).length + freed.runs.length < 1) return `the run table is full (${RUN_CAPACITY} runs): finish or cancel one first`;
  const n = newSites(plan);
  if (w.buildings.count - freed.sites.length + n > w.buildings.capacity) return `not enough room in the building table for ${n} wall sites`;
  return null;
}

/** What the C2 and W25c rules read of the units' queues: the orders that hold sites, and the runs' sites. */
export interface QueueSource {
  /** Unit rows (or slots) to look at; `holds` skips any that are not live. */
  units: number;
  /** Calls `hold` for each build order (its site, run -1) and run order (site -1, its run) of unit `u`. */
  holds(u: number, hold: (site: number, run: number) => void): void;
  /** Sites of run `run` (at least its unfinished ones; none when the run is gone). */
  runSites(run: number): ArrayLike<number>;
}

/** QueueSource over the simulation's state. */
export function worldQueueSource(w: World): QueueSource {
  return {
    units: w.units.highWater,
    holds: (u, hold) => {
      if (!w.units.alive[u]) return;
      for (const o of w.orders[u] ?? []) {
        if (o.t === 'build') hold(o.id, -1);
        else if (o.t === 'run') hold(-1, o.run);
      }
    },
    runSites: (run) => runById(w, run)?.sites ?? [],
  };
}

/** What the own-reserved-site rule reads (run 3 C2): the queues, the runs' sites and the reserved sites. */
export interface SiteSource extends QueueSource {
  /** Id of unit `u`, or -1 when it is not live. */
  liveId(u: number): number;
  /** Id of the reserved site of exactly `kind` (its own footprint) anchored at (tx, ty) facing `dir`, or -1. */
  reservedSiteAt(kind: number, tx: number, ty: number, dir: number): number;
}

/**
 * Run 3 C2: the reserved site an unshifted build of `kind` at (tx, ty) facing `dir` by units `ids`
 * takes over, or -1. Only without `queue`; the site must be held (a build order on it, or a run
 * order on a run it belongs to) by at least one live unit in `ids` and by no live unit outside them.
 */
export function ownReservedSite(src: SiteSource, ids: readonly number[], kind: number, tx: number, ty: number, dir: number, queue: boolean): number {
  if (queue) return -1;
  const site = src.reservedSiteAt(kind, tx, ty, dir);
  if (site < 0) return -1;
  let mine = false;
  for (let u = 0; u < src.units; u++) {
    const id = src.liveId(u);
    if (id < 0) continue;
    let held = false;
    src.holds(u, (s, run) => {
      if (held) return;
      if (s === site) held = true;
      else if (run >= 0) held = Array.prototype.includes.call(src.runSites(run), site);
    });
    if (!held) continue;
    if (!ids.includes(id)) return -1;
    mine = true;
  }
  return mine ? site : -1;
}

/** SiteSource over the simulation's state. */
export function worldSiteSource(w: World): SiteSource {
  const c = w.buildings.cols;
  return {
    ...worldQueueSource(w),
    liveId: (u) => (w.units.alive[u] ? w.units.id(u) : -1),
    reservedSiteAt: (kind, tx, ty, dir) => {
      if (tx < 0 || ty < 0 || tx >= w.terrain.w || ty >= w.terrain.h) return -1;
      const s = w.occupancy[ty * w.terrain.w + tx]! - 1;
      if (s < 0 || c.kind[s] !== kind || c.tx[s] !== tx || c.ty[s] !== ty || c.dir[s] !== (dir & 3) || !isReserved(c.flags[s]!)) return -1;
      const [fw, fh] = buildingFootprint(kind);
      return c.fw[s] === fw && c.fh[s] === fh ? w.buildings.id(s) : -1;
    },
  };
}

/** What the replacement rule reads (W25c): the units' queues, the runs' sites, and the wall sites. */
export interface ReplaceSource extends QueueSource {
  /** True if unit `u`'s queue is being replaced (an unshifted order to it). */
  replaced(u: number): boolean;
  /** Tile index (ty × map width + tx) of site `id` if it is an unfinished 1 × 1 wall site, else -1. */
  wallSiteTile(id: number): number;
}

/**
 * The wall sites that replacing the queues marked `replaced` would release and that a new run may
 * keep in place, by tile index. A site is released when a replaced queue holds it (a build order on
 * it, or a run order on a run it belongs to) and no other unit's queue does (the dropOrphans rule).
 */
export function ownWallSites(src: ReplaceSource): Map<number, number> {
  const mine = new Set<number>();
  const myRuns = new Set<number>();
  const held = new Set<number>();
  const heldRuns = new Set<number>();
  for (let u = 0; u < src.units; u++) {
    const r = src.replaced(u);
    src.holds(u, (site, run) => {
      if (site >= 0) (r ? mine : held).add(site);
      if (run >= 0) (r ? myRuns : heldRuns).add(run);
    });
  }
  for (const run of heldRuns) for (const site of Array.from(src.runSites(run))) held.add(site);
  for (const run of myRuns) if (!heldRuns.has(run)) for (const site of Array.from(src.runSites(run))) mine.add(site);
  const out = new Map<number, number>();
  for (const site of mine) {
    if (held.has(site)) continue;
    const tile = src.wallSiteTile(site);
    if (tile >= 0) out.set(tile, site);
  }
  return out;
}

/** ReplaceSource over the simulation's state; `slots` are the unit slots whose queues are replaced. */
export function worldReplaceSource(w: World, slots: ReadonlySet<number>): ReplaceSource {
  const c = w.buildings.cols;
  return {
    ...worldQueueSource(w),
    replaced: (u) => slots.has(u),
    wallSiteTile: (id) => {
      const s = w.buildings.slotForId(id);
      if (s < 0 || c.kind[s] !== B.wall || c.fw[s] !== 1 || c.fh[s] !== 1 || c.flags[s]! & BF_COMPLETE) return -1;
      return c.ty[s]! * w.terrain.w + c.tx[s]!;
    },
  };
}

/** Footprint centre of building `id`, or null when it no longer exists. */
function centre(w: World, id: number): [number, number] | null {
  const s = w.buildings.slotForId(id);
  if (s < 0) return null;
  const c = w.buildings.cols;
  return [c.tx[s]! + c.fw[s]! / 2, c.ty[s]! + c.fh[s]! / 2];
}

/**
 * Where an order points, for the snapshot: a move's point; a building's footprint centre; a run's
 * claimed tile, or its first unfinished tile in build order; a wreck (or where the last one was);
 * the unit itself for produce. (-1, -1) when the target is gone.
 */
export function orderPosition(w: World, unitSlot: number, o: Order): [number, number] {
  switch (o.t) {
    case 'move':
      return [o.x, o.z];
    case 'build':
      return centre(w, o.id) ?? [-1, -1];
    case 'run': {
      const claimed = o.site >= 0 ? centre(w, o.site) : null;
      if (claimed) return claimed;
      const run = w.runs.find((r) => r !== null && r.id === o.run);
      for (const id of run?.sites ?? []) {
        const s = w.buildings.slotForId(id);
        if (s >= 0 && !(w.buildings.cols.flags[s]! & BF_COMPLETE)) return centre(w, id)!;
      }
      return [-1, -1];
    }
    case 'produce':
      return [w.units.cols.x[unitSlot]!, w.units.cols.z[unitSlot]!];
    case 'reclaim': {
      const s = w.wrecks.slotForId(o.id);
      return s >= 0 ? [w.wrecks.cols.x[s]!, w.wrecks.cols.z[s]!] : [o.x, o.z];
    }
  }
}

/** The snapshot's target id of an order: building or wreck id, a run's claimed tile, -1 otherwise. */
export function orderTarget(o: Order): number {
  return o.t === 'build' || o.t === 'reclaim' ? o.id : o.t === 'run' ? o.site : -1;
}
