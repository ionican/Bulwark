// Selection without mesh raycasting. Buildings: the cursor ray is intersected with the drawn ground
// (ground.ts: the same triangles as the ground mesh) and the hit tile is looked up in the building
// occupancy grid. Units and aliens (W25c, review finding 5): the cursor ray is tested against a
// vertical cylinder per entity, standing on the drawn ground, sized to its kind's model
// (pickVolumes.ts) and widened by `pickPx` screen pixels; the nearest hit along the ray wins. Box
// selection tests each unit's or alien's projected cylinder against the screen rectangle. The ground
// point alone used to stand in for a mobile, so with the camera tilted low a click on a 3.7-tile
// commander's torso hit the ground far behind it. Wrecks are flat and keep the ground-radius test.
// The result does not depend on which LOD is drawn, so it works the same at every zoom level.
//
// W24 run 3 (C1): with `buildingHeight` (the renderer's construction cut span, ModelRenderer
// buildHeight) buildings have pick volumes too, and the click goes to whichever volume — unit,
// building or alien — the ray enters first, so an engineer hidden behind a turret no longer takes
// the click. A building's volume is its footprint from the lowest ground under it to its base (the
// footprint's highest ground, where the renderer stands it) plus the span; a started site's span is
// cut at its progress; a reserved site has none (only its outline is drawn); a gate has only its two
// side columns, so a unit in or behind the corridor stays selectable. A ray that enters no volume
// falls back to the building on the ground tile (a reserved site is still clicked by its tile), then
// a wreck. Without `buildingHeight` the order is the one before run 3.

import { Vector3, type PerspectiveCamera } from 'three';
import { B, alienInfo, unitInfo } from '../sim/kinds.ts';
import { BF_COMPLETE, isReserved } from '../sim/schema.ts';
import type { Terrain } from '../sim/terrain.ts';
import { footprintRange, groundHeight, heightRange, rayGround } from './ground.ts';
import { worldPerPixel } from './cameraRig.ts';
import { alienVolume, unitVolume, type PickVolume } from './pickVolumes.ts';

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
  /**
   * Footprint fw × fh tiles from the anchor (tx, ty), from the snapshot columns (W24). Run 3: the
   * construction state (flags, progress), tier and gate axis (dir), for the pick volumes.
   */
  buildings: {
    count: number;
    id: Uint32Array;
    kind: Uint8Array;
    tx: Int16Array;
    ty: Int16Array;
    fw: Uint8Array;
    fh: Uint8Array;
    flags?: ArrayLike<number>;
    progress?: ArrayLike<number>;
    tier?: ArrayLike<number>;
    dir?: ArrayLike<number>;
  };
  /** Run 3: the renderer's construction cut span (ModelRenderer.buildHeight); without it buildings are picked by ground tile. */
  buildingHeight?: (kind: number, tier: number) => number;
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
  const r = rangeOf(terrain);
  const hit = rayGround(terrain, o.x, o.y, o.z, dir.x, dir.y, dir.z, r.lo, r.hi);
  return hit ? { x: hit.x, z: hit.z, y: hit.y, dist: hit.dist } : null;
}

