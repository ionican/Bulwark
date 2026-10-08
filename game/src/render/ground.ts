// The one playable ground surface (W24 run 2a). The map mesh is a grid of 128 × 128 tiles, each
// tile split into two triangles along the same diagonal, from (x + 1, z) to (x, z + 1); the
// triangles are (a, c, b) and (b, c, d) with a = (x, z), b = (x + 1, z), c = (x, z + 1),
// d = (x + 1, z + 1). `groundHeight` interpolates those same triangles, so picking, unit and alien
// feet, building bases and icons all sit on the drawn surface. The simulation does not use height.
//
// Pure maths on the terrain's vertex heights: no three.js, so tests and the worker-free render
// code share it.

import type { Terrain } from '../sim/terrain.ts';

/** Height of the drawn ground at a world position (tiles), clamped to the map. */
export function groundHeight(t: Terrain, x: number, z: number): number {
  const cx = x < 0 ? 0 : x > t.w ? t.w : x;
  const cz = z < 0 ? 0 : z > t.h ? t.h : z;
  let ix = Math.floor(cx);
  let iz = Math.floor(cz);
  if (ix >= t.w) ix = t.w - 1;
  if (iz >= t.h) iz = t.h - 1;
  const fx = cx - ix;
  const fz = cz - iz;
  const s = t.w + 1;
  const i = iz * s + ix;
  const h = t.heights;
  if (fx + fz <= 1) {
    const a = h[i]!;
    return a + (h[i + 1]! - a) * fx + (h[i + s]! - a) * fz;
  }
  const d = h[i + s + 1]!;
  return d + (h[i + s]! - d) * (1 - fx) + (h[i + 1]! - d) * (1 - fz);
}

/**
 * Highest and lowest ground under a footprint fw × fh from the anchor tile (tx, ty). The surface
 * is linear on each triangle, so both extremes are at grid vertices. A building stands at `top`
 * (it never sinks into the uphill side) on a plinth down to `bottom` (it never floats).
 */
export function footprintRange(t: Terrain, tx: number, ty: number, fw: number, fh: number): { top: number; bottom: number } {
  let top = -Infinity;
  let bottom = Infinity;
  const s = t.w + 1;
  for (let z = Math.max(0, ty); z <= Math.min(t.h, ty + fh); z++)
    for (let x = Math.max(0, tx); x <= Math.min(t.w, tx + fw); x++) {
      const v = t.heights[z * s + x]!;
      if (v > top) top = v;
      if (v < bottom) bottom = v;
    }
  if (top === -Infinity) top = bottom = groundHeight(t, tx + fw / 2, ty + fh / 2);
  return { top, bottom };
}

/**
 * First point where a ray meets the ground inside the map, or null. Marches along the ray in steps
 * of 0.1 tiles from where it enters the band of map heights, then bisects the crossing to
 * 1e-7 of the step, so the hit is on the sampled surface whatever the slope.
 */
export function rayGround(t: Terrain, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, lo: number, hi: number): { x: number; y: number; z: number; dist: number } | null {
  if (dy >= -1e-9 && oy < lo) return null;
  // start where the ray comes down to the highest ground (or at the camera if it is below that)
  let s0 = dy < 0 ? Math.max(0, (hi + 0.01 - oy) / dy) : 0;
  const sEnd = dy < 0 ? (lo - 0.01 - oy) / dy : 0;
  if (dy >= 0 || sEnd < 0) return null;
  const horiz = Math.hypot(dx, dz);
  const step = horiz > 1e-9 ? 0.1 / horiz : sEnd - s0;
  const f = (s: number) => oy + dy * s - groundHeight(t, ox + dx * s, oz + dz * s);
  if (f(s0) <= 0) return { x: ox + dx * s0, y: groundHeight(t, ox + dx * s0, oz + dz * s0), z: oz + dz * s0, dist: s0 };
  for (let s1 = s0 + step; ; s1 += step) {
    const last = s1 >= sEnd;
    if (last) s1 = sEnd;
    const f1 = f(s1);
    if (f1 <= 0) {
      let a = s0;
      let b = s1;
      for (let k = 0; k < 60 && b - a > step * 1e-7; k++) {
        const m = (a + b) / 2;
        if (f(m) > 0) a = m;
        else b = m;
      }
      const x = ox + dx * b;
      const z = oz + dz * b;
      return { x, y: groundHeight(t, x, z), z, dist: b };
    }
    if (last) return null;
    s0 = s1;
  }
}

/** Lowest and highest vertex height of the map. */
export function heightRange(t: Terrain): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of t.heights) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { lo, hi };
}
