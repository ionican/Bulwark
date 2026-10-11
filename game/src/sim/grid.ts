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

/**
 * Where a straight move from (x0, z0) to (x1, z1) may end without entering or crossing a tile that
 * `passable` rejects (or leaving the w × h map), for aliens and units alike (W24 review 2):
 *   - standing on a blocking tile already: the move is allowed (it is how anything gets out)
 *   - the destination tile blocks: no move (null), as W13 did
 *   - the destination is clear but the segment crosses a blocking tile, or passes exactly through a
 *     corner next to one: the move stops just short of the first such tile (null if that is
 *     no distance at all)
 * A clear move returns [x1, z1] unchanged, so unblocked movement is bit-identical to before.
 */
export function clearMove(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  w: number,
  h: number,
  passable: (cell: number) => boolean,
): [number, number] | null {
  const ok = (x: number, z: number) => x >= 0 && z >= 0 && x < w && z < h && passable(z * w + x);
  let ix = Math.floor(x0);
  let iz = Math.floor(z0);
  const ex = Math.floor(x1);
  const ez = Math.floor(z1);
  if (!ok(ix, iz)) return [x1, z1];
  if (!ok(ex, ez)) return null;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const sz = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  // Amanatides–Woo traversal: t (0..1 along the segment) at which each next grid line is crossed.
  let tMaxX = sx > 0 ? (ix + 1 - x0) / dx : sx < 0 ? (ix - x0) / dx : Infinity;
  let tMaxZ = sz > 0 ? (iz + 1 - z0) / dz : sz < 0 ? (iz - z0) / dz : Infinity;
  const tDX = sx ? Math.abs(1 / dx) : Infinity;
  const tDZ = sz ? Math.abs(1 / dz) : Infinity;
  let blockedAt = -1;
  let guard = Math.abs(ex - ix) + Math.abs(ez - iz) + 2;
  while ((ix !== ex || iz !== ez) && guard-- > 0 && Math.min(tMaxX, tMaxZ) <= 1) {
    if (tMaxX < tMaxZ) {
      ix += sx;
      if (!ok(ix, iz)) {
        blockedAt = tMaxX;
        break;
      }
      tMaxX += tDX;
    } else if (tMaxZ < tMaxX) {
      iz += sz;
      if (!ok(ix, iz)) {
        blockedAt = tMaxZ;
        break;
      }
      tMaxZ += tDZ;
    } else {
      // Exactly through a grid corner: both side tiles must be clear too (the corner rule).
      if (!ok(ix + sx, iz) || !ok(ix, iz + sz) || !ok(ix + sx, iz + sz)) {
        blockedAt = tMaxX;
        break;
      }
      ix += sx;
      iz += sz;
      tMaxX += tDX;
      tMaxZ += tDZ;
    }
  }
  if (blockedAt < 0) return [x1, z1];
  const len = Math.sqrt(dx * dx + dz * dz);
  const safe = blockedAt * len - STOP_SHORT;
  if (safe <= 0) return null;
  return [x0 + (dx * safe) / len, z0 + (dz * safe) / len];
}

/** How far short of a blocking tile a truncated move stops, in tiles. */
const STOP_SHORT = 1e-3;
