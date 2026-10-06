// Map 1 terrain, generated from code. The map is hand-designed and fixed: it does not depend on the
// game seed, so the worker and the render thread each build the same terrain from this function.
// Pure integer hashing and polynomial smoothing only — no Math.sin/cos/exp — so it is bit-identical
// in every JS engine.

import { map1 } from '../../../model/data/map1.ts';
import { Rng, hash2 } from './rng.ts';

export const MAP_W = 128;
export const MAP_H = 128;

export const TILE_GROUND = 0;
export const TILE_ROCK = 1;
export const TILE_MASS = 2;
export const TILE_RARE = 3;

export interface Point {
  x: number;
  z: number;
}

export interface Deposit {
  /** Footprint origin tile (2 × 2 footprint). */
  tx: number;
  ty: number;
  kind: 'mass' | 'rare';
  /** Rare points: the approach whose aliens contest it. */
  approach?: string;
}

export interface EntryPoint {
  name: string;
  /** World position of the spawn point on the map edge. */
  x: number;
  z: number;
  /** Unit vector pointing into the map. */
  dirX: number;
  dirZ: number;
}

export interface Terrain {
  w: number;
  h: number;
  /** Vertex heights, (w + 1) × (h + 1), row-major by z. World units (tiles). */
  heights: Float32Array;
  /** Tile types, w × h. */
  tiles: Uint8Array;
  deposits: Deposit[];
  entries: EntryPoint[];
  base: Point;
}

const MAP_SEED = 0x6d617031; // "map1": the terrain is part of the map, not the game seed.

// Hand-placed for map 1. Counts must match model/data/map1.ts (checked below).
const MASS_DEPOSITS: Array<[number, number]> = [
  [54, 50], [72, 49], [46, 62], [80, 60], [50, 77], [74, 78], [36, 40], [92, 84],
];
const RARE_POINTS: Array<[number, number, string]> = [
  [55, 26, 'north'], [73, 29, 'north'], [100, 59, 'east'],
];
const ENTRIES: EntryPoint[] = [
  { name: 'north', x: 64, z: 1, dirX: 0, dirZ: 1 },
  { name: 'east', x: 127, z: 64, dirX: -1, dirZ: 0 },
];
const BASE: Point = { x: 64, z: 64 };

if (MASS_DEPOSITS.length !== map1.massDeposits) throw new Error('map 1 mass deposit count differs from W12 model');
for (const [approach, n] of Object.entries(map1.rarePoints)) {
  if (RARE_POINTS.filter((r) => r[2] === approach).length !== n) throw new Error(`map 1 rare points on ${approach} differ from W12 model`);
}
for (const a of map1.approaches) if (!ENTRIES.some((e) => e.name === a)) throw new Error(`map 1 has no entry point for ${a}`);

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Value noise at a lattice spacing of `cell` tiles, in [0, 1). */
function valueNoise(x: number, z: number, cell: number, salt: number): number {
  const gx = x / cell;
  const gz = z / cell;
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const fx = smooth(gx - ix);
  const fz = smooth(gz - iz);
  const a = hash2(ix, iz, salt);
  const b = hash2(ix + 1, iz, salt);
  const c = hash2(ix, iz + 1, salt);
  const d = hash2(ix + 1, iz + 1, salt);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const len2 = vx * vx + vz * vz;
  let t = len2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + t * vx);
  const dz = pz - (az + t * vz);
  return Math.sqrt(dx * dx + dz * dz);
}

let cached: Terrain | null = null;

