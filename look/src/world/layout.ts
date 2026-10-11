// The vista's content, placed on map 1's real layout: base centre, deposits, entries and rock
// outcrops come from game/src/sim/terrain.ts (read-only import); footprints from kinds.ts.
// Positions are tiles (1 tile = 2 m), world x = tile x, world z = tile y.

import { BUILDING_INFO, type AlienKind, type BuildingKind } from '../../../game/src/sim/kinds.ts';
import { map1Terrain, TILE_ROCK, type Terrain } from '../../../game/src/sim/terrain.ts';

export type { AlienKind, BuildingKind };
export const terrain: Terrain = map1Terrain();
export const BASE = terrain.base;

export interface Placed {
  kind: BuildingKind;
  /** Upgrade tier (walls 1-3, turrets 1-2). Tier 3 walls are drawn as wall towers. */
  tier?: number;
  /** Footprint origin tile. */
  tx: number;
  ty: number;
  /** Facing, radians about +Y (0 = model +X). */
  rot: number;
  /** Turret aim, radians about +Y. */
  aim?: number;
}

export const sizeOf = (k: BuildingKind) => BUILDING_INFO[k].size;
export const centreOf = (p: Placed) => ({ x: p.tx + sizeOf(p.kind) / 2, z: p.ty + sizeOf(p.kind) / 2 });

const N = Math.PI / 2; // yaw that turns model +X to north (-z)
const E = 0;

const B: Placed[] = [];
const add = (kind: BuildingKind, tx: number, ty: number, rot = 0, tier = 1) => B.push({ kind, tx, ty, rot, tier });

// Economy: extractors on six of the eight mass deposits; two left bare to show the ore.
const BARE_MASS = new Set(['36,40', '92,84']);
for (const d of terrain.deposits) {
  if (d.kind === 'mass' && !BARE_MASS.has(`${d.tx},${d.ty}`)) add('massExtractor', d.tx, d.ty, (d.tx * 7 + d.ty) % 4 * (Math.PI / 2));
  if (d.kind === 'rare' && d.approach === 'east') add('rareExtractor', d.tx, d.ty);
}
for (const [x, y] of [[57, 66], [60, 66], [57, 69], [60, 69], [64, 70], [67, 70], [64, 73], [67, 73]] as const) add('generator', x, y);
add('lab', 52, 56);
add('lab', 46, 68);
add('lab', 75, 72);

// Salvage chain along row 82: depot → shredder → smelter → assembler, belts between.
add('depot', 56, 82);
add('shredder', 60, 82, E);
add('smelter', 64, 82, E);
add('assembler', 68, 82, E);
for (const x of [58, 59, 62, 63, 66, 67, 70, 71]) add('belt', x, 82, E);

// Walls: a north line, a diagonal shoulder and an east line, with turrets behind.
for (let x = 52; x <= 77; x++) add('wall', x, 40, 0, (x - 52) % 6 === 0 ? 3 : 1);
for (let i = 0; i <= 10; i++) {
  add('wall', 78 + i, 40 + i, -Math.PI / 4);
  if (i < 10) add('wall', 79 + i, 40 + i, -Math.PI / 4);
}
for (let y = 51; y <= 78; y++) add('wall', 88, y, Math.PI / 2, (y - 51) % 6 === 3 ? 3 : 1);
for (const x of [53, 59, 65, 68, 74]) add('gun', x, 42, N);
for (const y of [52, 58, 68, 74]) add('gun', 85, y, E);
add('area', 57, 46, N);
add('area', 71, 45, N);
add('area', 81, 54, E);
add('area', 81, 70, E);
add('area', 68, 50, N);
add('beam', 63, 43, N);
add('beam', 85, 63, E);
add('heavy', 62, 47, N);
add('heavy', 80, 64, E);
add('shield', 73, 54);

export const buildings: Placed[] = B;

export interface UnitPlaced {
  kind: 'commander' | 'engineer';
  x: number;
  z: number;
  rot: number;
}
export const units: UnitPlaced[] = [
  { kind: 'commander', x: 68, z: 59, rot: -Math.PI / 4 },
  { kind: 'engineer', x: 62.5, z: 59, rot: 0.4 },
  { kind: 'engineer', x: 70, z: 51.5, rot: -1.2 },
  { kind: 'engineer', x: 77, z: 61.5, rot: 2.1 },
  { kind: 'engineer', x: 61, z: 79, rot: -0.3 },
];

/** Energy conduits: polylines (tiles) from the generator block to the defences. */
export const conduits: Array<Array<[number, number]>> = [
  [[59.5, 65.8], [59.5, 51], [63.5, 51], [63.5, 50.1]],
  [[62.2, 66.5], [66, 66.5], [66, 56.5], [73.5, 56.5], [73.5, 56.1]],
  [[62.2, 67.5], [79.9, 67.5], [79.9, 66.2], [80.2, 66.2]],
  [[66, 56.5], [66, 45.6], [64, 45.6], [64, 45.1]],
  [[79.9, 67.5], [84.2, 67.5], [84.2, 64], [84.9, 64]],
  [[56.8, 67.5], [53.5, 67.5], [53.5, 59.1]],
];

/** Rock outcrops of map 1 (connected rock tiles): centre and equivalent radius, in tiles. */
export const outcrops: Array<{ x: number; z: number; r: number }> = (() => {
  const t = terrain;
  const seen = new Uint8Array(t.w * t.h);
  const out: Array<{ x: number; z: number; r: number }> = [];
  for (let i = 0; i < t.w * t.h; i++) {
    if (seen[i] || t.tiles[i] !== TILE_ROCK) continue;
    const stack = [i];
    seen[i] = 1;
    let sx = 0;
    let sz = 0;
    let n = 0;
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % t.w;
      const z = (j / t.w) | 0;
      sx += x + 0.5;
      sz += z + 0.5;
      n++;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const xx = x + dx;
        const zz = z + dz;
        if (xx < 0 || zz < 0 || xx >= t.w || zz >= t.h) continue;
        const k = zz * t.w + xx;
        if (!seen[k] && t.tiles[k] === TILE_ROCK) {
          seen[k] = 1;
          stack.push(k);
        }
      }
    }
    out.push({ x: sx / n, z: sz / n, r: Math.sqrt(n / Math.PI) });
  }
  return out;
})();

/** Footprint overlap check: throws in dev if two buildings share a tile. */
(() => {
  const used = new Map<string, string>();
  for (const b of B) {
    const s = sizeOf(b.kind);
    for (let j = 0; j < s; j++)
      for (let i = 0; i < s; i++) {
        const key = `${b.tx + i},${b.ty + j}`;
        if (used.has(key)) throw new Error(`layout: ${b.kind} at ${b.tx},${b.ty} overlaps ${used.get(key)} at tile ${key}`);
        used.set(key, `${b.kind}@${b.tx},${b.ty}`);
      }
  }
})();

export const DEG = Math.PI / 180;
