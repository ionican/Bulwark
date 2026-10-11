// Shared test fixtures (W24 simplify pass): the unit-id list and the flat test world that several
// test files had each copied. w24-footprint's W13 reference functions stay in that file on purpose.

import { World } from '../src/sim/world.ts';
import { flatTerrain } from '../src/sim/terrain.ts';

/** Ids of the live player units in slot order, optionally of one kind. */
export function unitIds(w: World, kind?: number): number[] {
  const out: number[] = [];
  for (let s = 0; s < w.units.highWater; s++) if (w.units.alive[s] && (kind === undefined || w.units.cols.kind[s] === kind)) out.push(w.units.id(s));
  return out;
}

/**
 * A w × h flat world with no wave schedule and no units (seed 1). `rich`: 1,000,000 of each
 * resource. `terrain`: rocks, deposits, entries and base for flatTerrain. `belts`: the W29 belt
 * economy (World option, default off).
 */
export function flatWorld(w = 40, h = 40, opts: { rich?: boolean; terrain?: Parameters<typeof flatTerrain>[2]; belts?: boolean } = {}): World {
  const world = new World(1, flatTerrain(w, h, opts.terrain), { waves: false, belts: opts.belts });
  if (opts.rich) world.pool.set([1e6, 1e6, 1e6]);
  return world;
}
