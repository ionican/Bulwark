// Turrets, projectiles, damage and shields.
//
// Turrets keep their target while it stays in range, otherwise take the nearest alien in range,
// preferring the weapon's favoured kind (beam: hunters; heavy cannon: wall-breakers), as in W12.
// Shots are projectiles that home on their target; the beam hits instantly. The beam fires at the
// energy upkeep ratio (nothing at zero energy); the heavy cannon spends one advanced part per shot
// and holds fire with none. Alien attacks are short-range projectiles too, so a shield generator
// absorbs them for anything within its radius except walls (W12's rule), scaled by the upkeep ratio.
// Armour: each hit loses a flat `armour`, and at least 10% of it always gets through (W12).
// W24: every shot carries its shooter's type, kind and id from the moment of firing, and each hit
// records what the target actually lost in the per-kind counters (stats.ts). Damage, range and
// fire interval include the sandbox tuning multipliers (tuning.ts); a projectile keeps the damage
// it was fired with. Unlimited spending (sandbox) fires the heavy cannon without parts.

import { BF_ACTIVE, BF_COMPLETE, BF_FIRING, BF_STARVED, T_ALIEN, T_BUILDING, T_NONE, T_UNIT } from './schema.ts';
import { B, P_ALIEN, P_SHELL, SHIELD, TICK_SECONDS, U, WRECK_DECAY_PER_SECOND, alienInfo, buildingInfo, unitInfo, type Weapon } from './kinds.ts';
import { turretDamage, turretInterval, turretRange } from './tuning.ts';
import { recordAbsorbed, recordAlienDamage, recordHitOnAlien, recordShot } from './stats.ts';
import type { World } from './world.ts';

const DT = TICK_SECONDS;

/** Bucket grid over aliens for range queries; rebuilt every tick. */
export class AlienGrid {
  static readonly CELL = 8;
  readonly cw: number;
  readonly ch: number;
  readonly head: Int32Array;
  readonly next: Int32Array;

  constructor(w: number, h: number, capacity: number) {
    this.cw = Math.ceil(w / AlienGrid.CELL);
    this.ch = Math.ceil(h / AlienGrid.CELL);
    this.head = new Int32Array(this.cw * this.ch);
    this.next = new Int32Array(capacity);
  }

  rebuild(w: World): void {
    this.head.fill(-1);
    const a = w.aliens;
    const c = a.cols;
    // Insert in descending slot order so each bucket lists ascending slots.
    for (let s = a.highWater - 1; s >= 0; s--) {
      if (!a.alive[s] || c.hp[s]! <= 0) continue;
      const k = this.cellOf(c.x[s]!, c.z[s]!);
      this.next[s] = this.head[k]!;
      this.head[k] = s;
    }
  }

  cellOf(x: number, z: number): number {
    let cx = Math.floor(x / AlienGrid.CELL);
    let cz = Math.floor(z / AlienGrid.CELL);
    cx = cx < 0 ? 0 : cx >= this.cw ? this.cw - 1 : cx;
    cz = cz < 0 ? 0 : cz >= this.ch ? this.ch - 1 : cz;
    return cz * this.cw + cx;
  }

  /** Calls fn(slot) for every alien in buckets overlapping the square round (x, z). */
  forEachNear(x: number, z: number, r: number, fn: (slot: number) => void): void {
    const C = AlienGrid.CELL;
    const x0 = Math.max(0, Math.floor((x - r) / C));
    const x1 = Math.min(this.cw - 1, Math.floor((x + r) / C));
    const z0 = Math.max(0, Math.floor((z - r) / C));
    const z1 = Math.min(this.ch - 1, Math.floor((z + r) / C));
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) for (let s = this.head[cz * this.cw + cx]!; s >= 0; s = this.next[s]!) fn(s);
  }
}

/** Centre of a building's fw × fh footprint. */
export function centreOf(w: World, s: number): [number, number] {
  const c = w.buildings.cols;
  return [c.tx[s]! + c.fw[s]! / 2, c.ty[s]! + c.fh[s]! / 2];
}

