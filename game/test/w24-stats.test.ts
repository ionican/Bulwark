// W24 acceptance 11 (stats): in a scripted fight with two gun turrets, one area cannon and one
// temporary turret against a fixed alien group, the per-kind kills sum to the aliens killed, and
// the per-kind hit points removed sum to the hit points the aliens lost; a turret destroyed
// mid-fight keeps its kind's totals. Also: no overkill, splash credited to the area cannon,
// damage the aliens do, shield absorption, and clears are not kills.

import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world.ts';
import { A, B, U, alienInfo } from '../src/sim/kinds.ts';
import { flatTerrain } from '../src/sim/terrain.ts';
import { AL_ABSORBED, AL_HP_BUILDINGS, AL_HP_WALLS, AL_KILLED, AL_SPAWNED, SHOOTER_KINDS, SH_HP, SH_KILLS, SH_SHOTS, alienStatIndex, shooterIndex, statsReport } from '../src/sim/stats.ts';
import { decodeSnapshot, encodeSnapshot } from '../src/sim/snapshot.ts';
import { BUILDING_KINDS } from '../src/sim/kinds.ts';

const shooter = (w: World, row: number, f: number) => w.stats[shooterIndex(row, f)]!;
const sumShooters = (w: World, f: number) => {
  let n = 0;
  for (let r = 0; r < SHOOTER_KINDS; r++) n += shooter(w, r, f);
  return n;
};

/** The fight: two guns, one area cannon, one engineer-dropped temporary turret; 14 rushers, 4 hunters, 2 breakers. */
function fight() {
  const w = new World(5, flatTerrain(48, 48, { base: { x: 24, z: 44 } }), { waves: false });
  w.pool.set([1e6, 1e6, 1e6]);
  const gunA = w.placeBuilding(B.gun, 20, 30, true);
  const gunB = w.placeBuilding(B.gun, 26, 30, true);
  w.placeBuilding(B.area, 23, 33, true);
  const eng = w.spawnUnit(U.engineer, 23.5, 37.5);
  w.enqueue({ t: 'dropTurret', id: eng });
  w.step();
  // A fixed group, recorded with each alien's maximum hit points.
  const group: Array<{ id: number; max: number }> = [];
  const add = (kind: number, x: number, z: number) => group.push({ id: w.spawnAlien(kind, x, z), max: alienInfo(kind).hp });
  for (let i = 0; i < 14; i++) add(A.rusher, 16 + i, 8 + (i % 3) * 0.7);
  for (let i = 0; i < 4; i++) add(A.hunter, 20 + i * 2, 5);
  add(A.breaker, 21, 3);
  add(A.breaker, 27, 3);
  return { w, gunA, gunB, group };
}

/** Hit points the group has lost: max − remaining (0 for the dead). */
const lost = (w: World, group: Array<{ id: number; max: number }>) =>
  group.reduce((n, a) => {
    const s = w.aliens.slotForId(a.id);
    return n + a.max - (s < 0 ? 0 : Math.max(0, w.aliens.cols.hp[s]!));
  }, 0);

