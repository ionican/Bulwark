// W25b fixtures: Richard's freeze sequence (w25b-freeze.test.ts, w25b-starvation.test.ts).

import { expect } from 'vitest';
import { createWorld } from '../src/sim/scenarios.ts';
import { B, U } from '../src/sim/kinds.ts';
import { BF_COMPLETE, BF_STARTED } from '../src/sim/schema.ts';
import type { Command } from '../src/sim/commands.ts';
import type { World } from '../src/sim/world.ts';

/** Richard's sequence on the sandbox start: three runs and a gun, all four given to all three builders. */
export function richardsSequence(unlimited: boolean) {
  const w = createWorld(1, 'sandbox');
  w.unlimited = unlimited;
  const ids: number[] = [];
  for (let s = 0; s < w.units.highWater; s++) if (w.units.alive[s]) ids.push(w.units.id(s));
  expect(ids.map((id) => w.units.cols.kind[w.units.slotForId(id)])).toEqual([U.commander, U.engineer, U.engineer]);
  const cmds: Command[] = [
    { t: 'buildRun', ids, from: [58, 60], to: [70, 60], depth: 1 }, // the wall drag (13 tiles)
    { t: 'buildRun', ids, from: [58, 60], to: [52, 60], depth: 1, queue: true }, // Shift: west from its west end
    { t: 'buildRun', ids, from: [70, 60], to: [70, 69], depth: 1, queue: true }, // Shift: south from its east end
    { t: 'build', ids, kind: B.gun, tx: 70, ty: 70, queue: true }, // Shift: a gun at the south end
  ];
  for (const c of cmds) {
    expect(w.submit(c)).toBeNull();
    w.step();
  }
  expect(w.applyRejected).toEqual([]);
  return { w, ids };
}

const site = (w: World, s: number) => ({ id: w.buildings.id(s), flags: w.buildings.cols.flags[s]!, progress: w.buildings.cols.progress[s]! });
export function sites(w: World) {
  const out = [];
  for (let s = 0; s < w.buildings.highWater; s++) if (w.buildings.alive[s]) out.push(site(w, s));
  return out;
}
/** Sites with build power on them now (started, not complete). */
export const inProgress = (w: World) => sites(w).filter((b) => b.flags & BF_STARTED && !(b.flags & BF_COMPLETE));
export const queuesEmpty = (w: World, ids: number[]) => ids.every((id) => w.orders[w.units.slotForId(id)]!.length === 0);

