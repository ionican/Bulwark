// W32 test fixtures: the demolish command, and readers of the demolish state that return NaN (not a
// TypeError) where the state does not exist, so a test fails on its assertion on a tree without it.

import type { Command } from '../src/sim/commands.ts';
import type { Order } from '../src/sim/units.ts';
import type { World } from '../src/sim/world.ts';
import { BUILDING_INFO, B } from '../src/sim/kinds.ts';
import { gateStats } from '../src/sim/balance.ts';
import { map1 } from '../../model/data/map1.ts';

/** A refusal reason, or '(accepted)' (so a reason test fails as an assertion on an accepted command). */
export const why = (r: string | null) => r ?? '(accepted)';

/** The demolish command: building ids `targets`, in drag order, for units `ids`. */
export const demolish = (ids: number[], targets: number[], queue?: boolean): Command => ({ t: 'demolish', ids, targets, ...(queue !== undefined && { queue }) }) as unknown as Command;

/** Building `id`'s demolish progress (0..1); NaN when it is gone or the column does not exist. */
export function demolishOf(w: World, id: number): number {
  const s = w.buildings.slotForId(id);
  const col = (w.buildings.cols as unknown as Record<string, Float32Array | undefined>).demolish;
  return s < 0 || !col ? NaN : col[s]!;
}

/** Sets building `id`'s demolish progress directly (a test state). */
export function setDemolish(w: World, id: number, v: number): void {
  const col = (w.buildings.cols as unknown as Record<string, Float32Array | undefined>).demolish;
  if (col) col[w.buildings.slotForId(id)] = v;
}

/** Unit `unit`'s orders, copied. */
export const orderList = (w: World, unit: number): Order[] => (w.orders[w.units.slotForId(unit)] ?? []).map((o) => ({ ...o }));

/** The building ids of unit `unit`'s demolish orders, in queue order. */
export const demolishTargets = (w: World, unit: number): number[] =>
  orderList(w, unit)
    .filter((o) => (o.t as string) === 'demolish')
    .map((o) => (o as unknown as { id: number }).id);

/** The world's cumulative demolish refund, [mass, rare] ([NaN, NaN] without the counter). */
export function refundCounter(w: World): [number, number] {
  const r = (w as unknown as { demolishRefund?: Float64Array }).demolishRefund;
  return r ? [r[0]!, r[1]!] : [NaN, NaN];
}

/** Buildings demolished so far (NaN without the counter). */
export const demolishedCount = (w: World): number => (w as unknown as { demolished?: number }).demolished ?? NaN;

export function steps(w: World, n: number): void {
  for (let i = 0; i < n; i++) w.step();
}

/** Steps until `done` holds (at most `max` ticks); returns the ticks taken. */
export function until(w: World, done: () => boolean, max = 3000): number {
  for (let t = 0; t < max; t++) {
    if (done()) return t;
    w.step();
  }
  throw new Error(`not done after ${max} ticks`);
}

/** True when building `id` exists. */
export const alive = (w: World, id: number): boolean => w.buildings.slotForId(id) >= 0;

// ---- costs, from the W12 tables (map1.ts) and balance.ts, not from kinds.ts siteWork -------------

type Cost3 = [number, number, number];
const add = (a: Cost3, b: Cost3): Cost3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const c3 = (c: { mass: number; energy: number; rare: number }): Cost3 => [c.mass, c.energy, c.rare];

/** What a wall at `tier` cost to build (its laid cost plus each upgrade step below it). */
export function wallSpent(tier: number): Cost3 {
  let c = c3(map1.buildings.wall.cost);
  for (let t = 1; t < tier; t++) c = add(c, c3(map1.buildings.wall.tiers![t - 1]!.upgradeCost));
  return c;
}
/** A gun turret at `tier`. */
export function gunSpent(tier: number): Cost3 {
  let c = c3(map1.buildings.gun.cost);
  for (let t = 1; t < tier; t++) c = add(c, c3(map1.buildings.gun.tiers![t - 1]!.upgradeCost));
  return c;
}
/** A belt at `tier` (balance.ts: BELT_COST_MASS laid, then BELT_UPGRADES per step), read off BUILDING_INFO.belt. */
export function beltSpent(tier: number): Cost3 {
  const info = BUILDING_INFO.belt;
  let c: Cost3 = [...info.cost];
  for (let t = 1; t < tier; t++) c = add(c, [...info.tiers![t - 1]!.cost]);
  return c;
}
/** A gate of `tiles` footprint tiles at tier 1 (balance.ts gateStats). */
export const gateSpent = (tiles: number): Cost3 => [...gateStats(tiles).cost];
/** Any other kind's laid cost (W12 table). */
export const laidCost = (kind: keyof typeof map1.buildings): Cost3 => c3(map1.buildings[kind].cost);
/** Half the mass and rare of `spent`, energy 0. */
export const half = (spent: Cost3): Cost3 => [spent[0] / 2, 0, spent[2] / 2];
export { B };
