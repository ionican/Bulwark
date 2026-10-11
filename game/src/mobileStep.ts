// W25c: the furthest a unit or alien can walk in one tick, read from a snapshot (its kind's speed
// times the sandbox speed multiplier in the snapshot's tuning section). The interpolator uses it so
// that legitimate fast walking (speed tuning up to 10×, several ticks per snapshot at game speed 3×)
// is not taken for a teleport (render/interp.ts header).
//
// Not under render/: it reads tuning.ts, which render code may not import.

import { alienInfo, unitInfo } from './sim/kinds.ts';
import type { Snapshot } from './sim/snapshot.ts';
import { TA_SPEED, TU_SPEED, tuneIndex } from './sim/tuning.ts';

export function maxStepPerTick(group: 'units' | 'aliens', kind: number, s: Snapshot): number {
  return group === 'units'
    ? unitInfo(kind).speed * (s.tuning.unit[tuneIndex('unit', kind, TU_SPEED)] ?? 1)
    : alienInfo(kind).speed * (s.tuning.alien[tuneIndex('alien', kind, TA_SPEED)] ?? 1);
}
