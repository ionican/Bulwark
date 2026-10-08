// W24 sandbox tuning: a multiplier per kind and field, 0.1× to 10× (balance.ts TUNE_MIN/MAX),
// applied on top of tier and research multipliers: effective = base × tier/research × tune.
//
// Supported fields (anything else is refused with a reason):
//   buildings with a weapon  hp, damage, range, interval      other buildings  hp
//   aliens                   hp, dps, speed
//   units (commander, engineer) hp, speed, buildRate
//
// Changing a maximum hit-point multiplier keeps every affected entity's hit-point fraction. Shots
// already in flight keep the damage they were fired with (projectiles store it at firing). A
// building hit-point change marks the cost grids and flow fields for rebuilding, because hit points
// feed the flow cost (world.ts buildingPathCost).

import { ALIEN_KINDS, BUILDING_KINDS, U, UNIT_KINDS, alienInfo, buildingInfo, unitInfo } from './kinds.ts';
import { FIELD_ENG_BUILD_MULT, TUNE_MAX, TUNE_MIN } from './balance.ts';
import type { World } from './world.ts';

export type TuneTarget = 'building' | 'alien' | 'unit';
export const TUNE_TARGETS: readonly TuneTarget[] = ['building', 'alien', 'unit'];

export const TUNE_FIELDS = {
  building: ['hp', 'damage', 'range', 'interval'],
  alien: ['hp', 'dps', 'speed'],
  unit: ['hp', 'speed', 'buildRate'],
} as const satisfies Record<TuneTarget, readonly string[]>;

// Field indices (hot paths read the tables directly).
export const TB_HP = 0;
export const TB_DAMAGE = 1;
export const TB_RANGE = 2;
export const TB_INTERVAL = 3;
export const TA_HP = 0;
export const TA_DPS = 1;
export const TA_SPEED = 2;
export const TU_HP = 0;
export const TU_SPEED = 1;
export const TU_BUILD_RATE = 2;

/** The kinds of each target, in kind-index order (the tables' row order). */
export const TUNE_KINDS: Record<TuneTarget, readonly string[]> = { building: BUILDING_KINDS, alien: ALIEN_KINDS, unit: UNIT_KINDS };

// Row strides: one entry per field.
const SB = TUNE_FIELDS.building.length;
const SA = TUNE_FIELDS.alien.length;
const SU = TUNE_FIELDS.unit.length;
/** Entries per target table, and in all three (the snapshot's tuning block). */
export const TUNE_SIZE: Record<TuneTarget, number> = { building: BUILDING_KINDS.length * SB, alien: ALIEN_KINDS.length * SA, unit: UNIT_KINDS.length * SU };
export const TUNE_COUNT = TUNE_SIZE.building + TUNE_SIZE.alien + TUNE_SIZE.unit;

/** Position of (kind, field) in `target`'s table. */
export const tuneIndex = (target: TuneTarget, kind: number, field: number): number => kind * TUNE_FIELDS[target].length + field;

/** One Float64Array per target: kind × field, every entry 1 at the start. */
export class Tuning {
  readonly building = new Float64Array(TUNE_SIZE.building).fill(1);
  readonly alien = new Float64Array(TUNE_SIZE.alien).fill(1);
  readonly unit = new Float64Array(TUNE_SIZE.unit).fill(1);

  b(kind: number, field: number): number {
    return this.building[kind * SB + field]!;
  }
  a(kind: number, field: number): number {
    return this.alien[kind * SA + field]!;
  }
  u(kind: number, field: number): number {
    return this.unit[kind * SU + field]!;
  }
}

/** Index of `field` for `target`, or -1. */
export function tuneFieldIndex(target: TuneTarget, field: string): number {
  return (TUNE_FIELDS[target] as readonly string[]).indexOf(field);
}

/** Null if (target, kind, field) may be tuned, otherwise why not. */
export function tuneFieldProblem(target: unknown, kind: unknown, field: unknown): string | null {
  if (!TUNE_TARGETS.includes(target as TuneTarget)) return `tune target must be one of ${TUNE_TARGETS.join(', ')}`;
  const t = target as TuneTarget;
  if (typeof kind !== 'number' || !Number.isInteger(kind) || kind < 0 || kind >= TUNE_KINDS[t].length) return `unknown ${t} kind ${JSON.stringify(kind)}`;
  const f = tuneFieldIndex(t, field as string);
  if (f < 0) return `${t}s have no tunable field ${JSON.stringify(field)} (fields: ${TUNE_FIELDS[t].join(', ')})`;
  if (t === 'building') {
    const info = buildingInfo(kind);
    if (f !== TB_HP && !info.weapon) return `${info.label} has no weapon: only hp can be tuned`;
  }
  return null;
}

