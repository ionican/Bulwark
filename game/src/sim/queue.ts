// W25 build queue (Supreme Commander style). Each unit has its own order queue (world.ts orders,
// MAX_ORDERS); an order goes onto the queue of every unit it was given to, and units that share an
// item build it together, each when it reaches that item in its own queue (units.ts works only on
// a unit's first order, so a unit never works on an item it has not queued, except by an explicit
// assist order).
//
// Ownership is the queues themselves: a site is held while any live unit's queue refers to it, by a
// build order on the site or a run order on the wall run it belongs to. When orders are replaced
// (an order without `queue`) or removed (dequeue, clearQueue), dropOrphans removes each reserved
// site those orders referred to that no queue holds any more; it cost nothing, so there is no
// refund. A started site stays as a part-built structure, as in SupCom. A wall run whose last run
// order went loses its reserved tiles (those no unit holds by an assist order) and its run-table
// slot, as cancelRun does; its started tiles stay. A gate site is never removed this way: its walls
// were converted when the gate was ordered (gate.ts), so removing the site would destroy them.
// `stop`, a unit's death and an unreachable site are unchanged from W24: their sites stay.
//
// Also here: the queue as the snapshot carries it (order kind, target, run id, position).

import { B } from './kinds.ts';
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
 * The id that names an order's item for `dequeue`'s `expect`: the building (build, assist, upgrade,
 * gate) or wreck id, the run id for a wall run, -1 for move and produce.
 */
export function orderItem(o: Order): number {
  return o.t === 'build' || o.t === 'reclaim' ? o.id : o.t === 'run' ? o.run : -1;
}

/**
 * Index in unit slot `slot`'s queue that a dequeue removes, or -1. Without `expect`, `index` itself
 * when it is in range. With `expect`, `index` if the order there is that item, otherwise the first
 * order that is (the queue moved on between the snapshot and the command's tick).
 */
export function dequeueIndex(w: World, slot: number, index: number, expect?: { kind: number; target: number }): number {
  const orders = w.orders[slot] ?? [];
  if (!expect) return index >= 0 && index < orders.length ? index : -1;
  const is = (o: Order | undefined) => o !== undefined && orderKind(o) === expect.kind && orderItem(o) === expect.target;
  if (is(orders[index])) return index;
  return orders.findIndex(is);
}

/** Removes building `id` if it is a reserved site (never a gate site; see the header). */
function removeIfReserved(w: World, id: number): void {
  const s = w.buildings.slotForId(id);
  if (s < 0 || !isReserved(w.buildings.cols.flags[s]!) || w.buildings.cols.kind[s] === B.gate) return;
  w.removeBuilding(s);
}

/**
 * After `removed` left the queues (replaced or dequeued): removes the reserved sites they referred
 * to that no live unit's queue holds any more, and frees runs left with no run order.
 */
export function dropOrphans(w: World, removed: readonly Order[]): void {
  const sites = new Set<number>();
  const runs = new Set<number>();
  for (const o of removed) {
    if (o.t === 'build') sites.add(o.id);
    else if (o.t === 'run') runs.add(o.run);
  }
  if (!sites.size && !runs.size) return;
  const heldSites = new Set<number>();
  const heldRuns = new Set<number>();
  for (let s = 0; s < w.units.highWater; s++) {
    if (!w.units.alive[s]) continue;
    for (const o of w.orders[s] ?? []) {
      if (o.t === 'build') heldSites.add(o.id);
      else if (o.t === 'run') heldRuns.add(o.run);
    }
  }
  // Tiles of runs still being worked on are held by those run orders.
  for (const r of w.runs) if (r && heldRuns.has(r.id)) for (const site of r.sites) heldSites.add(site);
  // Sets iterate in insertion order (queue order), so removal order is deterministic.
  for (const id of runs) {
    if (heldRuns.has(id)) continue;
    const i = w.runs.findIndex((r) => r !== null && r.id === id);
    if (i < 0) continue;
    for (const site of w.runs[i]!.sites) if (!heldSites.has(site)) removeIfReserved(w, site);
    w.runs[i] = null;
  }
  for (const id of sites) if (!heldSites.has(id)) removeIfReserved(w, id);
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
