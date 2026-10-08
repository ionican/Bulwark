// Alien behaviour. Each alien follows its category's flow field one tile at a time. When the next
// tile holds a solid player building (a wall in the way, or the goal itself) it stops and shoots it
// until it falls; belt tiles are walked over unless they are the goal (saboteurs).
// Opportunistic targets: commander hunters shoot the commander once in reach; saboteurs go for an
// engineer within 4 tiles. Attacks are one shot per second of dps × 1 s (× structureMult against
// walls and turrets), so shields can absorb them.
// W24: a reserved construction site (no build power yet) is not solid: aliens walk over it unless
// it is their goal, which they shoot as in W13. Damage per shot and speed include the sandbox
// tuning multipliers.

import { AS_ATTACKING, AS_MOVING, T_BUILDING, T_NONE, T_UNIT } from './schema.ts';
import { A, TICK_SECONDS, U, alienInfo, buildingInfo, isBelt, unitInfo } from './kinds.ts';
import { alienDps, alienSpeed } from './tuning.ts';
import { alienShot, centreOf, distToBuilding } from './combat.ts';
import { GOAL_COMMANDER, isReserved, type World } from './world.ts';

const DT = TICK_SECONDS;
const SHOT_INTERVAL = 1;

function solidAt(w: World, x: number, z: number): boolean {
  const tx = Math.floor(x);
  const tz = Math.floor(z);
  if (tx < 0 || tz < 0 || tx >= w.terrain.w || tz >= w.terrain.h) return true;
  return !w.alienPassable(tz * w.terrain.w + tx);
}

/** Moves alien s towards (px, pz) by its speed, never into rock or a solid building. */
function moveTowards(w: World, s: number, px: number, pz: number, speed: number): void {
  const c = w.aliens.cols;
  const dx = px - c.x[s]!;
  const dz = pz - c.z[s]!;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < 1e-6) return;
  const step = d < speed ? d : speed;
  const fx = dx / d;
  const fz = dz / d;
  c.fx[s] = fx;
  c.fz[s] = fz;
  const nx = c.x[s]! + fx * step;
  const nz = c.z[s]! + fz * step;
  if (solidAt(w, nx, nz) && !solidAt(w, c.x[s]!, c.z[s]!)) return;
  c.x[s] = nx;
  c.z[s] = nz;
}

function targetValid(w: World, s: number): boolean {
  const c = w.aliens.cols;
  const info = alienInfo(c.kind[s]!);
  const type = c.tType[s]!;
  if (type === T_BUILDING) {
    const b = w.buildings.slotForId(c.tId[s]!);
    return b >= 0 && w.buildings.cols.hp[b]! > 0 && distToBuilding(w, b, c.x[s]!, c.z[s]!) <= info.radius + info.reach + 0.9;
  }
  if (type === T_UNIT) {
    const u = w.units.slotForId(c.tId[s]!);
    if (u < 0) return false;
    const dx = w.units.cols.x[u]! - c.x[s]!;
    const dz = w.units.cols.z[u]! - c.z[s]!;
    const reach = info.radius + unitInfo(w.units.cols.kind[u]!).radius + info.reach;
    return dx * dx + dz * dz <= reach * reach;
  }
  return false;
}

function shoot(w: World, s: number): void {
  const c = w.aliens.cols;
  if (c.cooldown[s]! > 0) return;
  const info = alienInfo(c.kind[s]!);
  const dps = alienDps(w, c.kind[s]!);
  if (c.tType[s] === T_BUILDING) {
    const b = w.buildings.slotForId(c.tId[s]!);
    const role = buildingInfo(w.buildings.cols.kind[b]!).role;
    const mult = role === 'wall' || role === 'defence' ? info.structureMult : 1;
    const [x, z] = centreOf(w, b);
    alienShot(w, s, T_BUILDING, c.tId[s]!, x, z, dps * SHOT_INTERVAL * mult);
  } else {
    const u = w.units.slotForId(c.tId[s]!);
    alienShot(w, s, T_UNIT, c.tId[s]!, w.units.cols.x[u]!, w.units.cols.z[u]!, dps * SHOT_INTERVAL);
  }
  c.cooldown[s] = SHOT_INTERVAL;
}

