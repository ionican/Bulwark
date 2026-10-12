// W31 test fixtures: straight belt lines of chosen speeds (tiers) into a core, on a flat world with
// the belt economy on. Belts are placed complete and their tier column set directly, so a fixture
// needs no research and no builders.
//
//   row z = ROW: belt tiles x = X0 .. X0 + n − 1 (facing +x), the core's west face at x = X0 + n.

import { World } from '../src/sim/world.ts';
import { B, ITEM_MASS, ITEM_NONE } from '../src/sim/kinds.ts';
import { RESEARCH_INDEX } from '../src/sim/balance.ts';
import { flatWorld } from './fixtures.ts';

export const ROW = 20;
export const X0 = 4;

export interface Line {
  w: World;
  /** Building ids of the belt tiles, upstream first. */
  belts: number[];
  core: number;
}

/** Sets building `id`'s tier column (a complete belt's speed: 1 Slow, 2 Medium, 3 Fast). */
export function setTier(w: World, id: number, tier: number): void {
  w.buildings.cols.tier[w.buildings.slotForId(id)] = tier;
}

/** A straight line with tile k at tiers[k], into a core; `fill`: an item at the start of every tile. */
export function line(tiers: number[], opts: { fill?: boolean; mapW?: number } = {}): Line {
  const n = tiers.length;
  const w = flatWorld(opts.mapW ?? Math.max(40, X0 + n + 8), 40, { belts: true });
  const core = w.placeBuilding(B.core, X0 + n, ROW - 1, true);
  const belts: number[] = [];
  tiers.forEach((t, k) => {
    const id = w.placeBuilding(B.belt, X0 + k, ROW, true, 0);
    setTier(w, id, t);
    belts.push(id);
  });
  if (opts.fill) for (const id of belts) putItem(w, id, ITEM_MASS);
  return { w, belts, core };
}

/** An item on belt `id` at the start of its tile, entered this tick (it advances from the next). */
export function putItem(w: World, id: number, item = ITEM_MASS): void {
  const s = w.buildings.slotForId(id);
  const c = w.buildings.cols;
  c.item[s] = item;
  c.itemPos[s] = 0;
  c.moved[s] = w.tick;
}

/** Items on the given belt ids. */
export function itemsOn(w: World, ids: number[]): number {
  const c = w.buildings.cols;
  return ids.reduce((n, id) => n + (c.item[w.buildings.slotForId(id)] !== ITEM_NONE ? 1 : 0), 0);
}

/** Steps `n` ticks and returns the ticks (the tick number executed) on which the core took mass. */
export function deliveries(w: World, n: number, each?: () => void): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    each?.();
    const before = w.delivered[0]!;
    const tick = w.tick;
    w.step();
    for (let k = before; k < w.delivered[0]!; k++) out.push(tick);
  }
  return out;
}

export const gaps = (ticks: number[]): number[] => ticks.slice(1).map((t, i) => t - ticks[i]!);

/**
 * Marks research node `id` done (as a station finishing it). A node this build does not have is left
 * alone, so a test runs on to its own assertions (w31-saves test 10 asserts the belt nodes exist).
 */
export function research(w: World, id: string): void {
  const i = RESEARCH_INDEX[id];
  if (i !== undefined) w.completeResearch(i);
}
