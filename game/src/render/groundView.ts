// The drawn ground (W24 run 2a): the map surface, the canyon scenery beyond its edge, and terraced
// outcrops on rock tiles, all shaded by W17's terrain material (workshop/world/terrainMaterial.ts).
//
//   Map surface   one vertex per grid corner (129 × 129) at the terrain's own heights, triangulated
//                 as ground.ts samples it. Vertex mask (`aMask`): dark = weathering from noise,
//                 pave = 0 (paving comes from a texture, see below), cliff = share of the four
//                 neighbouring tiles that are rock (the shader adds cliff from slope itself).
//   Scenery       rings of vertices round the map, each ring one step further out; ring 0 IS the
//                 map's edge row of vertices (same indices in one geometry), so there is no gap or
//                 crack and the normals are shared across the seam. Heights fall from the edge into
//                 a canyon floor, then climb terraced walls to the horizon; the two approach
//                 corridors (north and east entries) run out as canyons at floor level.
//   Outcrops      on rock tiles: a quarter-tile grid whose height above the sampled ground grows
//                 with the distance from the nearest non-rock tile, in terraces (flat ledge, steep
//                 riser), tucked 0.05 tiles under the ground at the rock's edge. Cosmetic: nothing
//                 walks on rock, so the sampler ignores them.
//   Paving        a 128 × 128 texture, one texel per tile, 1 under complete buildings' footprints,
//                 re-uploaded only when that set changes.
//
// Geometry is built in pure three.js (no DOM), so the tests inspect the same buffers that are drawn.

import { BufferAttribute, BufferGeometry, DataTexture, LinearFilter, Mesh, RedFormat, UnsignedByteType, type Material } from 'three';
import { TILE_ROCK, rollingHeight, type Terrain } from '../sim/terrain.ts';
import { groundHeight } from './ground.ts';
import { fbm, smoothstep } from './workshop/noise.ts';

/** Distances of the scenery rings from the map edge (tiles). Ring 0 is the edge itself. */
/** Distances of the scenery rings from the map edge (tiles): 1.5 apart for the first 48 (cliffs and terraces), then wider. */
export const SCENERY_RINGS = [0, 1.5, 3, 4.5, 6, 7.5, 9, 10.5, 12, 13.5, 15, 16.5, 18, 19.5, 21, 22.5, 24, 25.5, 27, 28.5, 30, 31.5, 33, 34.5, 36, 37.5, 39, 40.5, 42, 43.5, 45, 46.5, 48, 52, 57, 63, 70, 78, 87, 97, 108, 120, 134, 150, 168, 190, 215, 245, 290, 340];

export interface GroundGeometry {
  geometry: BufferGeometry;
  /** Vertices 0 … mapVertices − 1 are the map grid ((w + 1) × (h + 1), row-major by z). */
  mapVertices: number;
  /** Indices 0 … mapIndices − 1 are the map's triangles (6 per tile). */
  mapIndices: number;
  /** Map-grid vertex index of each perimeter sample of ring 0 (the shared edge). */
  edge: Uint32Array;
}

/** Map perimeter as grid vertex coordinates, clockwise from (0, 0): 4 × w samples (square maps). */
function perimeter(t: Terrain): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let x = 0; x < t.w; x++) out.push([x, 0]);
  for (let z = 0; z < t.h; z++) out.push([t.w, z]);
  for (let x = t.w; x > 0; x--) out.push([x, t.h]);
  for (let z = t.h; z > 0; z--) out.push([0, z]);
  return out;
}

/** Terraces: flat ledges `step` apart joined by risers over the last (1 − flat) of each step. */
const terrace = (h: number, step: number, flat = 0.62) => {
  const k = Math.floor(h / step);
  const f = h / step - k;
  return (k + smoothstep(flat, 0.97, f)) * step;
};

/**
 * Scenery height at world (x, z), `d` rings beyond the edge; `edgeH` is the edge vertex's height.
 * The game's own rolling ground (sim/terrain.ts rollingHeight, defined beyond the map) carries on
 * past the edge, so the map has no cut edge; within the first 3 rings it blends from the edge
 * vertex's exact height (rock bumps included). The canyon country starts an irregular 3–33 tiles out
 * (distances measured from the map rectangle, so its corners are rounded); every height there is
 * shaped by noise, so terraces follow irregular contours, never the square:
 *   north-east (where the waves come from): a terraced cliff down to a canyon floor with irregular
 *     terraced mesas on it, and high ground rising beyond;
 *   south-west: irregular terraced hills climbing from the plateau.
 * Each entry keeps its ramp from the edge down to the canyon floor.
 */
