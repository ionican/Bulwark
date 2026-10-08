// Selection without mesh raycasting. The cursor ray is intersected with the ground (the terrain
// heightfield, refined from a plane guess), and the hit is looked up in the simulation's own
// tables: the building occupancy grid for buildings, a radius test on positions for mobiles.
// The result does not depend on which LOD is drawn, so it works the same at every zoom level.

import { Vector3, type PerspectiveCamera } from 'three';
import { alienInfo, unitInfo } from '../sim/kinds.ts';
import { heightAt, type Terrain } from '../sim/terrain.ts';
import { worldPerPixel } from './cameraRig.ts';

export type PickType = 'unit' | 'building' | 'alien' | 'wreck';

export interface Pick {
  type: PickType;
  id: number;
  kind: number;
}

interface MobileRows {
  count: number;
  id: Uint32Array;
  kind: Uint8Array;
  /** Current (interpolated) positions, same row order as id. */
  x: Float32Array;
  z: Float32Array;
}

export interface PickView {
  mapW: number;
  mapH: number;
  /** Building row + 1 per tile (0 = no building). Built by buildOccupancy. */
  occupancy: Int32Array;
  /** Footprint fw × fh tiles from the anchor (tx, ty), from the snapshot columns (W24). */
  buildings: { count: number; id: Uint32Array; kind: Uint8Array; tx: Int16Array; ty: Int16Array; fw: Uint8Array; fh: Uint8Array };
  units: MobileRows;
  aliens: MobileRows;
  /** Optional: wrecks (picked last, so a click on a building or alien wins). */
  wrecks?: MobileRows;
}

export function buildOccupancy(b: PickView['buildings'], w: number, h: number, out: Int32Array): Int32Array {
  out.fill(0);
  for (let r = 0; r < b.count; r++) {
    const tx = b.tx[r]!;
    const ty = b.ty[r]!;
    for (let j = 0; j < b.fh[r]!; j++) {
      for (let i = 0; i < b.fw[r]!; i++) {
        const x = tx + i;
        const y = ty + j;
        if (x >= 0 && y >= 0 && x < w && y < h) out[y * w + x] = r + 1;
      }
    }
  }
  return out;
}

const tmp = new Vector3();
const dir = new Vector3();

export interface GroundHit {
  x: number;
  z: number;
  y: number;
  /** Distance from the camera to the hit point. */
  dist: number;
}

/**
 * Ground point under screen pixel (sx, sy) of a viewport vw × vh (CSS pixels, origin top-left).
 * Null if the ray points above the horizon.
 */
export function screenToGround(camera: PerspectiveCamera, sx: number, sy: number, vw: number, vh: number, terrain: Terrain): GroundHit | null {
  tmp.set((sx / vw) * 2 - 1, -(sy / vh) * 2 + 1, 0.5).unproject(camera);
  const o = camera.position;
  dir.copy(tmp).sub(o).normalize();
  if (dir.y >= -1e-6) return null;
  // Fixed-point refinement: intersect the horizontal plane at the height found at the last guess.
  let y = 1;
  let t = 0;
  for (let i = 0; i < 10; i++) {
    t = (y - o.y) / dir.y;
    const ny = heightAt(terrain, o.x + dir.x * t, o.z + dir.z * t);
    if (Math.abs(ny - y) < 1e-4) {
      y = ny;
      break;
    }
    y = ny;
  }
  t = (y - o.y) / dir.y;
  if (t <= 0) return null;
  return { x: o.x + dir.x * t, z: o.z + dir.z * t, y, dist: t };
}

function nearestMobile(rows: MobileRows, gx: number, gz: number, pad: number, radius: (kind: number) => number): number {
  let best = -1;
  let bestD = Infinity;
  for (let r = 0; r < rows.count; r++) {
    const dx = rows.x[r]! - gx;
    const dz = rows.z[r]! - gz;
    const reach = radius(rows.kind[r]!) + pad;
    const d2 = dx * dx + dz * dz;
    if (d2 <= reach * reach && d2 < bestD) {
      bestD = d2;
      best = r;
    }
  }
  return best;
}

