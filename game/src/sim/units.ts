// Commander and engineer orders: move, build (or assist, or upgrade), work on a wall run, reclaim.
//
// Units path with A* on the tile grid round solid buildings (they walk over belts). A builder in
// range adds its build power to the site; the drain and progress are worked out in economy.ts.
// Reclaim: an engineer pulls salvage from a wreck at RECLAIM_RATE into its own load, carries the
// load to the nearest finished salvage depot and unloads it there (salvage is credited only on
// delivery), then goes back for more, moving on to the nearest wreck within 12 tiles when one runs out.
// Wall run (W24, runs.ts): one order per builder; it claims the next unclaimed tile of the run in
// build order, builds it like a build order, then claims the next, until none is left unclaimed.
// Speed and build power include the sandbox tuning multipliers (tuning.ts).

import { BF_COMPLETE, BF_UPGRADING, US_BUILDING, US_IDLE, US_MOVING, US_RECLAIMING, US_UNLOADING, US_WAITING } from './schema.ts';
import { B, CARRY_CAPACITY, RECLAIM_RATE, TICK_SECONDS, U, unitInfo } from './kinds.ts';
import { centreOf, distToBuilding } from './combat.ts';
import { unitBuildRate, unitSpeed } from './tuning.ts';
import { PROGRESS_EPS } from './economy.ts';
import { claimNext, runById } from './runs.ts';
import type { World } from './world.ts';

const DT = TICK_SECONDS;

export type Order =
  | { t: 'move'; x: number; z: number }
  | { t: 'build'; id: number }
  /** Work through wall run `run` (runs.ts); `site` is the tile currently claimed (-1 = none). */
  | { t: 'run'; run: number; site: number }
  /** Commander only: produce an engineer (progress 0..1). */
  | { t: 'produce'; progress: number }
  /** phase 0 collecting, 1 delivering; (x, z) where the last wreck was. */
  | { t: 'reclaim'; id: number; phase: number; x: number; z: number };

const RECLAIM_REACH = 1.5;
const UNLOAD_REACH = 1.5;
const NEXT_WRECK_RADIUS = 12;

/**
 * Walks unit s towards a goal. `key` identifies the goal so the path is planned once; `isGoal`
 * says which cells count as arrived. Returns true once the unit stands in a goal cell.
 */
function walk(w: World, s: number, key: string, gx: number, gz: number, isGoal: (cell: number) => boolean): boolean {
  const c = w.units.cols;
  const W = w.terrain.w;
  const cell = Math.floor(c.z[s]!) * W + Math.floor(c.x[s]!);
  if (isGoal(cell)) {
    w.paths[s] = null;
    return true;
  }
  let path = w.paths[s];
  // Replan when the goal changed or the next step became blocked.
  if (!path || w.pathKey[s] !== key || (w.pathPos[s]! < path.length && !w.walk[path[w.pathPos[s]!]!])) {
    path = w.pathfinder.find(w.walk, cell, gx, gz, isGoal);
    w.paths[s] = path;
    w.pathPos[s] = 0;
    w.pathKey[s] = key;
    if (!path) return false;
  }
  if (w.pathPos[s]! >= path.length) {
    w.paths[s] = null;
    return isGoal(cell);
  }
  const next = path[w.pathPos[s]!]!;
  const nx = (next % W) + 0.5;
  const nz = Math.floor(next / W) + 0.5;
  const speed = unitSpeed(w, c.kind[s]!);
  const dx = nx - c.x[s]!;
  const dz = nz - c.z[s]!;
  const d = Math.sqrt(dx * dx + dz * dz);
  c.state[s] = US_MOVING;
  if (d <= speed) {
    c.x[s] = nx;
    c.z[s] = nz;
    w.pathPos[s] = w.pathPos[s]! + 1;
  } else {
    c.fx[s] = dx / d;
    c.fz[s] = dz / d;
    c.x[s] = c.x[s]! + c.fx[s]! * speed;
    c.z[s] = c.z[s]! + c.fz[s]! * speed;
  }
  return false;
}

/** Straight-line step to an exact point (the last part of a move order). */
function stepTo(w: World, s: number, x: number, z: number): boolean {
  const c = w.units.cols;
  const speed = unitSpeed(w, c.kind[s]!);
  const dx = x - c.x[s]!;
  const dz = z - c.z[s]!;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d <= speed) {
    c.x[s] = x;
    c.z[s] = z;
    return true;
  }
  c.fx[s] = dx / d;
  c.fz[s] = dz / d;
  c.x[s] = c.x[s]! + c.fx[s]! * speed;
  c.z[s] = c.z[s]! + c.fz[s]! * speed;
  c.state[s] = US_MOVING;
  return false;
}