const ranges = new WeakMap<Terrain, { lo: number; hi: number }>();
function rangeOf(t: Terrain): { lo: number; hi: number } {
  let r = ranges.get(t);
  if (!r) {
    r = heightRange(t);
    ranges.set(t, r);
  }
  return r;
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

const _o = new Vector3();
const _d = new Vector3();

/**
 * Distance along the ray (origin o, unit direction d) at which it enters the vertical cylinder of
 * radius `r` round (cx, cz) from height y0 to y1, or -1 if it misses (or the cylinder is behind).
 */
export function rayCylinder(o: Vector3, d: Vector3, cx: number, cz: number, r: number, y0: number, y1: number): number {
  // the ray's interval inside the infinite cylinder, from the ground-plane circle
  const ox = o.x - cx;
  const oz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  const c = ox * ox + oz * oz - r * r;
  let t0: number;
  let t1: number;
  if (a < 1e-12) {
    if (c > 0) return -1;
    t0 = -Infinity;
    t1 = Infinity;
  } else {
    const b = ox * d.x + oz * d.z;
    const disc = b * b - a * c;
    if (disc < 0) return -1;
    const q = Math.sqrt(disc);
    t0 = (-b - q) / a;
    t1 = (-b + q) / a;
  }
  // and inside the slab y0..y1
  if (Math.abs(d.y) < 1e-12) {
    if (o.y < y0 || o.y > y1) return -1;
  } else {
    const ta = (y0 - o.y) / d.y;
    const tb = (y1 - o.y) / d.y;
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
  }
  t0 = Math.max(t0, 0);
  return t0 <= t1 ? t0 : -1;
}

/** Row of the mobile in `rows` whose cylinder the ray enters first, or -1. `pad` px widen each. */
function nearestVolume(rows: MobileRows, volume: (kind: number) => PickVolume, terrain: Terrain, camera: PerspectiveCamera, vh: number, pad: number): number {
  let best = -1;
  let bestT = Infinity;
  for (let r = 0; r < rows.count; r++) {
    const x = rows.x[r]!;
    const z = rows.z[r]!;
    const v = volume(rows.kind[r]!);
    const y = groundHeight(terrain, x, z);
    const extra = pad * worldPerPixel(camera, Math.hypot(x - _o.x, y + v.height / 2 - _o.y, z - _o.z), vh);
    const t = rayCylinder(_o, _d, x, z, v.radius + extra, y - extra, y + v.height + extra);
    if (t >= 0 && t < bestT) {
      bestT = t;
      best = r;
    }
  }
  return best;
}

/**
 * True when tile (x, z) is the corridor column of a gate anchored at (tx, ty) along `dir` (0: the
 * run along x). The same rule as sim/gate.ts inGateCorridor, which render code may not import
 * (test/w24r2a-imports); test/w24r3-rules checks the two agree.
 */
export const gateCorridorTile = (tx: number, ty: number, dir: number, x: number, z: number): boolean => (dir === 0 ? x === tx + 1 : z === ty + 1);

/**
 * Distance along the ray (_o, _d) at which it enters the box [x0, x1] × [y0, y1] × [z0, z1], or -1
 * if it misses (or the box is behind the camera).
 */
function rayBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  let t0 = 0;
  let t1 = Infinity;
  const o = [_o.x, _o.y, _o.z];
  const d = [_d.x, _d.y, _d.z];
  const lo = [x0, y0, z0];
  const hi = [x1, y1, z1];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]!) < 1e-12) {
      if (o[i]! < lo[i]! || o[i]! > hi[i]!) return -1;
      continue;
    }
    const a = (lo[i]! - o[i]!) / d[i]!;
    const b = (hi[i]! - o[i]!) / d[i]!;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
    if (t0 > t1) return -1;
  }
  return t0;
}

/**
 * Row of the building whose pick volume the ray (_o, _d) enters first, and the distance; row -1 when
 * none. See the file comment for the volumes.
 */
function nearestBuilding(view: PickView, terrain: Terrain, height: (kind: number, tier: number) => number): { row: number; t: number } {
  const b = view.buildings;
  const range = rangeOf(terrain);
  let row = -1;
  let best = Infinity;
  for (let r = 0; r < b.count; r++) {
    const flags = b.flags?.[r] ?? BF_COMPLETE;
    if (isReserved(flags)) continue;
    const kind = b.kind[r]!;
    const full = height(kind, b.tier?.[r] ?? 1);
    const h = flags & BF_COMPLETE ? full : full * (b.progress?.[r] ?? 1);
    if (!(h > 0)) continue;
    const tx = b.tx[r]!;
    const ty = b.ty[r]!;
    const fw = b.fw[r]!;
    const fh = b.fh[r]!;
    // cheap reject against the map's height band before the footprint's own heights are read
    if (rayBox(tx, range.lo, ty, tx + fw, range.hi + h, ty + fh) < 0) continue;
    const g = footprintRange(terrain, tx, ty, fw, fh);
    let t: number;
    if (kind === B.gate) {
      // the two side columns only (one tile across the run, the full run deep)
      const dir = b.dir?.[r] ?? 0;
      t = Infinity;
      for (let i = 0; i < (dir === 0 ? fw : fh); i++) {
        const x = dir === 0 ? tx + i : tx;
        const z = dir === 0 ? ty : ty + i;
        if (gateCorridorTile(tx, ty, dir, x, z)) continue;
        const ti = rayBox(x, g.bottom, z, dir === 0 ? x + 1 : tx + fw, g.top + h, dir === 0 ? ty + fh : z + 1);
        if (ti >= 0 && ti < t) t = ti;
      }
      if (t === Infinity) t = -1;
    } else t = rayBox(tx, g.bottom, ty, tx + fw, g.top + h, ty + fh);
    if (t >= 0 && t < best) {
      best = t;
      row = r;
    }
  }
  return { row, t: best };
}