export function tuneProblem(target: unknown, kind: unknown, field: unknown, mult: unknown): string | null {
  const p = tuneFieldProblem(target, kind, field);
  if (p) return p;
  if (typeof mult !== 'number' || !Number.isFinite(mult) || mult < TUNE_MIN || mult > TUNE_MAX) return `multiplier must be ${TUNE_MIN} to ${TUNE_MAX} (got ${JSON.stringify(mult)})`;
  return null;
}

function table(w: World, target: TuneTarget): Float64Array {
  return w.tuning[target];
}

/**
 * Sets one multiplier. Maximum hit points keep each affected entity's fraction; a building
 * hit-point change dirties the cost grids and flow fields.
 */
export function setTune(w: World, target: TuneTarget, kind: number, field: number, mult: number): void {
  const arr = table(w, target);
  const i = tuneIndex(target, kind, field);
  const old = arr[i]!;
  if (old === mult) return;
  arr[i] = mult;
  if (field !== 0) return; // hp is field 0 for every target
  const ratio = mult / old;
  if (target === 'building') {
    const b = w.buildings;
    const c = b.cols;
    for (let s = 0; s < b.highWater; s++) {
      if (!b.alive[s] || c.kind[s] !== kind) continue;
      c.maxHp[s] = c.maxHp[s]! * ratio;
      c.hp[s] = c.hp[s]! * ratio;
    }
    w.gridsDirty = true;
    w.fieldDirty.fill(1);
  } else if (target === 'alien') {
    const a = w.aliens;
    for (let s = 0; s < a.highWater; s++) if (a.alive[s] && a.cols.kind[s] === kind) a.cols.hp[s] = a.cols.hp[s]! * ratio;
  } else {
    const u = w.units;
    for (let s = 0; s < u.highWater; s++) if (u.alive[s] && u.cols.kind[s] === kind) u.cols.hp[s] = u.cols.hp[s]! * ratio;
  }
}

/** Every multiplier of `target` (or all targets), optionally one kind, back to 1. */
export function resetTune(w: World, target?: TuneTarget, kind?: number): void {
  for (const t of target ? [target] : TUNE_TARGETS) {
    const n = TUNE_FIELDS[t].length;
    for (let k = 0; k < TUNE_KINDS[t].length; k++) {
      if (kind !== undefined && k !== kind) continue;
      for (let f = 0; f < n; f++) setTune(w, t, k, f, 1);
    }
  }
}

// ---- effective values: base × tier/research × tune, one accessor per stat family ----------------
// The simulation reads these; the multiplication order is fixed (floating-point results must not
// move). Run 3's panel shows them.

/** Maximum hit points of a unit kind. */
export const unitMaxHp = (w: World, kind: number): number => unitInfo(kind).hp * w.tuning.u(kind, TU_HP);
/** Unit speed, tiles per tick. */
export const unitSpeed = (w: World, kind: number): number => unitInfo(kind).speed * w.tuning.u(kind, TU_SPEED);
/** Build power: W12 rate, × Field engineering for engineers once researched, × tune. */
export function unitBuildRate(w: World, kind: number): number {
  const info = unitInfo(kind);
  const base = kind === U.engineer && w.researched('fieldEng') ? info.buildRate * FIELD_ENG_BUILD_MULT : info.buildRate;
  return base * w.tuning.u(kind, TU_BUILD_RATE);
}

/** Maximum hit points of an alien kind. */
export const alienMaxHp = (w: World, kind: number): number => alienInfo(kind).hp * w.tuning.a(kind, TA_HP);
/** Alien damage per second. */
export const alienDps = (w: World, kind: number): number => alienInfo(kind).dps * w.tuning.a(kind, TA_DPS);
/** Alien speed, tiles per tick. */
export const alienSpeed = (w: World, kind: number): number => alienInfo(kind).speed * w.tuning.a(kind, TA_SPEED);

/** Raw damage per shot of a turret kind at `tier` (tier 2 multiplies by W12's damageMult). */
export function turretDamage(w: World, kind: number, tier: number): number {
  const info = buildingInfo(kind);
  const tierMult = tier > 1 ? (info.tiers?.[tier - 2]?.damageMult ?? 1) : 1;
  return info.weapon!.damage * tierMult * w.tuning.b(kind, TB_DAMAGE);
}
/** Turret range in tiles. */
export const turretRange = (w: World, kind: number): number => buildingInfo(kind).weapon!.range * w.tuning.b(kind, TB_RANGE);
/** Seconds between a turret's shots. */
export const turretInterval = (w: World, kind: number): number => buildingInfo(kind).weapon!.interval * w.tuning.b(kind, TB_INTERVAL);