/**
 * Builder s works on site slot b (id `id`): adds its build power when in range, otherwise walks
 * there. Returns false when the site cannot be reached (the caller drops the order).
 */
function workOnSite(w: World, s: number, b: number, id: number, range: number, buildRate: number): boolean {
  const c = w.units.cols;
  const W = w.terrain.w;
  // Footprint centre, inline (combat.ts centreOf allocates; this runs per builder per tick).
  const bcols = w.buildings.cols;
  const bx = bcols.tx[b]! + bcols.fw[b]! / 2;
  const bz = bcols.ty[b]! + bcols.fh[b]! / 2;
  if (distToBuilding(w, b, c.x[s]!, c.z[s]!) <= range) {
    c.state[s] = US_BUILDING;
    c.work[s] = id + 1;
    w.buildPower[b] = w.buildPower[b]! + buildRate;
    w.builderCount[b] = Math.min(255, w.builderCount[b]! + 1);
    const dx = bx - c.x[s]!;
    const dz = bz - c.z[s]!;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > 1e-6) {
      c.fx[s] = dx / d;
      c.fz[s] = dz / d;
    }
    return true;
  }
  const ok = walk(w, s, `b${id}`, bx, bz, (cell) => {
    const cx = (cell % W) + 0.5;
    const cz = Math.floor(cell / W) + 0.5;
    return distToBuilding(w, b, cx, cz) <= range - 0.2;
  });
  // In a goal cell but not yet in reach from where it stands: close the last bit directly.
  if (ok) stepTo(w, s, bx, bz);
  else if (!w.paths[s]) return false; // cannot reach the site
  return true;
}

const unfinished = (w: World, b: number) => {
  const f = w.buildings.cols.flags[b]!;
  return (f & BF_COMPLETE) === 0 || (f & BF_UPGRADING) !== 0;
};

function cellCentreDist(W: number, cell: number, x: number, z: number): number {
  const cx = (cell % W) + 0.5;
  const cz = Math.floor(cell / W) + 0.5;
  const dx = cx - x;
  const dz = cz - z;
  return Math.sqrt(dx * dx + dz * dz);
}

function nearestWreck(w: World, x: number, z: number, radius: number): number {
  const wr = w.wrecks;
  const c = wr.cols;
  let best = -1;
  let bestD2 = radius * radius;
  for (let s = 0; s < wr.highWater; s++) {
    if (!wr.alive[s]) continue;
    const dx = c.x[s]! - x;
    const dz = c.z[s]! - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = s;
    }
  }
  return best;
}