/** Distance along the ray to mobile row `r`'s widened cylinder (as nearestVolume measures it). */
function volumeDistance(rows: MobileRows, r: number, volume: (kind: number) => PickVolume, terrain: Terrain, camera: PerspectiveCamera, vh: number, pad: number): number {
  const x = rows.x[r]!;
  const z = rows.z[r]!;
  const v = volume(rows.kind[r]!);
  const y = groundHeight(terrain, x, z);
  const extra = pad * worldPerPixel(camera, Math.hypot(x - _o.x, y + v.height / 2 - _o.y, z - _o.z), vh);
  return rayCylinder(_o, _d, x, z, v.radius + extra, y - extra, y + v.height + extra);
}

/** The building row on the ground tile `hit` falls in, or −1. */
function buildingRowAt(hit: GroundHit | null, view: PickView): number {
  if (!hit) return -1;
  const tx = Math.floor(hit.x);
  const tz = Math.floor(hit.z);
  if (tx < 0 || tz < 0 || tx >= view.mapW || tz >= view.mapH) return -1;
  return view.occupancy[tz * view.mapW + tx]! - 1;
}

/**
 * The building on the ground tile under a screen pixel (its id), or −1. Units standing in front
 * are ignored: W28's hover readout reads the site even while its builders stand on it.
 */
export function buildingAtScreen(camera: PerspectiveCamera, sx: number, sy: number, vw: number, vh: number, terrain: Terrain, view: PickView): number {
  const row = buildingRowAt(screenToGround(camera, sx, sy, vw, vh, terrain), view);
  return row >= 0 ? view.buildings.id[row]! : -1;
}

/**
 * Pick under a screen pixel. Order: the player unit whose volume the cursor ray enters first, then
 * the building on the ground tile under the cursor, then the nearest alien volume, then a wreck by
 * ground radius. Mobiles' volumes are widened by `pickPx` screen pixels.
 */
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
  _o.copy(camera.position);
  _d.set((sx / vw) * 2 - 1, -(sy / vh) * 2 + 1, 0.5).unproject(camera).sub(_o).normalize();
  const u = nearestVolume(view.units, unitVolume, terrain, camera, vh, pickPx);
  if (view.buildingHeight) {
    // run 3: whichever volume the ray enters first
    const tu = u >= 0 ? volumeDistance(view.units, u, unitVolume, terrain, camera, vh, pickPx) : Infinity;
    const bld = nearestBuilding(view, terrain, view.buildingHeight);
    const a = nearestVolume(view.aliens, alienVolume, terrain, camera, vh, pickPx);
    const ta = a >= 0 ? volumeDistance(view.aliens, a, alienVolume, terrain, camera, vh, pickPx) : Infinity;
    if (u >= 0 && tu <= bld.t && tu <= ta) return { type: 'unit', id: view.units.id[u]!, kind: view.units.kind[u]! };
    if (bld.row >= 0 && bld.t <= ta) return { type: 'building', id: view.buildings.id[bld.row]!, kind: view.buildings.kind[bld.row]! };
    if (a >= 0) return { type: 'alien', id: view.aliens.id[a]!, kind: view.aliens.kind[a]! };
  } else if (u >= 0) return { type: 'unit', id: view.units.id[u]!, kind: view.units.kind[u]! };
  const hit = screenToGround(camera, sx, sy, vw, vh, terrain);
  const row = buildingRowAt(hit, view);
  if (row >= 0) return { type: 'building', id: view.buildings.id[row]!, kind: view.buildings.kind[row]! };
  const a = nearestVolume(view.aliens, alienVolume, terrain, camera, vh, pickPx);
  if (a >= 0) return { type: 'alien', id: view.aliens.id[a]!, kind: view.aliens.kind[a]! };
  if (hit && view.wrecks) {
    const pad = pickPx * worldPerPixel(camera, hit.dist, vh);
    const r = nearestMobile(view.wrecks, hit.x, hit.z, pad, () => 0.6);
    if (r >= 0) return { type: 'wreck', id: view.wrecks.id[r]!, kind: view.wrecks.kind[r]! };
  }
  return null;
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

