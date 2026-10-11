// W24 combat statistics: historical per-kind counters in world state, kept when the shooter is
// destroyed or its slot reused (projectiles carry the shooter's kind and id from the moment of
// firing; schema.ts srcType/srcKind/srcId).
//
//   per shooter kind (every building kind, then every unit kind): shots, hit points removed, kills
//   per alien kind: spawned, killed, hit points removed from walls and gates, from other buildings,
//                   from units, and damage absorbed by shields
//
// Hit points removed count only what the target actually lost (no overkill). Splash damage is
// credited to the shooter's kind. A kill is credited to the hit that removed the last hit point.
// Clearing aliens or wrecks (sandbox) is not a kill. resetStats zeroes every counter.
// The whole array is in every snapshot (snapshot.ts), STAT_COUNT f64 values.

import { ALIEN_KINDS, BUILDING_KINDS, UNIT_KINDS } from './kinds.ts';
import { T_ALIEN, T_BUILDING, T_UNIT } from './schema.ts';
import type { World } from './world.ts';

export const SHOOTER_KINDS = BUILDING_KINDS.length + UNIT_KINDS.length;
export const SH_SHOTS = 0;
export const SH_HP = 1;
export const SH_KILLS = 2;
export const SHOOTER_FIELDS = 3;

export const AL_SPAWNED = 0;
export const AL_KILLED = 1;
export const AL_HP_WALLS = 2;
export const AL_HP_BUILDINGS = 3;
export const AL_HP_UNITS = 4;
export const AL_ABSORBED = 5;
export const ALIEN_FIELDS_STATS = 6;

const ALIEN_BASE = SHOOTER_KINDS * SHOOTER_FIELDS;
export const STAT_COUNT = ALIEN_BASE + ALIEN_KINDS.length * ALIEN_FIELDS_STATS;

/** Row of a shooter (T_BUILDING kind or T_UNIT kind) in the shooter block, or -1. */
export function shooterRow(type: number, kind: number): number {
  if (type === T_BUILDING) return kind;
  if (type === T_UNIT) return BUILDING_KINDS.length + kind;
  return -1;
}

export const shooterIndex = (row: number, field: number): number => row * SHOOTER_FIELDS + field;
export const alienStatIndex = (kind: number, field: number): number => ALIEN_BASE + kind * ALIEN_FIELDS_STATS + field;

function add(w: World, i: number, v: number) {
  w.stats[i] = w.stats[i]! + v;
}

export function recordShot(w: World, type: number, kind: number): void {
  const row = shooterRow(type, kind);
  if (row >= 0) add(w, shooterIndex(row, SH_SHOTS), 1);
}

/** A hit on an alien by a building or unit: `removed` hit points actually lost, and whether it killed. */
export function recordHitOnAlien(w: World, type: number, kind: number, removed: number, killed: boolean): void {
  const row = shooterRow(type, kind);
  if (row < 0) return;
  add(w, shooterIndex(row, SH_HP), removed);
  if (killed) add(w, shooterIndex(row, SH_KILLS), 1);
}

/** Damage an alien's shot did: to a wall or gate (`wall`), another building, or a unit. */
export function recordAlienDamage(w: World, type: number, alienKind: number, target: 'wall' | 'building' | 'unit', removed: number): void {
  if (type !== T_ALIEN) return;
  add(w, alienStatIndex(alienKind, target === 'wall' ? AL_HP_WALLS : target === 'building' ? AL_HP_BUILDINGS : AL_HP_UNITS), removed);
}

export function recordAbsorbed(w: World, type: number, alienKind: number, amount: number): void {
  if (type === T_ALIEN && amount > 0) add(w, alienStatIndex(alienKind, AL_ABSORBED), amount);
}

export const recordSpawned = (w: World, kind: number) => add(w, alienStatIndex(kind, AL_SPAWNED), 1);
export const recordKilled = (w: World, kind: number) => add(w, alienStatIndex(kind, AL_KILLED), 1);

/** How many building, unit and alien kinds a stats array was laid out for (a save records it). */
export interface KindCounts {
  buildings: number;
  units: number;
  aliens: number;
}

export const KIND_COUNTS: KindCounts = { buildings: BUILDING_KINDS.length, units: UNIT_KINDS.length, aliens: ALIEN_KINDS.length };

/**
 * W29: an older stats array (from a save) laid out for `kinds`, in today's layout. Kinds are only
 * ever appended, and appending a building kind moves every unit row and the whole alien block, so
 * each row is copied to its kind's new place; the new kinds' rows are zero.
 */
export function statsFromOlderKinds(old: ArrayLike<number>, kinds: KindCounts): Float64Array {
  const shooters = kinds.buildings + kinds.units;
  const want = shooters * SHOOTER_FIELDS + kinds.aliens * ALIEN_FIELDS_STATS;
  if (old.length !== want) throw new Error(`stats of ${old.length} values, expected ${want} for ${JSON.stringify(kinds)}`);
  if (kinds.buildings > BUILDING_KINDS.length || kinds.units > UNIT_KINDS.length || kinds.aliens > ALIEN_KINDS.length)
    throw new Error(`stats laid out for more kinds than this build has: ${JSON.stringify(kinds)}`);
  const out = new Float64Array(STAT_COUNT);
  for (let row = 0; row < shooters; row++) {
    const to = row < kinds.buildings ? row : BUILDING_KINDS.length + (row - kinds.buildings);
    for (let f = 0; f < SHOOTER_FIELDS; f++) out[shooterIndex(to, f)] = old[row * SHOOTER_FIELDS + f]!;
  }
  const from = shooters * SHOOTER_FIELDS;
  for (let i = 0; i < kinds.aliens * ALIEN_FIELDS_STATS; i++) out[ALIEN_BASE + i] = old[from + i]!;
  return out;
}

/** The counters as named records (debug hook, tests). Works on a world's array or a snapshot's. */
export function statsReport(stats: ArrayLike<number>) {
  const shooters: Record<string, { shots: number; hpRemoved: number; kills: number }> = {};
  const names = [...BUILDING_KINDS, ...UNIT_KINDS];
  names.forEach((name, row) => {
    shooters[name] = {
      shots: stats[shooterIndex(row, SH_SHOTS)]!,
      hpRemoved: stats[shooterIndex(row, SH_HP)]!,
      kills: stats[shooterIndex(row, SH_KILLS)]!,
    };
  });
  const aliens: Record<string, { spawned: number; killed: number; hpFromWalls: number; hpFromBuildings: number; hpFromUnits: number; absorbedByShields: number }> = {};
  ALIEN_KINDS.forEach((name, k) => {
    aliens[name] = {
      spawned: stats[alienStatIndex(k, AL_SPAWNED)]!,
      killed: stats[alienStatIndex(k, AL_KILLED)]!,
      hpFromWalls: stats[alienStatIndex(k, AL_HP_WALLS)]!,
      hpFromBuildings: stats[alienStatIndex(k, AL_HP_BUILDINGS)]!,
      hpFromUnits: stats[alienStatIndex(k, AL_HP_UNITS)]!,
      absorbedByShields: stats[alienStatIndex(k, AL_ABSORBED)]!,
    };
  });
  return { shooters, aliens };
}