function nearestDepot(w: World, x: number, z: number): number {
  const b = w.buildings;
  const c = b.cols;
  let best = -1;
  let bestD = Infinity;
  for (let s = 0; s < b.highWater; s++) {
    if (!b.alive[s] || c.kind[s] !== B.depot || !(c.flags[s]! & BF_COMPLETE)) continue;
    const d = distToBuilding(w, s, x, z);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

export function stepUnits(w: World): void {
  const u = w.units;
  const c = u.cols;
  const W = w.terrain.w;
  for (let s = 0; s < u.highWater; s++) {
    if (!u.alive[s]) continue;
    const orders = w.orders[s]!;
    c.work[s] = 0;
    const order = orders[0];
    if (!order) {
      c.state[s] = US_IDLE;
      continue;
    }
    const info = unitInfo(c.kind[s]!);
    const buildRate = unitBuildRate(w, c.kind[s]!);
    if (order.t === 'produce') {
      if (c.kind[s] !== U.commander) {
        orders.shift();
        continue;
      }
      if (order.progress >= 1 - PROGRESS_EPS) {
        // Out it walks, just south of the commander.
        w.spawnUnit(U.engineer, w.clampX(c.x[s]! + 1.5), w.clampZ(c.z[s]! + 1.5));
        orders.shift();
        continue;
      }
      c.state[s] = US_BUILDING;
      w.produceJobs.push({ order, bp: buildRate });
      continue;
    }
    if (order.t === 'move') {
      const gcell = Math.floor(order.z) * W + Math.floor(order.x);
      const reached = walk(w, s, `m${gcell}`, order.x, order.z, (cell) => cell === gcell || (!w.walk[gcell] && cellCentreDist(W, cell, order.x, order.z) < 1.6));
      if (reached && (!w.walk[gcell] || stepTo(w, s, order.x, order.z))) orders.shift();
      else if (!reached && !w.paths[s]) orders.shift(); // unreachable
      continue;
    }
    if (order.t === 'build') {
      const b = w.buildings.slotForId(order.id);
      if (b < 0 || !unfinished(w, b)) {
        orders.shift();
        w.paths[s] = null;
        continue;
      }
      if (!workOnSite(w, s, b, order.id, info.buildRange, buildRate)) orders.shift();
      continue;
    }
    if (order.t === 'run') {
      const run = runById(w, order.run);
      if (!run) {
        orders.shift();
        w.paths[s] = null;
        continue;
      }
      let b = order.site >= 0 ? w.buildings.slotForId(order.site) : -1;
      if (b < 0 || !unfinished(w, b)) {
        order.site = claimNext(w, run, s);
        w.paths[s] = null;
        if (order.site < 0) {
          orders.shift(); // every tile is built or held by another builder
          continue;
        }
        b = w.buildings.slotForId(order.site);
      }
      // An unreachable tile ends the order, as for a single build (the tiles stay reserved).
      if (!workOnSite(w, s, b, order.site, info.buildRange, buildRate)) orders.shift();
      continue;
    }
    // Reclaim.
    if (c.kind[s] !== U.engineer) {
      orders.shift();
      continue;
    }
    if (order.phase === 0) {
      let wr = w.wrecks.slotForId(order.id);
      if (wr < 0 || c.carry[s]! >= CARRY_CAPACITY - 0.01) {
        if (wr < 0) {
          const next = nearestWreck(w, order.x || c.x[s]!, order.z || c.z[s]!, NEXT_WRECK_RADIUS);
          if (next >= 0 && c.carry[s]! < CARRY_CAPACITY - 0.01) {
            order.id = w.wrecks.id(next);
            wr = next;
          } else if (c.carry[s]! > 0) {
            order.phase = 1;
            continue;
          } else {
            orders.shift();
            continue;
          }
        } else {
          order.phase = 1;
          continue;
        }
      }
      const wc = w.wrecks.cols;
      order.x = wc.x[wr]!;
      order.z = wc.z[wr]!;
      const dx = wc.x[wr]! - c.x[s]!;
      const dz = wc.z[wr]! - c.z[s]!;
      if (dx * dx + dz * dz <= RECLAIM_REACH * RECLAIM_REACH) {
        c.state[s] = US_RECLAIMING;
        c.work[s] = order.id + 1;
        const take = Math.min(RECLAIM_RATE * DT, wc.salvage[wr]!, CARRY_CAPACITY - c.carry[s]!);
        wc.salvage[wr] = wc.salvage[wr]! - take;
        c.carry[s] = c.carry[s]! + take;
        w.salvageReclaimed += take;
        if (wc.salvage[wr]! <= 0.01) w.wrecks.remove(wr);
        continue;
      }
      const ok = walk(w, s, `r${order.id}`, wc.x[wr]!, wc.z[wr]!, (cell) => cellCentreDist(W, cell, wc.x[wr]!, wc.z[wr]!) <= RECLAIM_REACH - 0.1);
      if (ok) stepTo(w, s, wc.x[wr]!, wc.z[wr]!);
      else if (!w.paths[s]) orders.shift();
      continue;
    }
    // Phase 1: deliver the load to a depot.
    const depot = nearestDepot(w, c.x[s]!, c.z[s]!);
    if (depot < 0) {
      c.state[s] = US_WAITING; // holds the load until a depot exists
      continue;
    }
    if (distToBuilding(w, depot, c.x[s]!, c.z[s]!) <= UNLOAD_REACH) {
      const bc = w.buildings.cols;
      bc.stock[depot] = bc.stock[depot]! + c.carry[s]!;
      w.salvageDelivered += c.carry[s]!;
      c.carry[s] = 0;
      c.state[s] = US_UNLOADING;
      order.phase = 0;
      continue;
    }
    const [dx0, dz0] = centreOf(w, depot);
    const ok = walk(w, s, `d${w.buildings.id(depot)}`, dx0, dz0, (cell) => {
      const cx = (cell % W) + 0.5;
      const cz = Math.floor(cell / W) + 0.5;
      return distToBuilding(w, depot, cx, cz) <= UNLOAD_REACH - 0.2;
    });
    if (ok) stepTo(w, s, dx0, dz0);
    else if (!w.paths[s]) c.state[s] = US_WAITING;
  }
}