/** Distance from a point to a building's footprint rectangle (0 inside): the nearest footprint tile. */
export function distToBuilding(w: World, s: number, x: number, z: number): number {
  const c = w.buildings.cols;
  const x0 = c.tx[s]!;
  const z0 = c.ty[s]!;
  const x1 = x0 + c.fw[s]!;
  const z1 = z0 + c.fh[s]!;
  const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
  const dz = z < z0 ? z0 - z : z > z1 ? z - z1 : 0;
  return Math.sqrt(dx * dx + dz * dz);
}

let bestSlot = -1;
let bestPref = false;
let bestD2 = 0;

/** Nearest alien within `range` of (x, z), preferring kind `prefer`. Returns a slot or -1. */
export function findAlien(w: World, x: number, z: number, range: number, prefer: number): number {
  const c = w.aliens.cols;
  bestSlot = -1;
  bestPref = false;
  bestD2 = Infinity;
  w.alienGrid.forEachNear(x, z, range + 1, (s) => {
    if (c.hp[s]! <= 0) return;
    const dx = c.x[s]! - x;
    const dz = c.z[s]! - z;
    const reach = range + alienInfo(c.kind[s]!).radius;
    const d2 = dx * dx + dz * dz;
    if (d2 > reach * reach) return;
    const pref = prefer >= 0 && c.kind[s] === prefer;
    if (bestSlot < 0 || (pref && !bestPref) || (pref === bestPref && (d2 < bestD2 || (d2 === bestD2 && s < bestSlot)))) {
      bestSlot = s;
      bestPref = pref;
      bestD2 = d2;
    }
  });
  return bestSlot;
}

function inRange(w: World, alienSlot: number, x: number, z: number, range: number): boolean {
  const c = w.aliens.cols;
  if (!w.aliens.alive[alienSlot] || c.hp[alienSlot]! <= 0) return false;
  const dx = c.x[alienSlot]! - x;
  const dz = c.z[alienSlot]! - z;
  const reach = range + alienInfo(c.kind[alienSlot]!).radius;
  return dx * dx + dz * dz <= reach * reach;
}

/** Turrets keep a target in range or pick a new one. Runs before upkeep: beams draw only with a target. */
export function acquireTargets(w: World): void {
  w.alienGrid.rebuild(w);
  const b = w.buildings;
  const c = b.cols;
  for (let s = 0; s < b.highWater; s++) {
    if (!b.alive[s]) continue;
    const wpn = buildingInfo(c.kind[s]!).weapon;
    if (!wpn || !(c.flags[s]! & BF_COMPLETE)) {
      c.target[s] = 0;
      continue;
    }
    const [x, z] = centreOf(w, s);
    const range = turretRange(w, c.kind[s]!);
    const cur = c.target[s]! - 1;
    if (cur >= 0) {
      const slot = w.aliens.slotForId(cur);
      if (slot >= 0 && inRange(w, slot, x, z, range)) continue;
    }
    const t = findAlien(w, x, z, range, wpn.prefer);
    c.target[s] = t >= 0 ? w.aliens.id(t) + 1 : 0;
  }
}

export function spawnProjectile(
  w: World,
  kind: number,
  x: number,
  z: number,
  tType: number,
  tId: number,
  tx: number,
  tz: number,
  damage: number,
  speed: number,
  wpn: Weapon | undefined,
  srcType: number,
  srcKind: number,
  srcId: number,
): void {
  const p = w.projectiles;
  if (p.count >= p.capacity) return;
  const s = p.create();
  const c = p.cols;
  c.kind[s] = kind;
  c.x[s] = x;
  c.z[s] = z;
  const dx = tx - x;
  const dz = tz - z;
  const d = Math.sqrt(dx * dx + dz * dz) || 1;
  c.fx[s] = dx / d;
  c.fz[s] = dz / d;
  c.tType[s] = tType;
  c.tId[s] = tId;
  c.tx[s] = tx;
  c.tz[s] = tz;
  c.damage[s] = damage;
  c.speed[s] = speed * DT;
  c.splashTargets[s] = wpn?.splashTargets ?? 0;
  c.splashRadius[s] = wpn?.splashRadius ?? 0;
  c.splashFactor[s] = wpn?.splashFactor ?? 0;
  c.life[s] = 100;
  c.srcType[s] = srcType;
  c.srcKind[s] = srcKind;
  c.srcId[s] = srcId;
}