/**
 * Entity at ground point (gx, gz). Order: player units within reach, then the building whose
 * footprint covers the tile, then aliens within reach. `pad` widens the reach of mobiles (world units).
 */
export function pickAt(view: PickView, gx: number, gz: number, pad: number): Pick | null {
  const u = nearestMobile(view.units, gx, gz, pad, (k) => unitInfo(k).radius);
  if (u >= 0) return { type: 'unit', id: view.units.id[u]!, kind: view.units.kind[u]! };
  const tx = Math.floor(gx);
  const tz = Math.floor(gz);
  if (tx >= 0 && tz >= 0 && tx < view.mapW && tz < view.mapH) {
    const row = view.occupancy[tz * view.mapW + tx]! - 1;
    if (row >= 0) return { type: 'building', id: view.buildings.id[row]!, kind: view.buildings.kind[row]! };
  }
  const a = nearestMobile(view.aliens, gx, gz, pad, (k) => alienInfo(k).radius);
  if (a >= 0) return { type: 'alien', id: view.aliens.id[a]!, kind: view.aliens.kind[a]! };
  if (view.wrecks) {
    const r = nearestMobile(view.wrecks, gx, gz, pad, () => 0.6);
    if (r >= 0) return { type: 'wreck', id: view.wrecks.id[r]!, kind: view.wrecks.kind[r]! };
  }
  return null;
}

/** Pick under a screen pixel. Mobiles get a reach of `pickPx` screen pixels on top of their radius. */
export function pickScreen(
  camera: PerspectiveCamera,
  sx: number,
  sy: number,
  vw: number,
  vh: number,
  terrain: Terrain,
  view: PickView,
  pickPx = 8,
): Pick | null {
  const hit = screenToGround(camera, sx, sy, vw, vh, terrain);
  if (!hit) return null;
  return pickAt(view, hit.x, hit.z, pickPx * worldPerPixel(camera, hit.dist, vh));
}

function insideQuad(q: GroundHit[], x: number, z: number): boolean {
  // Convex quad, either winding: the point is inside if every edge cross product has the same sign.
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const c = (b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x);
    if (c === 0) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * Box selection: the screen rectangle's corners are cast to the ground and entities inside the
 * ground quad are returned. Player units if any are inside, otherwise buildings, otherwise aliens.
 */
export function boxSelect(
  camera: PerspectiveCamera,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  vw: number,
  vh: number,
  terrain: Terrain,
  view: PickView,
): Pick[] {
  const corners = [
    screenToGround(camera, Math.min(x0, x1), Math.min(y0, y1), vw, vh, terrain),
    screenToGround(camera, Math.max(x0, x1), Math.min(y0, y1), vw, vh, terrain),
    screenToGround(camera, Math.max(x0, x1), Math.max(y0, y1), vw, vh, terrain),
    screenToGround(camera, Math.min(x0, x1), Math.max(y0, y1), vw, vh, terrain),
  ];
  if (corners.some((c) => c === null)) return [];
  const q = corners as GroundHit[];
  const out: Pick[] = [];
  const u = view.units;
  for (let r = 0; r < u.count; r++) if (insideQuad(q, u.x[r]!, u.z[r]!)) out.push({ type: 'unit', id: u.id[r]!, kind: u.kind[r]! });
  if (out.length) return out;
  const b = view.buildings;
  for (let r = 0; r < b.count; r++) {
    if (insideQuad(q, b.tx[r]! + b.fw[r]! / 2, b.ty[r]! + b.fh[r]! / 2)) out.push({ type: 'building', id: b.id[r]!, kind: b.kind[r]! });
  }
  if (out.length) return out;
  const a = view.aliens;
  for (let r = 0; r < a.count; r++) if (insideQuad(q, a.x[r]!, a.z[r]!)) out.push({ type: 'alien', id: a.id[r]!, kind: a.kind[r]! });
  return out;
}