export function stepAliens(w: World): void {
  const a = w.aliens;
  const c = a.cols;
  const W = w.terrain.w;
  const uc = w.units.cols;
  const cmdr = w.commanderSlot();
  for (let s = 0; s < a.highWater; s++) {
    if (!a.alive[s] || c.hp[s]! <= 0) continue;
    const kind = c.kind[s]!;
    const info = alienInfo(kind);
    const speed = alienSpeed(w, kind);
    if (c.cooldown[s]! > 0) c.cooldown[s] = c.cooldown[s]! - DT;

    // Keep shooting a target that is still in reach.
    if (c.tType[s] !== T_NONE && targetValid(w, s)) {
      c.state[s] = AS_ATTACKING;
      shoot(w, s);
      continue;
    }
    c.tType[s] = T_NONE;
    c.state[s] = AS_MOVING;
    const x = c.x[s]!;
    const z = c.z[s]!;

    // Hunters (and any alien whose field has fallen back to the commander) shoot the commander in reach.
    const wantsCommander = kind === A.hunter || w.fieldGoal[info.category] === GOAL_COMMANDER;
    if (wantsCommander && cmdr >= 0) {
      c.tType[s] = T_UNIT;
      c.tId[s] = w.units.id(cmdr);
      if (targetValid(w, s)) {
        c.state[s] = AS_ATTACKING;
        shoot(w, s);
        continue;
      }
      c.tType[s] = T_NONE;
    }

    // Saboteurs go for a nearby engineer.
    if (kind === A.saboteur) {
      let best = -1;
      let bestD2 = 16;
      for (let u = 0; u < w.units.highWater; u++) {
        if (!w.units.alive[u] || uc.kind[u] !== U.engineer) continue;
        const dx = uc.x[u]! - x;
        const dz = uc.z[u]! - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = u;
        }
      }
      if (best >= 0) {
        c.tType[s] = T_UNIT;
        c.tId[s] = w.units.id(best);
        if (targetValid(w, s)) {
          c.state[s] = AS_ATTACKING;
          shoot(w, s);
        } else {
          c.tType[s] = T_NONE;
          moveTowards(w, s, uc.x[best]!, uc.z[best]!, speed);
        }
        continue;
      }
    }

    const field = w.fields[info.category]!;
    const cell = Math.floor(z) * W + Math.floor(x);
    // Standing on a goal tile it can walk onto (a belt, or a reserved site): attack it.
    const here = w.occupancy[cell]! - 1;
    if (here >= 0 && w.isGoalBuilding(info.category, w.buildings.cols.kind[here]!)) {
      c.tType[s] = T_BUILDING;
      c.tId[s] = w.buildings.id(here);
      c.state[s] = AS_ATTACKING;
      shoot(w, s);
      continue;
    }
    const next = field.next(cell);
    if (next < 0) {
      if (field.dist[cell] === 0 && cmdr >= 0 && w.fieldGoal[info.category] === GOAL_COMMANDER) moveTowards(w, s, uc.x[cmdr]!, uc.z[cmdr]!, speed);
      else if (field.dist[cell]! > 0) moveTowards(w, s, w.terrain.base.x, w.terrain.base.z, speed); // no route: head for the base
      continue;
    }
    const b = w.occupancy[next]! - 1;
    if (b >= 0) {
      const bk = w.buildings.cols.kind[b]!;
      const solid = !isBelt(bk) && !isReserved(w.buildings.cols.flags[b]!);
      if (solid || w.isGoalBuilding(info.category, bk)) {
        // A building blocks the route (or is the goal): break through it.
        c.tType[s] = T_BUILDING;
        c.tId[s] = w.buildings.id(b);
        c.state[s] = AS_ATTACKING;
        shoot(w, s);
        continue;
      }
    }
    const nx = next % W;
    const nz = (next - nx) / W;
    moveTowards(w, s, nx + 0.5 + c.ox[s]!, nz + 0.5 + c.oz[s]!, speed);
  }
}
