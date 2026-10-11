// W29 test fixtures: a flat belt world with a core, an extractor on a deposit and a straight belt
// from the extractor's east side into the core's west side, all placed complete.
//
//   row z = ROW: extractor (2 × 2) at x0 .. x0+1, belt tiles x0+2 .. CORE_X-1 (facing +x), core at
//   CORE_X .. CORE_X+2 (rows ROW .. ROW+2). A belt of n tiles puts the extractor at CORE_X - 2 - n.

import { World } from '../src/sim/world.ts';
import { flatTerrain, type Deposit } from '../src/sim/terrain.ts';
import { B, ITEM_NONE, isBelt } from '../src/sim/kinds.ts';

export const ROW = 20;

export interface BeltLine {
  w: World;
  /** Building ids. */
  core: number;
  extractor: number;
  belts: number[];
  /** Core anchor tile x. */
  coreX: number;
}

/**
 * A `belts: true` world (seed 1, no waves, no units) of width `mapW`, with an extractor of `kind`
 * (mass or rare) and a straight belt of `n` tiles into a core. `belt: false` leaves the belt out.
 */
export function beltLine(n: number, opts: { kind?: 'mass' | 'rare'; belt?: boolean; mapW?: number; mapH?: number; belts?: boolean } = {}): BeltLine {
  const kind = opts.kind ?? 'mass';
  const coreX = n + 6;
  const mapW = opts.mapW ?? Math.max(40, coreX + 10);
  const x0 = coreX - 2 - n;
  const deposits: Deposit[] = [{ tx: x0, ty: ROW, kind }];
  const w = new World(1, flatTerrain(mapW, opts.mapH ?? 40, { deposits, base: { x: coreX + 6, z: ROW + 10 } }), { waves: false, belts: opts.belts ?? true });
  const core = w.placeBuilding(B.core, coreX, ROW, true);
  const extractor = w.placeBuilding(kind === 'mass' ? B.massExtractor : B.rareExtractor, x0, ROW, true);
  const belts: number[] = [];
  if (opts.belt !== false) for (let x = x0 + 2; x < coreX; x++) belts.push(w.placeBuilding(B.belt, x, ROW, true, 0));
  return { w, core, extractor, belts, coreX };
}

export const slot = (w: World, id: number) => w.buildings.slotForId(id);

/** Items of `item` kind (any non-empty when omitted) on belt pieces. */
export function itemsOnBelts(w: World, item?: number): number {
  const c = w.buildings.cols;
  let n = 0;
  for (let s = 0; s < w.buildings.highWater; s++) {
    if (!w.buildings.alive[s] || !isBelt(c.kind[s]!) || c.item[s] === ITEM_NONE) continue;
    if (item === undefined || c.item[s] === item) n++;
  }
  return n;
}

export function steps(w: World, n: number): void {
  for (let i = 0; i < n; i++) w.step();
}
