// Grid helpers shared by flow fields and unit pathing: neighbour offsets and the corner rule.

/** Eight directions; even indices are orthogonal. dx, dz per direction. */
export const DX = [1, 1, 0, -1, -1, -1, 0, 1] as const;
export const DZ = [0, 1, 1, 1, 0, -1, -1, -1] as const;
export const DIR_NONE = -1;

/** Step cost multiplier ×10 (orthogonal 10, diagonal 14). */
export const STEP = [10, 14, 10, 14, 10, 14, 10, 14] as const;

/** Cost of entering a cell, scaled for the direction (integer arithmetic only). */
export const stepCost = (enter: number, d: number): number => (d & 1 ? ((enter * 14 + 5) / 10) | 0 : enter);

/**
 * Visits the tiles round (x0, z0) ring by ring (Chebyshev distance r0..r1), within a ring in
 * (ty, tx) order, skipping tiles off the w × h map. Stops as soon as `visit` returns true.
 * Used wherever a search must take the nearest tile in a fixed, deterministic order.
 */
export function visitRings(x0: number, z0: number, r0: number, r1: number, w: number, h: number, visit: (tx: number, ty: number) => boolean): boolean {
  for (let r = r0; r <= r1; r++) {
    for (let ty = z0 - r; ty <= z0 + r; ty++) {
      for (let tx = x0 - r; tx <= x0 + r; tx++) {
        if (Math.max(Math.abs(tx - x0), Math.abs(ty - z0)) !== r) continue;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        if (visit(tx, ty)) return true;
      }
    }
  }
  return false;
}

/**
 * Diagonal moves may not cut a corner: both orthogonal cells between the two must be `open`.
 * Returns true if moving from (x, z) in direction d is allowed by the corner rule.
 */
export function cornerOk(open: Uint8Array, w: number, x: number, z: number, d: number): boolean {
  if (!(d & 1)) return true;
  return open[z * w + x + DX[d]!] === 1 && open[(z + DZ[d]!) * w + x] === 1;
}