const _p = new Vector3();

/**
 * True if mobile volume `v` standing at (x, y, z) overlaps the screen rectangle [x0, x1] × [y0, y1]
 * (CSS px): its axis from foot to top projected to the screen, widened by its radius in pixels at
 * that depth (the projected cylinder, as a screen-space capsule). False if any of it is behind the camera.
 */
function volumeInRect(camera: PerspectiveCamera, vw: number, vh: number, x: number, y: number, z: number, v: PickVolume, x0: number, y0: number, x1: number, y1: number): boolean {
  const ends: Array<[number, number]> = [];
  for (const h of [0, v.height]) {
    _p.set(x, y + h, z).applyMatrix4(camera.matrixWorldInverse);
    if (_p.z > -camera.near) return false;
    _p.applyMatrix4(camera.projectionMatrix);
    ends.push([((_p.x + 1) / 2) * vw, ((1 - _p.y) / 2) * vh]);
  }
  const dist = Math.hypot(x - camera.position.x, y + v.height / 2 - camera.position.y, z - camera.position.z);
  const rad = v.radius / worldPerPixel(camera, dist, vh);
  return segmentRectDistance(ends[0]!, ends[1]!, x0, y0, x1, y1) <= rad;
}

/** Distance from screen segment a–b to the rectangle (0 when they touch). */
function segmentRectDistance(a: [number, number], b: [number, number], x0: number, y0: number, x1: number, y1: number): number {
  const inside = (p: [number, number]) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  if (inside(a) || inside(b)) return 0;
  const corners: Array<[number, number]> = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  for (let i = 0; i < 4; i++) if (segmentsCross(a, b, corners[i]!, corners[(i + 1) % 4]!)) return 0;
  let d = Infinity;
  for (const c of corners) d = Math.min(d, pointSegment(c, a, b));
  for (const p of [a, b]) d = Math.min(d, Math.hypot(Math.max(x0 - p[0], 0, p[0] - x1), Math.max(y0 - p[1], 0, p[1] - y1)));
  return d;
}

function pointSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function segmentsCross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const cross = (o: [number, number], p: [number, number], q: [number, number]) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Box selection. Player units whose projected volume overlaps the screen rectangle, if any;
 * otherwise buildings whose footprint centre lies in the rectangle's ground quad (its corners cast
 * to the ground, as before W25c; none when a corner misses the ground); otherwise aliens by
 * projected volume.
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
  const rx0 = Math.min(x0, x1);
  const rx1 = Math.max(x0, x1);
  const ry0 = Math.min(y0, y1);
  const ry1 = Math.max(y0, y1);
  camera.updateMatrixWorld();
  const out: Pick[] = [];
  const mobiles = (rows: MobileRows, type: 'unit' | 'alien', volume: (kind: number) => PickVolume) => {
    for (let r = 0; r < rows.count; r++) {
      const x = rows.x[r]!;
      const z = rows.z[r]!;
      if (volumeInRect(camera, vw, vh, x, groundHeight(terrain, x, z), z, volume(rows.kind[r]!), rx0, ry0, rx1, ry1)) out.push({ type, id: rows.id[r]!, kind: rows.kind[r]! });
    }
  };
  mobiles(view.units, 'unit', unitVolume);
  if (out.length) return out;
  const corners = [
    screenToGround(camera, rx0, ry0, vw, vh, terrain),
    screenToGround(camera, rx1, ry0, vw, vh, terrain),
    screenToGround(camera, rx1, ry1, vw, vh, terrain),
    screenToGround(camera, rx0, ry1, vw, vh, terrain),
  ];
  if (!corners.some((c) => c === null)) {
    const q = corners as GroundHit[];
    const b = view.buildings;
    for (let r = 0; r < b.count; r++) {
      if (insideQuad(q, b.tx[r]! + b.fw[r]! / 2, b.ty[r]! + b.fh[r]! / 2)) out.push({ type: 'building', id: b.id[r]!, kind: b.kind[r]! });
    }
    if (out.length) return out;
  }
  mobiles(view.aliens, 'alien', alienVolume);
  return out;
}