/** Map 1 terrain. Cached: the result is shared and must be treated as read-only. */
export function map1Terrain(): Terrain {
  if (cached) return cached;
  const w = MAP_W;
  const h = MAP_H;
  const tiles = new Uint8Array(w * h);
  const heights = new Float32Array((w + 1) * (h + 1));

  // Places the rocks must keep clear of: the base, each approach corridor, every deposit.
  const protectedAt = (x: number, z: number): boolean => {
    if (x < 2 || z < 2 || x > w - 3 || z > h - 3) return true;
    const bx = x - BASE.x;
    const bz = z - BASE.z;
    if (bx * bx + bz * bz < 22 * 22) return true;
    for (const e of ENTRIES) if (distToSegment(x, z, e.x, e.z, BASE.x, BASE.z) < 7) return true;
    for (const [dx, dz] of MASS_DEPOSITS) if (Math.abs(x - dx - 1) < 4 && Math.abs(z - dz - 1) < 4) return true;
    for (const [dx, dz] of RARE_POINTS) if (Math.abs(x - dx - 1) < 4 && Math.abs(z - dz - 1) < 4) return true;
    return false;
  };

  // Rock outcrops: blobs of rock tiles from a fixed RNG.
  const rng = new Rng(MAP_SEED);
  for (let i = 0; i < 22; i++) {
    const cx = rng.range(6, w - 6);
    const cz = rng.range(6, h - 6);
    const r = rng.range(1.6, 4.6);
    const r2 = r * r;
    for (let z = Math.floor(cz - r - 1); z <= cz + r + 1; z++) {
      for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
        if (x < 0 || z < 0 || x >= w || z >= h) continue;
        const dx = x + 0.5 - cx;
        const dz = z + 0.5 - cz;
        const wobble = 0.65 + 0.7 * hash2(x, z, 7);
        if (dx * dx + dz * dz <= r2 * wobble && !protectedAt(x + 0.5, z + 0.5)) tiles[z * w + x] = TILE_ROCK;
      }
    }
  }
  for (const [tx, ty] of MASS_DEPOSITS) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) tiles[(ty + j) * w + tx + i] = TILE_MASS;
  for (const [tx, ty] of RARE_POINTS) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) tiles[(ty + j) * w + tx + i] = TILE_RARE;

  // Gentle rolling ground, flattened round the base; rock tiles raise their corner vertices.
  for (let z = 0; z <= h; z++) {
    for (let x = 0; x <= w; x++) {
      let n = valueNoise(x, z, 32, 1) * 2.4 + valueNoise(x, z, 12, 2) * 0.8 + valueNoise(x, z, 5, 3) * 0.2;
      const bx = x - BASE.x;
      const bz = z - BASE.z;
      const d = Math.sqrt(bx * bx + bz * bz);
      const flat = d < 14 ? 0 : d > 30 ? 1 : smooth((d - 14) / 16);
      n = 0.8 + (n - 0.8) * flat;
      let rockN = 0;
      for (let j = -1; j <= 0; j++) for (let i = -1; i <= 0; i++) {
        const tx = x + i;
        const tz = z + j;
        if (tx >= 0 && tz >= 0 && tx < w && tz < h && tiles[tz * w + tx] === TILE_ROCK) rockN++;
      }
      heights[z * (w + 1) + x] = n + rockN * 0.35;
    }
  }

  cached = {
    w,
    h,
    heights,
    tiles,
    deposits: [
      ...MASS_DEPOSITS.map(([tx, ty]) => ({ tx, ty, kind: 'mass' as const })),
      ...RARE_POINTS.map(([tx, ty, approach]) => ({ tx, ty, kind: 'rare' as const, approach })),
    ],
    entries: ENTRIES,
    base: BASE,
  };
  return cached;
}

/** Bilinear ground height at a world position (tiles), clamped to the map. */
export function heightAt(t: Terrain, x: number, z: number): number {
  const cx = x < 0 ? 0 : x > t.w ? t.w : x;
  const cz = z < 0 ? 0 : z > t.h ? t.h : z;
  let ix = Math.floor(cx);
  let iz = Math.floor(cz);
  if (ix >= t.w) ix = t.w - 1;
  if (iz >= t.h) iz = t.h - 1;
  const fx = cx - ix;
  const fz = cz - iz;
  const s = t.w + 1;
  const a = t.heights[iz * s + ix]!;
  const b = t.heights[iz * s + ix + 1]!;
  const c = t.heights[(iz + 1) * s + ix]!;
  const d = t.heights[(iz + 1) * s + ix + 1]!;
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

export const tileAt = (t: Terrain, tx: number, ty: number): number =>
  tx < 0 || ty < 0 || tx >= t.w || ty >= t.h ? TILE_ROCK : t.tiles[ty * t.w + tx]!;