function sceneryHeight(t: Terrain, x: number, z: number, d: number, edgeH: number): number {
  const de = Math.hypot(Math.max(0, -x, x - t.w), Math.max(0, -z, z - t.h));
  const n1 = fbm(x * 0.021, z * 0.021, 4) * 0.5 + 0.5;
  const n2 = fbm(x * 0.06 + 17, z * 0.06 - 5, 3) * 0.5 + 0.5;
  const n3 = fbm(x * 0.034 - 11, z * 0.034 + 6, 4) * 0.5 + 0.5;
  const floor = -5.5 + 1.2 * (n2 - 0.5);
  const plateau = rollingHeight(x, z);
  // where the canyon country starts: an irregular outline round the map
  const rimD = Math.max(3, 3 + 30 * (fbm(x * 0.032 + 5.3, z * 0.032 - 2.9, 3) * 0.5 + 0.5) + 12 * fbm(x * 0.09 - 1.7, z * 0.09 + 3.1, 2));
  const out = smoothstep(rimD, rimD + 6, de);
  const far = smoothstep(0.45, 0.6, fbm(x * 0.011 + 2, z * 0.011 - 8, 3) * 0.5 + 0.5) * smoothstep(50, 120, de);
  // north-east: canyon floor with mesas where the noise is high, high ground beyond
  const mesa = smoothstep(0.55, 0.63, n3) * (6 + 8 * n2) + far * (10 + 8 * n1);
  const canyon = plateau + (terrace(floor + mesa, 1.8, 0.78) - plateau) * out;
  // south-west: hills where the noise is high, everywhere a little higher further out
  const hills = (3 + 14 * smoothstep(0.35, 0.7, n3) + 6 * n1) * smoothstep(rimD, rimD + 24, de) + far * 8;
  // terraced hills on the rolling ground (only the hills are terraced, so the ground itself has no step)
  const rise = plateau + terrace(hills, 2.0, 0.76);
  const vx = x - t.w / 2;
  const vz = z - t.h / 2;
  const ne = (vx - vz) / (Math.SQRT2 * (Math.hypot(vx, vz) || 1));
  let h = rise + (canyon - rise) * smoothstep(-0.3, 0.3, ne);
  for (const e of t.entries) {
    const px = x - e.x;
    const pz = z - e.z;
    const along = -(px * e.dirX + pz * e.dirZ);
    const across = Math.abs(px * e.dirZ - pz * e.dirX);
    if (along < -6) continue;
    const width = 8 + 4 * n2 + Math.max(0, along) * 0.08;
    const k = 1 - smoothstep(width, width + 6, across);
    const ramp = plateau + (floor - 0.3 - plateau) * smoothstep(4, 55, along);
    h = h + (ramp - h) * k;
  }
  return edgeH + (h - edgeH) * smoothstep(0, 3, d);
}

/**
 * Weathering mask (the dark rock of W17's material). Zero on the ground and the scenery since
 * Richard's feedback (it read as repeating dark blotches); the outcrops keep a fixed 0.3.
 */
function darkAt(_x: number, _z: number): number {
  return 0;
}