/**
 * Applies a hit to an alien with W12's armour rule, crediting the shooter (srcType, srcKind) with
 * the hit points the alien actually lost and with the kill if this hit removed the last of them.
 */
export function damageAlien(w: World, s: number, damage: number, srcType = T_NONE, srcKind = 0): void {
  const c = w.aliens.cols;
  const armour = alienInfo(c.kind[s]!).armour;
  const before = c.hp[s]!;
  c.hp[s] = before - Math.max(damage - armour, damage * 0.1);
  if (before > 0) recordHitOnAlien(w, srcType, srcKind, before - Math.max(0, c.hp[s]!), c.hp[s]! <= 0);
}

/** Shields within range of (x, z) absorb damage first, scaled by the energy upkeep ratio. */
function absorb(w: World, x: number, z: number, dmg: number): number {
  if (w.upkeep <= 0) return dmg;
  const b = w.buildings;
  const c = b.cols;
  const r2 = SHIELD.radius * SHIELD.radius;
  for (let s = 0; s < b.highWater && dmg > 0; s++) {
    if (!b.alive[s] || c.kind[s] !== B.shield || !(c.flags[s]! & BF_COMPLETE) || c.shield[s]! <= 0) continue;
    const [sx, sz] = centreOf(w, s);
    const dx = sx - x;
    const dz = sz - z;
    if (dx * dx + dz * dz > r2) continue;
    const can = Math.min(dmg * w.upkeep, c.shield[s]!);
    c.shield[s] = c.shield[s]! - can;
    dmg -= can;
  }
  return dmg;
}

export function damageBuilding(w: World, s: number, dmg: number, srcType = T_NONE, srcKind = 0): void {
  const c = w.buildings.cols;
  const wall = buildingInfo(c.kind[s]!).role === 'wall';
  if (!wall) {
    const [x, z] = centreOf(w, s);
    const left = absorb(w, x, z, dmg);
    recordAbsorbed(w, srcType, srcKind, dmg - left);
    dmg = left;
  }
  if (dmg <= 0) return;
  const before = c.hp[s]!;
  c.hp[s] = before - dmg;
  if (before > 0) recordAlienDamage(w, srcType, srcKind, wall ? 'wall' : 'building', Math.min(before, dmg));
  w.costDrift = true;
}

export function damageUnit(w: World, s: number, dmg: number, srcType = T_NONE, srcKind = 0): void {
  const c = w.units.cols;
  const left = absorb(w, c.x[s]!, c.z[s]!, dmg);
  recordAbsorbed(w, srcType, srcKind, dmg - left);
  const before = c.hp[s]!;
  c.hp[s] = before - left;
  if (before > 0 && left > 0) recordAlienDamage(w, srcType, srcKind, 'unit', Math.min(before, left));
}

