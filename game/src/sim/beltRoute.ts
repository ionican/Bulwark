// W29: belt routes from extractors to the core, worked out on a world's map. Used by the scripted
// map 1 plans (test/plans.ts) and the render checks' delivery fixture (scripts/check-render.mjs);
// the game itself never calls it.
//
// Each route is a breadth-first search over free belt cells, so it is a shortest line in tiles:
//   - it starts on a cell beside the extractor pointing away from it (conveyor.ts output() only
//     puts an item on a belt whose back faces the building);
//   - it ends on a cell pointing into the core, or, when `join` allows, on a cell pointing into an
//     earlier route's tile from behind or the side (a belt never takes from the tile it faces),
//     provided the line from there to the core can move every extractor on it at full output
//     (boosted mass), so a joined line does not back up into idle extractors;
//   - it keeps off the cells beside a depot or a salvage machine, which would put salvage, scrap,
//     alloy or parts on the line, and the core refuses those, which stops the line.
// Routes are planned in the order given and each one keeps off the tiles of the earlier ones.

import { B, BELT_TILES_PER_SECOND, TICK_SECONDS, buildingInfo } from './kinds.ts';
import { EXTRACTOR_BOOST } from './balance.ts';
import type { World } from './world.ts';

/** One belt tile: x, z and the direction it carries (0 +x, 1 +z, 2 −x, 3 −z). */
export type BeltTile = [number, number, number];

const DX = [1, 0, -1, 0];
const DZ = [0, 1, 0, -1];
/** Items a belt line moves per second: an item crosses a tile in whole ticks (conveyor.ts). */
const LINE_CAPACITY = 1 / (Math.ceil(1 / (BELT_TILES_PER_SECOND * TICK_SECONDS) - 1e-9) * TICK_SECONDS);
/** An extractor's output at its best (mass with the extractors research). */
const peakRate = (kind: number) => (kind === B.massExtractor ? buildingInfo(kind).income![0] * EXTRACTOR_BOOST : buildingInfo(kind).income![2]);

export interface RouteOptions {
  /** Buildings still to be built, as [kind, tx, ty]: routes keep off their footprints (and off the cells beside chain buildings). */
  planned?: Array<[number, number, number]>;
  /**
   * 'fallback' (the default): a route runs into the core when it can and joins an earlier route
   * only when it cannot. 'nearest': whichever end is nearer, which lays fewer tiles.
   */
  join?: 'fallback' | 'nearest';
}