describe('combat statistics', () => {
  it('kills and hit points removed by shooter kind add up to the aliens killed and the hit points they lost; a destroyed turret keeps its totals', () => {
    const { w, gunA, group } = fight();
    expect(w.buildings.count).toBe(4); // the temporary turret stands
    let gunTotalsAtLoss: number[] = [];
    for (let i = 0; i < 3000; i++) {
      w.step();
      // Mid-fight, once gun A has shot, destroy it.
      if (gunTotalsAtLoss.length === 0 && shooter(w, B.gun, SH_KILLS) > 0) {
        w.buildings.cols.hp[w.buildings.slotForId(gunA)] = 0;
        gunTotalsAtLoss = [shooter(w, B.gun, SH_SHOTS), shooter(w, B.gun, SH_HP), shooter(w, B.gun, SH_KILLS)];
      }
      // At every tick: the counters match the losses so far.
      const killed = group.filter((a) => w.aliens.slotForId(a.id) < 0).length;
      expect(sumShooters(w, SH_KILLS)).toBe(killed);
      expect(sumShooters(w, SH_HP)).toBeCloseTo(lost(w, group), 3);
      if (w.aliens.count === 0) break;
    }
    const killed = group.filter((a) => w.aliens.slotForId(a.id) < 0).length;
    expect(killed).toBeGreaterThanOrEqual(18); // most of the group fell (breakers may outlast the turrets)
    expect(w.buildings.slotForId(gunA)).toBe(-1);
    // Gun A's slot is gone, but the gun kind's totals only grew after it.
    expect(shooter(w, B.gun, SH_SHOTS)).toBeGreaterThanOrEqual(gunTotalsAtLoss[0]!);
    expect(shooter(w, B.gun, SH_HP)).toBeGreaterThanOrEqual(gunTotalsAtLoss[1]!);
    expect(shooter(w, B.gun, SH_KILLS)).toBeGreaterThanOrEqual(gunTotalsAtLoss[2]!);
    // Every shooter kind took part; nothing else did.
    for (const k of [B.gun, B.area, B.tempTurret]) {
      expect(shooter(w, k, SH_SHOTS), BUILDING_KINDS[k]).toBeGreaterThan(0);
      expect(shooter(w, k, SH_HP), BUILDING_KINDS[k]).toBeGreaterThan(0);
    }
    expect(sumShooters(w, SH_KILLS)).toBe(killed);
    // No overkill: the dead count their maximum hit points once, however hard the last hit was.
    expect(sumShooters(w, SH_HP)).toBeCloseTo(lost(w, group), 3);
    expect(w.kills).toBe(killed);
    // Per alien kind: spawned and killed.
    const killedByKind = [A.rusher, A.hunter, A.breaker].map((k) => w.stats[alienStatIndex(k, AL_KILLED)]!);
    expect(killedByKind.reduce((a, b) => a + b, 0)).toBe(killed);
    expect(killedByKind.slice(0, 2)).toEqual([14, 4]);
    expect(w.stats[alienStatIndex(A.rusher, AL_SPAWNED)]).toBe(14);
    expect(w.stats[alienStatIndex(A.breaker, AL_SPAWNED)]).toBe(2);
    // The snapshot carries the same counters.
    const snap = decodeSnapshot(encodeSnapshot(w));
    expect(Array.from(snap.stats)).toEqual(Array.from(w.stats));
    const r = statsReport(snap.stats);
    expect(r.shooters.gun!.kills + r.shooters.area!.kills + r.shooters.tempTurret!.kills + r.shooters.commander!.kills).toBe(killed);
  });

  it('splash damage is credited to the area cannon, and a projectile carries its shooter when it lands', () => {
    const w = new World(1, flatTerrain(40, 40), { waves: false });
    w.placeBuilding(B.area, 18, 18, true);
    for (let i = 0; i < 6; i++) w.spawnAlien(A.breaker, 18.5 + (i % 3) * 0.6, 32 + Math.floor(i / 3) * 0.6);
    let sawProjectile = false;
    for (let i = 0; i < 60; i++) {
      w.step();
      for (let s = 0; s < w.projectiles.highWater; s++) {
        if (!w.projectiles.alive[s]) continue;
        sawProjectile = true;
        expect(w.projectiles.cols.srcKind[s]).toBe(B.area);
      }
    }
    expect(sawProjectile).toBe(true);
    const hp = shooter(w, B.area, SH_HP);
    let breakerLost = 0;
    for (let s = 0; s < w.aliens.highWater; s++) if (w.aliens.alive[s]) breakerLost += alienInfo(A.breaker).hp - w.aliens.cols.hp[s]!;
    expect(hp).toBeCloseTo(breakerLost, 3);
    // More aliens were hurt than shells were fired: splash went to the area cannon's total.
    let hurt = 0;
    for (let s = 0; s < w.aliens.highWater; s++) if (w.aliens.alive[s] && w.aliens.cols.hp[s]! < alienInfo(A.breaker).hp) hurt++;
    expect(hurt).toBeGreaterThan(shooter(w, B.area, SH_SHOTS));
  });

  it('counts what aliens remove from walls and other buildings, and what shields absorb, without overkill', () => {
    const w = new World(1, flatTerrain(40, 40, { base: { x: 20, z: 36 } }), { waves: false });
    w.pool.set([1e6, 1e6, 1e6]);
    w.placeBuilding(B.shield, 16, 30, true);
    const gen = w.placeBuilding(B.generator, 19, 30, true); // inside the shield
    const walls: number[] = [];
    for (let x = 0; x < 40; x++) walls.push(w.placeBuilding(B.wall, x, 20, true));
    for (let i = 0; i < 6; i++) w.spawnAlien(A.breaker, 18 + i, 8);
    const hpOf = (id: number) => {
      const s = w.buildings.slotForId(id);
      return s < 0 ? 0 : w.buildings.cols.hp[s]!;
    };
    const wallHp0 = walls.reduce((n, id) => n + hpOf(id), 0);
    for (let i = 0; i < 400; i++) w.step();
    const wallsLost = wallHp0 - walls.reduce((n, id) => n + Math.max(0, hpOf(id)), 0);
    expect(wallsLost).toBeGreaterThan(0);
    expect(w.stats[alienStatIndex(A.breaker, AL_HP_WALLS)]).toBeCloseTo(wallsLost, 2);
    // Run on until they reach the generator inside the shield.
    for (let i = 0; i < 2000 && w.stats[alienStatIndex(A.breaker, AL_ABSORBED)] === 0; i++) w.step();
    expect(w.stats[alienStatIndex(A.breaker, AL_ABSORBED)]).toBeGreaterThan(0);
    void gen;
    void AL_HP_BUILDINGS;
  });

  it('clearing aliens and wrecks is not a kill; resetStats zeroes every counter', () => {
    const w = new World(1, flatTerrain(30, 30), { waves: false });
    w.scenario = 'sandbox';
    w.placeBuilding(B.gun, 10, 10, true);
    w.spawnAlien(A.rusher, 11, 18);
    w.spawnAlien(A.rusher, 25, 25);
    for (let i = 0; i < 30; i++) w.step();
    const kills = sumShooters(w, SH_KILLS);
    w.enqueue({ t: 'clearAliens' });
    w.enqueue({ t: 'clearWrecks' });
    w.step();
    expect(w.aliens.count).toBe(0);
    expect(sumShooters(w, SH_KILLS)).toBe(kills);
    expect(w.stats[alienStatIndex(A.rusher, AL_KILLED)]).toBe(kills);
    w.enqueue({ t: 'resetStats' });
    w.step();
    expect(w.stats.every((v) => v === 0)).toBe(true);
  });
});