export function buildGroundGeometry(t: Terrain): GroundGeometry {
  const s = t.w + 1;
  const mapVertices = s * (t.h + 1);
  const per = perimeter(t);
  const P = per.length;
  const rings = SCENERY_RINGS.length - 1;
  const total = mapVertices + rings * P;
  const pos = new Float32Array(total * 3);
  const mask = new Float32Array(total * 3);
  for (let z = 0; z <= t.h; z++)
    for (let x = 0; x <= t.w; x++) {
      const i = z * s + x;
      pos[i * 3] = x;
      pos[i * 3 + 1] = t.heights[i]!;
      pos[i * 3 + 2] = z;
      let rock = 0;
      for (let j = -1; j <= 0; j++) for (let k = -1; k <= 0; k++) if (t.tiles[(z + j) * t.w + x + k] === TILE_ROCK && x + k >= 0 && z + j >= 0 && x + k < t.w && z + j < t.h) rock++;
      mask[i * 3] = darkAt(x, z);
      mask[i * 3 + 1] = 0;
      mask[i * 3 + 2] = rock / 4;
    }
  const edge = new Uint32Array(P);
  per.forEach(([x, z], k) => (edge[k] = z * s + x));
  // rings 1 … n: each perimeter sample pushed out along its side's normal; near a corner the
  // normal turns gradually from one side's to the next over ±m samples (m grows with the distance),
  // so the rings round the corners instead of fanning from one diagonal (which drew a crease)
  const cx = t.w / 2;
  const cz = t.h / 2;
  const side = (k: number) => Math.floor(k / t.w) % 4; // 0 north, 1 east, 2 south, 3 west
  const NX = [0, 1, 0, -1];
  const NZ = [-1, 0, 1, 0];
  for (let r = 1; r <= rings; r++) {
    const d = SCENERY_RINGS[r]!;
    const m = Math.min(t.w / 2 - 1, 2 + d * 0.5);
    per.forEach(([x, z], k) => {
      // nearest corner (sample index a multiple of w) and the offset from it
      const c = Math.round(k / t.w) * t.w;
      const j = k - c;
      const before = side((c - 1 + P) % P);
      const after = side(c % P);
      let nx: number;
      let nz: number;
      if (Math.abs(j) < m) {
        const u = (j / m + 1) / 2;
        const f = u * u * (3 - 2 * u);
        nx = NX[before]! * (1 - f) + NX[after]! * f;
        nz = NZ[before]! * (1 - f) + NZ[after]! * f;
        const l = Math.hypot(nx, nz);
        nx /= l;
        nz /= l;
      } else {
        nx = NX[side(k)]!;
        nz = NZ[side(k)]!;
      }
      // spread the far rings a little so the corners do not pinch
      const wx = x + nx * d + (x - cx) * (d / 600);
      const wz = z + nz * d + (z - cz) * (d / 600);
      const v = mapVertices + (r - 1) * P + k;
      const edgeH = t.heights[edge[k]!]!;
      pos[v * 3] = wx;
      pos[v * 3 + 1] = sceneryHeight(t, wx, wz, d, edgeH);
      pos[v * 3 + 2] = wz;
      mask[v * 3] = darkAt(wx, wz);
      mask[v * 3 + 1] = 0;
      mask[v * 3 + 2] = 0; // cliffs come from the slope in the shader
    });
  }
  const mapIndices = t.w * t.h * 6;
  const idx = new Uint32Array(mapIndices + rings * P * 6);
  let q = 0;
  for (let z = 0; z < t.h; z++)
    for (let x = 0; x < t.w; x++) {
      const a = z * s + x;
      const b = a + 1;
      const c = a + s;
      const d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b;
      idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
  // ring r−1 → ring r. The perimeter runs clockwise seen from above (+y), with the outside on its
  // left; triangles wound so their normals face up.
  const ringV = (r: number, k: number) => (r === 0 ? edge[k % P]! : mapVertices + (r - 1) * P + (k % P));
  for (let r = 1; r <= rings; r++)
    for (let k = 0; k < P; k++) {
      const i0 = ringV(r - 1, k);
      const i1 = ringV(r - 1, k + 1);
      const o0 = ringV(r, k);
      const o1 = ringV(r, k + 1);
      idx[q++] = i0; idx[q++] = i1; idx[q++] = o0;
      idx[q++] = i1; idx[q++] = o1; idx[q++] = o0;
    }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('aMask', new BufferAttribute(mask, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return { geometry: g, mapVertices, mapIndices, edge };
}

/** Sub-cells per tile side for the outcrops. */
const OUT_N = 4;
/** Distance from the rock's edge (tiles) at which an outcrop reaches its full height. */
const OUT_R = 2.6;

export function buildOutcropGeometry(t: Terrain): BufferGeometry {
  const rock = (x: number, z: number) => x >= 0 && z >= 0 && x < t.w && z < t.h && t.tiles[z * t.w + x] === TILE_ROCK;
  // distance from a point to the nearest non-rock tile (squares), capped
  const dist = (px: number, pz: number) => {
    let best = OUT_R;
    const r = Math.ceil(OUT_R) + 1;
    const x0 = Math.floor(px);
    const z0 = Math.floor(pz);
    for (let z = z0 - r; z <= z0 + r; z++)
      for (let x = x0 - r; x <= x0 + r; x++) {
        if (rock(x, z)) continue;
        const dx = Math.max(x - px, 0, px - (x + 1));
        const dz = Math.max(z - pz, 0, pz - (z + 1));
        best = Math.min(best, Math.hypot(dx, dz));
      }
    return best;
  };
  const verts = new Map<number, number>();
  const pos: number[] = [];
  const mask: number[] = [];
  const W = t.w * OUT_N + 1;
  const vert = (gx: number, gz: number): number => {
    const key = gz * W + gx;
    let v = verts.get(key);
    if (v !== undefined) return v;
    const x = gx / OUT_N;
    const z = gz / OUT_N;
    const d = dist(x, z);
    // per-outcrop height from slow noise: 1.4 … 3.4 tiles
    const top = 1.4 + 2 * (fbm(x * 0.09 + 7, z * 0.09 + 2, 2) * 0.5 + 0.5);
    const u = d / OUT_R;
    const bump = d <= 1e-6 ? -0.05 : terrace(u * top, top / 3) + 0.04 * (fbm(x * 1.3, z * 1.3, 2) * 0.5 + 0.5);
    v = pos.length / 3;
    pos.push(x, groundHeight(t, x, z) + bump, z);
    mask.push(0.3 + darkAt(x, z), 0, 1);
    verts.set(key, v);
    return v;
  };
  const idx: number[] = [];
  for (let tz = 0; tz < t.h; tz++)
    for (let tx = 0; tx < t.w; tx++) {
      if (!rock(tx, tz)) continue;
      for (let j = 0; j < OUT_N; j++)
        for (let i = 0; i < OUT_N; i++) {
          const gx = tx * OUT_N + i;
          const gz = tz * OUT_N + j;
          const a = vert(gx, gz);
          const b = vert(gx + 1, gz);
          const c = vert(gx, gz + 1);
          const d = vert(gx + 1, gz + 1);
          idx.push(a, c, b, b, c, d);
        }
    }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('aMask', new BufferAttribute(new Float32Array(mask), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Paving texture: one texel per tile, 255 under complete buildings. */
export class PaveMap {
  readonly texture: DataTexture;
  private readonly data: Uint8Array;
  private readonly next: Uint8Array;

  constructor(readonly w: number, readonly h: number) {
    this.data = new Uint8Array(w * h);
    this.next = new Uint8Array(w * h);
    this.texture = new DataTexture(this.data, w, h, RedFormat, UnsignedByteType);
    this.texture.magFilter = LinearFilter;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
    this.texture.name = 'pave';
  }

  /** Sets the paved tiles; uploads only when they changed. Returns true on a change. */
  update(count: number, tx: Int16Array, ty: Int16Array, fw: Uint8Array, fh: Uint8Array, paved: (row: number) => boolean): boolean {
    const n = this.next;
    n.fill(0);
    for (let r = 0; r < count; r++) {
      if (!paved(r)) continue;
      for (let j = 0; j < fh[r]!; j++)
        for (let i = 0; i < fw[r]!; i++) {
          const x = tx[r]! + i;
          const z = ty[r]! + j;
          if (x >= 0 && z >= 0 && x < this.w && z < this.h) n[z * this.w + x] = 255;
        }
    }
    let same = true;
    for (let i = 0; i < n.length; i++)
      if (n[i] !== this.data[i]) {
        same = false;
        break;
      }
    if (same) return false;
    this.data.set(n);
    this.texture.needsUpdate = true;
    return true;
  }
}

export interface GroundMeshes {
  ground: Mesh;
  outcrops: Mesh;
  info: GroundGeometry;
}

/** Ground and outcrop meshes with a material (W17's terrain material in the game; any in tests). */
export function buildGroundMeshes(t: Terrain, material: Material): GroundMeshes {
  const info = buildGroundGeometry(t);
  const ground = new Mesh(info.geometry, material);
  ground.name = 'terrain/ground';
  ground.receiveShadow = true;
  const outcrops = new Mesh(buildOutcropGeometry(t), material);
  outcrops.name = 'terrain/outcrops';
  outcrops.receiveShadow = true;
  outcrops.castShadow = true;
  return { ground, outcrops, info };
}