export function fireTurrets(w: World): void {
  const b = w.buildings;
  const c = b.cols;
  const ac = w.aliens.cols;
  const u = w.upkeep;
  for (let s = 0; s < b.highWater; s++) {
    if (!b.alive[s]) continue;
    c.flags[s] = c.flags[s]! & ~BF_FIRING;
    const kind = c.kind[s]!;
    const wpn = buildingInfo(kind).weapon;
    if (!wpn || !(c.flags[s]! & BF_COMPLETE)) continue;
    const t = c.target[s]! === 0 ? -1 : w.aliens.slotForId(c.target[s]! - 1);
    const rate = wpn.energyPerSecond > 0 ? u : 1;
    const interval = turretInterval(w, kind);
    let cd = c.cooldown[s]! - DT * rate;
    if (t < 0) {
      c.cooldown[s] = Math.max(0, cd);
      continue;
    }
    if (rate <= 0) {
      // An energy weapon with no energy does nothing.
      c.flags[s] = c.flags[s]! | BF_STARVED;
      c.cooldown[s] = Math.max(0, cd);
      continue;
    }
    if (wpn.energyPerSecond > 0) c.flags[s] = c.flags[s]! | BF_FIRING;
    const [x, z] = centreOf(w, s);
    let guard = 0;
    while (cd <= 1e-9 && guard++ < 10) {
      if (wpn.partsPerShot > 0 && !w.unlimited) {
        if (w.parts + 1e-9 < wpn.partsPerShot) {
          c.flags[s] = c.flags[s]! | BF_STARVED;
          cd = 0;
          break;
        }
        w.parts -= wpn.partsPerShot;
        w.partsUsed += wpn.partsPerShot;
      }
      // Tier 2 (researched, then upgraded by engineers) multiplies damage (W12 damageMult).
      const dmg = turretDamage(w, kind, c.tier[s]!);
      recordShot(w, T_BUILDING, kind);
      if (wpn.shotSpeed <= 0) damageAlien(w, t, dmg, T_BUILDING, kind);
      else spawnProjectile(w, wpn.shot, x, z, T_ALIEN, w.aliens.id(t), ac.x[t]!, ac.z[t]!, dmg, wpn.shotSpeed, wpn, T_BUILDING, kind, b.id(s));
      c.flags[s] = c.flags[s]! | BF_FIRING;
      cd += interval;
    }
    c.cooldown[s] = cd;
  }
  // The commander's personal gun.
  const cs = w.commanderSlot();
  if (cs >= 0) {
    const uc = w.units.cols;
    const wpn = unitInfo(uc.kind[cs]!).weapon!;
    let cd = uc.weaponCd[cs]! - DT;
    const t = findAlien(w, uc.x[cs]!, uc.z[cs]!, wpn.range, -1);
    if (t < 0) cd = Math.max(0, cd);
    else if (cd <= 0) {
      recordShot(w, T_UNIT, U.commander);
      spawnProjectile(w, wpn.shot, uc.x[cs]!, uc.z[cs]!, T_ALIEN, w.aliens.id(t), ac.x[t]!, ac.z[t]!, wpn.damage, wpn.shotSpeed, wpn, T_UNIT, U.commander, w.units.id(cs));
      cd += wpn.interval;
    }
    uc.weaponCd[cs] = cd;
  }
}

/** Current position of a projectile's target, or null if it has gone. */
function targetPos(w: World, type: number, id: number): [number, number] | null {
  if (type === T_ALIEN) {
    const s = w.aliens.slotForId(id);
    return s >= 0 && w.aliens.cols.hp[s]! > 0 ? [w.aliens.cols.x[s]!, w.aliens.cols.z[s]!] : null;
  }
  if (type === T_UNIT) {
    const s = w.units.slotForId(id);
    return s >= 0 ? [w.units.cols.x[s]!, w.units.cols.z[s]!] : null;
  }
  if (type === T_BUILDING) {
    const s = w.buildings.slotForId(id);
    return s >= 0 ? centreOf(w, s) : null;
  }
  return null;
}

export function stepProjectiles(w: World): void {
  const p = w.projectiles;
  const c = p.cols;
  for (let s = 0; s < p.highWater; s++) {
    if (!p.alive[s]) continue;
    const tp = targetPos(w, c.tType[s]!, c.tId[s]!);
    if (tp) {
      c.tx[s] = tp[0];
      c.tz[s] = tp[1];
    }
    const dx = c.tx[s]! - c.x[s]!;
    const dz = c.tz[s]! - c.z[s]!;
    const d = Math.sqrt(dx * dx + dz * dz);
    const step = c.speed[s]!;
    c.life[s] = c.life[s]! - 1;
    if (d > step && c.life[s]! > 0) {
      c.fx[s] = dx / d;
      c.fz[s] = dz / d;
      c.x[s] = c.x[s]! + c.fx[s]! * step;
      c.z[s] = c.z[s]! + c.fz[s]! * step;
      continue;
    }
    // Impact.
    c.x[s] = c.tx[s]!;
    c.z[s] = c.tz[s]!;
    if (tp) impact(w, s);
    else if (c.splashTargets[s]! > 0) splash(w, s, -1);
    p.remove(s);
  }
}

