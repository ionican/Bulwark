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

import { ALIEN_KINDS, BUILDING_KINDS, METRES_PER_TILE, TICK_SECONDS, UNIT_KINDS, alienInfo, buildingInfo, unitInfo } from './kinds.ts';
import { TUNE_MAX, TUNE_MIN } from './balance.ts';
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

const kindCount: Record<TuneTarget, number> = { building: BUILDING_KINDS.length, alien: ALIEN_KINDS.length, unit: UNIT_KINDS.length };

/** One Float64Array per target: kind × field, every entry 1 at the start. */
export class Tuning {
  readonly building = new Float64Array(BUILDING_KINDS.length * TUNE_FIELDS.building.length).fill(1);
  readonly alien = new Float64Array(ALIEN_KINDS.length * TUNE_FIELDS.alien.length).fill(1);
  readonly unit = new Float64Array(UNIT_KINDS.length * TUNE_FIELDS.unit.length).fill(1);

  b(kind: number, field: number): number {
    return this.building[kind * 4 + field]!;
  }
  a(kind: number, field: number): number {
    return this.alien[kind * 3 + field]!;
  }
  u(kind: number, field: number): number {
    return this.unit[kind * 3 + field]!;
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
  if (typeof kind !== 'number' || !Number.isInteger(kind) || kind < 0 || kind >= kindCount[t]) return `unknown ${t} kind ${JSON.stringify(kind)}`;
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
  const n = TUNE_FIELDS[target].length;
  const arr = table(w, target);
  const old = arr[kind * n + field]!;
  if (old === mult) return;
  arr[kind * n + field] = mult;
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
    for (let k = 0; k < kindCount[t]; k++) {
      if (kind !== undefined && k !== kind) continue;
      for (let f = 0; f < n; f++) setTune(w, t, k, f, 1);
    }
  }
}

/** Maximum hit points of a unit kind, tuned. */
export const unitMaxHp = (w: World, kind: number): number => unitInfo(kind).hp * w.tuning.u(kind, TU_HP);
/** Maximum hit points of an alien kind, tuned. */
export const alienMaxHp = (w: World, kind: number): number => alienInfo(kind).hp * w.tuning.a(kind, TA_HP);

/**
 * Effective values of one kind in display units, for the panel (run 3) and the debug hook:
 * hit points, damage per shot, range in tiles, seconds between shots, speed in m/s, build power.
 */
export function effectiveValues(w: World, target: TuneTarget, kind: number): Record<string, { mult: number; value: number; unit: string }> {
  const out: Record<string, { mult: number; value: number; unit: string }> = {};
  const fields = TUNE_FIELDS[target] as readonly string[];
  const mults = table(w, target);
  const n = fields.length;
  fields.forEach((f, i) => {
    const mult = mults[kind * n + i]!;
    let value = NaN;
    let unit = '';
    if (target === 'building') {
      const info = buildingInfo(kind);
      if (f === 'hp') [value, unit] = [info.hp * mult, 'hp'];
      else if (info.weapon) {
        if (f === 'damage') [value, unit] = [info.weapon.damage * mult, 'hp per shot'];
        else if (f === 'range') [value, unit] = [info.weapon.range * mult, 'tiles'];
        else [value, unit] = [info.weapon.interval * mult, 's'];
      } else return;
    } else if (target === 'alien') {
      const info = alienInfo(kind);
      if (f === 'hp') [value, unit] = [info.hp * mult, 'hp'];
      else if (f === 'dps') [value, unit] = [info.dps * mult, 'hp/s'];
      else [value, unit] = [(info.speed * mult * METRES_PER_TILE) / TICK_SECONDS, 'm/s'];
    } else {
      const info = unitInfo(kind);
      if (f === 'hp') [value, unit] = [info.hp * mult, 'hp'];
      else if (f === 'speed') [value, unit] = [(info.speed * mult * METRES_PER_TILE) / TICK_SECONDS, 'm/s'];
      else [value, unit] = [info.buildRate * mult, 'BP'];
    }
    out[f] = { mult, value, unit };
  });
  return out;
}
