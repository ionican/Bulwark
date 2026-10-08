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
import { TILE_ROCK, type Terrain } from '../sim/terrain.ts';
import { groundHeight } from './ground.ts';
import { fbm, smoothstep } from './workshop/noise.ts';

/** Distances of the scenery rings from the map edge (tiles). Ring 0 is the edge itself. */
export const SCENERY_RINGS = [
  0, 1, 2, 3, 4.5, 6, 8, 10, 12.5, 15, 18, 21.5, 25, 29, 33, 37.5, 42, 47, 52, 58, 64, 71, 78, 86, 95, 105, 116, 128, 142, 158, 176, 196, 220, 250, 290, 340,
];

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

const terrace = (h: number, step: number) => {
  const k = Math.floor(h / step);
  const f = h / step - k;
  return (k + smoothstep(0.62, 0.95, f)) * step;
};

/**
 * Scenery height at distance d beyond the edge, world (x, z); `edgeH` is the edge vertex's height.
 * North-east of the map (where the waves come from) the plateau ends in a cliff over a canyon floor
 * whose far side climbs in terraces; south-west the land climbs in terraces straight from the edge.
 * Each entry has a corridor: a ramp from the map edge down to the canyon floor. Within the first
 * few tiles everything blends from the edge height, which the edge vertex keeps exactly.
 */
function sceneryHeight(t: Terrain, x: number, z: number, d: number, edgeH: number): number {
  const n1 = fbm(x * 0.021, z * 0.021, 4) * 0.5 + 0.5;
  const n2 = fbm(x * 0.06 + 17, z * 0.06 - 5, 3) * 0.5 + 0.5;
  const floor = -5.5 + 1.2 * (n2 - 0.5);
  const rise = terrace(edgeH + (3 + 9 * n1) * smoothstep(3, 40, d) + 4 * n2 * smoothstep(30, 110, d), 1.6);
  const drop = terrace(floor + (5 + 11 * n1) * smoothstep(26, 110, d) + 3 * n2 * smoothstep(60, 160, d), 1.7);
  // north-east-ness of the direction from the map centre (north is −z)
  const vx = x - t.w / 2;
  const vz = z - t.h / 2;
  const ne = (vx - vz) / (Math.SQRT2 * (Math.hypot(vx, vz) || 1));
  let h = rise + (drop - rise) * smoothstep(-0.25, 0.35, ne);
  for (const e of t.entries) {
    const px = x - e.x;
    const pz = z - e.z;
    const along = -(px * e.dirX + pz * e.dirZ);
    const across = Math.abs(px * e.dirZ - pz * e.dirX);
    if (along < -6) continue;
    const width = 8 + 4 * n2 + Math.max(0, along) * 0.08;
    const k = 1 - smoothstep(width, width + 6, across);
    const ramp = edgeH + (floor - 0.3 - edgeH) * smoothstep(4, 55, along);
    h = h + (ramp - h) * k;
  }
  return edgeH + (h - edgeH) * smoothstep(0, 4, d);
}

/** Weathering mask from noise (the dark rock patches of W17's material). */
function darkAt(x: number, z: number): number {
  return smoothstep(0.58, 0.82, fbm(x * 0.07 + 3.1, z * 0.07 - 1.7, 3) * 0.5 + 0.5) * 0.55;
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
  // rings 1 … n: each perimeter sample pushed straight out (corners diagonally)
  const cx = t.w / 2;
  const cz = t.h / 2;
  for (let r = 1; r <= rings; r++) {
    const d = SCENERY_RINGS[r]!;
    per.forEach(([x, z], k) => {
      const ox = x <= 0 ? -d : x >= t.w ? d : 0;
      const oz = z <= 0 ? -d : z >= t.h ? d : 0;
      // spread the far rings a little so the corners do not pinch
      const wx = x + ox + (x - cx) * (d / 600);
      const wz = z + oz + (z - cz) * (d / 600);
      const v = mapVertices + (r - 1) * P + k;
      const edgeH = t.heights[edge[k]!]!;
      pos[v * 3] = wx;
      pos[v * 3 + 1] = sceneryHeight(t, wx, wz, d, edgeH);
      pos[v * 3 + 2] = wz;
      mask[v * 3] = darkAt(wx, wz);
      mask[v * 3 + 1] = 0;
      mask[v * 3 + 2] = smoothstep(3, 12, d);
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
