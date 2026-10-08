// Ported from look/src/stress/lod.ts for W24 run 2a (game/src/render/workshop/README: copies, adapted only where noted).
// Detail level per turret by camera distance, with hysteresis. Same rule as the game
// (game/src/render/lod.ts: each object switches on its own distance; going coarser needs
// dist > threshold × (1 + h), going finer needs dist < threshold × (1 − h)), generalised to any
// number of levels. The game's chooseLod treats prev ≥ 3 as "new object", so it cannot be used for
// four levels as it stands.
//
// W21 levels: 0 full (22,640 triangles) → 1 middle (~3,000) → 2 simple (212) → 3 icon (32).
// Thresholds: 24 tiles (full detail only where bolts are at least ~1.5 px), 85 (the whole game
// camera view, whose far corners are ~77 tiles away, stays at middle detail or better), 160 (simple
// until the turret is ~15 px wide; icons beyond).

import { LOD_HYSTERESIS } from '../../lod.ts';

export const LEVEL_NAMES = ['full', 'middle', 'simple', 'icon'] as const;
export type LevelName = (typeof LEVEL_NAMES)[number];
export const LEVELS = 4;
export const STRESS_THRESHOLDS: readonly number[] = [24, 85, 160];
export const HYSTERESIS = LOD_HYSTERESIS;
/** Level value for "no previous level" (a new turret). */
export const LEVEL_NEW = 255;

/** Next level for an object at `prev` (LEVEL_NEW for a new one) at distance `dist`. */
export function chooseLevel(prev: number, dist: number, thresholds: readonly number[] = STRESS_THRESHOLDS, h = HYSTERESIS): number {
  if (prev > thresholds.length) {
    let l = 0;
    while (l < thresholds.length && dist > thresholds[l]!) l++;
    return l;
  }
  let l = prev;
  while (l < thresholds.length && dist > thresholds[l]! * (1 + h)) l++;
  while (l > 0 && dist < thresholds[l - 1]! * (1 - h)) l--;
  return l;
}