/** For each extractor [kind, tx, ty], its belt tiles from the extractor to the core, or null when no route exists. */
export function beltRoutesToCore(w: World, extractors: Array<[number, number, number]>, opts: RouteOptions = {}): Array<BeltTile[] | null> {
  const core = w.buildings.slotForId(w.coreId);
  if (core < 0) throw new Error('beltRoutesToCore: the world has no core');
  const W = w.terrain.w;
  const H = w.terrain.h;
  const c = w.buildings.cols;
  const cx0 = c.tx[core]!;
  const cz0 = c.ty[core]!;
  const cx1 = cx0 + c.fw[core]!;
  const cz1 = cz0 + c.fh[core]!;
  const inCore = (x: number, z: number) => x >= cx0 && x < cx1 && z >= cz0 && z < cz1;

  const blocked = new Uint8Array(W * H);
  const block = (x: number, z: number) => {
    if (x >= 0 && z >= 0 && x < W && z < H) blocked[z * W + x] = 1;
  };
  const footprint = (kind: number, tx: number, ty: number, fw: number, fh: number) => {
    const ring = buildingInfo(kind).role === 'chain';
    for (let j = ring ? -1 : 0; j < fh + (ring ? 1 : 0); j++) for (let i = ring ? -1 : 0; i < fw + (ring ? 1 : 0); i++) block(tx + i, ty + j);
  };
  for (let s = 0; s < w.buildings.highWater; s++) if (w.buildings.alive[s] && buildingInfo(c.kind[s]!).role === 'chain') footprint(c.kind[s]!, c.tx[s]!, c.ty[s]!, c.fw[s]!, c.fh[s]!);
  for (const [kind, tx, ty] of opts.planned ?? []) {
    const { fw, fh } = buildingInfo(kind);
    footprint(kind, tx, ty, fw, fh);
  }
  for (const [kind, tx, ty] of extractors) {
    const { fw, fh } = buildingInfo(kind);
    footprint(kind, tx, ty, fw, fh);
  }

  /** Direction of each tile laid by an earlier route (-1: none), and the items per second it carries. */
  const laid = new Int8Array(W * H).fill(-1);
  const load = new Float64Array(W * H);
  /** Every laid tile from (x, z) to the core. */
  const downstream = (x: number, z: number): number[] => {
    const out: number[] = [];
    while (x >= 0 && z >= 0 && x < W && z < H && laid[z * W + x] !== -1) {
      const i = z * W + x;
      out.push(i);
      x += DX[laid[i]!]!;
      z += DZ[laid[i]!]!;
    }
    return out;
  };
  let rate = 0; // the extractor being routed
  const free = (x: number, z: number) => x >= 0 && z >= 0 && x < W && z < H && !blocked[z * W + x] && laid[z * W + x] === -1 && w.canPlace(B.belt, x, z);

  const parent = new Int32Array(W * H);
  const step = new Int8Array(W * H); // direction from the parent into this cell
  const seen = new Uint8Array(W * H);

  /** Shortest route from extractor (kind, tx, ty); `joining`: an earlier route's tile is an end. */
  const search = (kind: number, tx: number, ty: number, joining: boolean): BeltTile[] | null => {
    seen.fill(0);
    const { fw, fh } = buildingInfo(kind);
    const queue: number[] = [];
    /** The direction a source cell must carry (it points away from the extractor). */
    const forced = new Map<number, number>();
    const ring: BeltTile[] = [];
    for (let k = 0; k < fh; k++) ring.push([tx + fw, ty + k, 0], [tx - 1, ty + k, 2]);
    for (let k = 0; k < fw; k++) ring.push([tx + k, ty + fh, 1], [tx + k, ty - 1, 3]);
    for (const [x, z, d] of ring) {
      if (!free(x, z)) continue;
      const nx = x + DX[d]!;
      const nz = z + DZ[d]!;
      // a source whose forced step leads nowhere stays usable as an ordinary cell
      if (!inCore(nx, nz) && !free(nx, nz) && !(joining && joinable(nx, nz, d))) continue;
      const i = z * W + x;
      seen[i] = 1;
      parent[i] = -1;
      forced.set(i, d);
      queue.push(i);
    }
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h]!;
      const x = i % W;
      const z = (i - x) / W;
      const only = forced.get(i);
      for (let d = 0; d < 4; d++) {
        if (only !== undefined && d !== only) continue;
        const nx = x + DX[d]!;
        const nz = z + DZ[d]!;
        if (inCore(nx, nz) || (joining && joinable(nx, nz, d))) return trace(i, d);
        if (!free(nx, nz)) continue;
        const j = nz * W + nx;
        if (seen[j]) continue;
        seen[j] = 1;
        parent[j] = i;
        step[j] = d;
        queue.push(j);
      }
    }
    return null;
  };
  /** An earlier route's tile at (x, z) takes from a tile carrying direction d into it (behind or the side, not head-on). */
  const joinable = (x: number, z: number, d: number) =>
    x >= 0 && z >= 0 && x < W && z < H && laid[z * W + x] !== -1 && laid[z * W + x] !== (d + 2) % 4 && downstream(x, z).every((i) => load[i]! + rate <= LINE_CAPACITY + 1e-9);
  /** The route ending at cell `last` carrying `d`, from its source. */
  const trace = (last: number, d: number): BeltTile[] => {
    const out: BeltTile[] = [];
    let i = last;
    let dir = d;
    for (;;) {
      const x = i % W;
      out.push([x, (i - x) / W, dir]);
      if (parent[i] === -1) break;
      dir = step[i]!;
      i = parent[i]!;
    }
    return out.reverse();
  };

  return extractors.map(([kind, tx, ty]) => {
    rate = peakRate(kind);
    const route =
      opts.join === 'nearest' ? search(kind, tx, ty, true) : (search(kind, tx, ty, false) ?? search(kind, tx, ty, true));
    if (!route) return null;
    for (const [x, z, d] of route) {
      laid[z * W + x] = d;
      load[z * W + x] = rate;
    }
    const [lx, lz, ld] = route[route.length - 1]!;
    for (const i of downstream(lx + DX[ld]!, lz + DZ[ld]!)) load[i] += rate;
    return route;
  });
}
