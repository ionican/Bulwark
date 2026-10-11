// W24 run 3: the simulation's rule functions (sim/tuning.ts accessors such as unitBuildRate and
// turretDamage) read from a snapshot on the main thread, so the panel's tune labels and the D2
// readout's wanted rate use the simulation's own arithmetic rather than a copy of it. Those
// functions read a world's `tuning` and `researched()` only (tuning.ts Rules); this object carries
// the snapshot's tuning block and research mask in that shape.

import { RESEARCH_INDEX } from './sim/balance.ts';
import { G_RESEARCH_DONE } from './sim/schema.ts';
import type { Snapshot } from './sim/snapshot.ts';
import { Tuning, type Rules } from './sim/tuning.ts';

const cache = new WeakMap<Snapshot, Rules>();

/** The snapshot's tuning and research, in the shape the tuning.ts accessors read. Cached per snapshot. */
export function snapshotRules(s: Snapshot): Rules {
  let w = cache.get(s);
  if (w) return w;
  const tuning = new Tuning();
  tuning.building.set(s.tuning.building);
  tuning.alien.set(s.tuning.alien);
  tuning.unit.set(s.tuning.unit);
  const done = s.globals[G_RESEARCH_DONE] ?? 0;
  const researched = (id: string) => {
    const i = RESEARCH_INDEX[id];
    return i !== undefined && (done & (1 << i)) !== 0;
  };
  w = { tuning, researched };
  cache.set(s, w);
  return w;
}

/** True when two snapshots carry the same tuning and research (the rule figures are the same). */
export function sameRules(a: Snapshot, b: Snapshot): boolean {
  if ((a.globals[G_RESEARCH_DONE] ?? 0) !== (b.globals[G_RESEARCH_DONE] ?? 0)) return false;
  for (const k of ['building', 'alien', 'unit'] as const) {
    const x = a.tuning[k];
    const y = b.tuning[k];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}
