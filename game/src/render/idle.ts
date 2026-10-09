// W26: the idle units column's data, from the snapshot. A unit is idle when it is a commander or
// an engineer, its state is US_IDLE, and it has no orders queued in the snapshot's queue section.
// US_WAITING (waiting for resources), moving, building and reclaiming units are not idle, nor is an
// idle-state unit with a queued order. Ids are listed in id order: the column's click cycle.

import { U } from '../sim/kinds.ts';
import { US_IDLE } from '../sim/schema.ts';
import type { Snapshot } from '../sim/snapshot.ts';

export interface IdleUnits {
  commander: number[];
  engineer: number[];
}

/** The idle commanders and engineers of snapshot `s`, each list in id order. */
export function idleUnits(s: Snapshot): IdleUnits {
  const out: IdleUnits = { commander: [], engineer: [] };
  const c = s.units.cols;
  for (let r = 0; r < s.units.count; r++) {
    if (c.state[r] !== US_IDLE || s.queues.count[r] !== 0) continue;
    const k = c.kind[r];
    if (k === U.commander) out.commander.push(s.units.id[r]!);
    else if (k === U.engineer) out.engineer.push(s.units.id[r]!);
  }
  out.commander.sort((a, b) => a - b);
  out.engineer.sort((a, b) => a - b);
  return out;
}

/**
 * The next idle unit for a click: the first id after `last` (the unit the previous click went to),
 * wrapping round to the first. If `last` has gone busy it is not in the list, and the next id after
 * it is still the right one. Null when there are none.
 */
export function nextIdle(ids: readonly number[], last: number | null): number | null {
  if (ids.length === 0) return null;
  if (last !== null) for (const id of ids) if (id > last) return id;
  return ids[0]!;
}