function impact(w: World, s: number): void {
  const c = w.projectiles.cols;
  const type = c.tType[s]!;
  const id = c.tId[s]!;
  const st = c.srcType[s]!;
  const sk = c.srcKind[s]!;
  if (type === T_ALIEN) {
    const a = w.aliens.slotForId(id);
    if (a >= 0) damageAlien(w, a, c.damage[s]!, st, sk);
    if (c.splashTargets[s]! > 0) splash(w, s, a);
  } else if (type === T_BUILDING) {
    const b = w.buildings.slotForId(id);
    if (b >= 0) damageBuilding(w, b, c.damage[s]!, st, sk);
  } else if (type === T_UNIT) {
    const u = w.units.slotForId(id);
    if (u >= 0) damageUnit(w, u, c.damage[s]!, st, sk);
  }
}

/** Area damage: up to `splashTargets` other aliens nearest the impact within `splashRadius`. */
function splash(w: World, s: number, primary: number): void {
  const pc = w.projectiles.cols;
  const ac = w.aliens.cols;
  const x = pc.x[s]!;
  const z = pc.z[s]!;
  const r = pc.splashRadius[s]!;
  const hits: Array<[number, number]> = [];
  w.alienGrid.forEachNear(x, z, r + 1, (a) => {
    if (a === primary || !w.aliens.alive[a] || ac.hp[a]! <= 0) return;
    const dx = ac.x[a]! - x;
    const dz = ac.z[a]! - z;
    const d2 = dx * dx + dz * dz;
    if (d2 <= r * r) hits.push([d2, a]);
  });
  hits.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const n = Math.min(hits.length, pc.splashTargets[s]!);
  for (let i = 0; i < n; i++) damageAlien(w, hits[i]![1], pc.damage[s]! * pc.splashFactor[s]!, pc.srcType[s]!, pc.srcKind[s]!);
}

/** Alien attack: a short-range shot at a building or unit. */
export function alienShot(w: World, alien: number, tType: number, tId: number, tx: number, tz: number, damage: number): void {
  const c = w.aliens.cols;
  spawnProjectile(w, P_ALIEN, c.x[alien]!, c.z[alien]!, tType, tId, tx, tz, damage, 12, undefined, T_ALIEN, c.kind[alien]!, w.aliens.id(alien));
}

export function stepShieldsAndTimers(w: World): void {
  const b = w.buildings;
  const c = b.cols;
  for (let s = 0; s < b.highWater; s++) {
    if (!b.alive[s]) continue;
    const kind = c.kind[s]!;
    if (kind === B.shield && c.flags[s]! & BF_ACTIVE) {
      c.shield[s] = Math.min(SHIELD.capacity, c.shield[s]! + SHIELD.regenPerSecond * DT * w.upkeep);
    } else if (kind === B.tempTurret) {
      c.life[s] = c.life[s]! - DT;
      if (c.life[s]! <= 0) w.removeBuilding(s);
    }
  }
  const wr = w.wrecks;
  const wc = wr.cols;
  const keep = 1 - WRECK_DECAY_PER_SECOND * DT;
  for (let s = 0; s < wr.highWater; s++) {
    if (!wr.alive[s]) continue;
    wc.salvage[s] = wc.salvage[s]! * keep;
    if (wc.salvage[s]! < 0.05) wr.remove(s);
  }
  const u = w.units;
  for (let s = 0; s < u.highWater; s++) if (u.alive[s] && u.cols.cooldown[s]! > 0) u.cols.cooldown[s] = Math.max(0, u.cols.cooldown[s]! - DT);
}

export { P_SHELL };
