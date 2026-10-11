// The stress scene's ground and layout on W17's map 1 terrain (base centre at tile 64, 64; the
// plateau runs out to the canyon rim about 34 tiles out on the north and east, further on the
// west and south).
//
//   Ground height: bilinear on the W17 terrain mesh's own vertex grid (its x and z sample rows are
//   read back from the mesh), so aliens, casings and shells meet the drawn surface without calling
//   the analytic heightfield (≈2.5 µs a sample) thousands of times a frame.
//   Turret sites: a hex grid at 2.6-tile spacing (2-tile footprint; the 1.55-tile barrel clears a
//   neighbour's head as it slews) over flat plateau ground, nearest the base centre first, so 50
//   turrets are a tight core and 500 fill the plateau.
//   Lanes: five approaches from different bearings — W17's north and east canyon corridors (they
//   climb to the plateau on ramps) and three over the open upland to the west and south — each
//   ending on a hold ring just outside the outermost turret.

import type { BufferAttribute, Mesh } from 'three';
import { BASE } from '../world/layout.ts';
import { PATHS } from '../world/heightfield.ts';

export class Ground {
  private xs: Float64Array;
  private zs: Float64Array;
  private h: Float32Array;
  private n: number;
  /** Fine lookup: index of the sample row at or below x (step 0.25 tiles). */
  private ix: Int32Array;
  private iz: Int32Array;
  private x0: number;
  private z0: number;
  private static STEP = 0.25;

  constructor(terrain: Mesh) {
    const p = terrain.geometry.getAttribute('position') as BufferAttribute;
    const s = Math.round(Math.sqrt(p.count));
    this.n = s;
    this.xs = new Float64Array(s);
    this.zs = new Float64Array(s);
    for (let i = 0; i < s; i++) this.xs[i] = p.getX(i);
    for (let j = 0; j < s; j++) this.zs[j] = p.getZ(j * s);
    this.h = new Float32Array(s * s);
    for (let k = 0; k < s * s; k++) this.h[k] = p.getY(k);
    this.x0 = this.xs[0]!;
    this.z0 = this.zs[0]!;
    this.ix = this.table(this.xs);
    this.iz = this.table(this.zs);
  }

  private table(v: Float64Array): Int32Array {
    const a = v[0]!;
    const b = v[v.length - 1]!;
    const n = Math.ceil((b - a) / Ground.STEP) + 1;
    const t = new Int32Array(n);
    let j = 0;
    for (let k = 0; k < n; k++) {
      const x = a + k * Ground.STEP;
      while (j < v.length - 2 && v[j + 1]! <= x) j++;
      t[k] = j;
    }
    return t;
  }

  private seg(v: Float64Array, t: Int32Array, a: number, x: number): number {
    let k = Math.floor((x - a) / Ground.STEP);
    if (k < 0) k = 0;
    else if (k >= t.length) k = t.length - 1;
    let j = t[k]!;
    while (j < v.length - 2 && v[j + 1]! <= x) j++;
    return j;
  }

  height(x: number, z: number): number {
    const i = this.seg(this.xs, this.ix, this.x0, x);
    const j = this.seg(this.zs, this.iz, this.z0, z);
    const x0 = this.xs[i]!;
    const x1 = this.xs[i + 1]!;
    const z0 = this.zs[j]!;
    const z1 = this.zs[j + 1]!;
    const u = Math.max(0, Math.min(1, (x - x0) / (x1 - x0)));
    const w = Math.max(0, Math.min(1, (z - z0) / (z1 - z0)));
    const s = this.n;
    const h00 = this.h[j * s + i]!;
    const h10 = this.h[j * s + i + 1]!;
    const h01 = this.h[(j + 1) * s + i]!;
    const h11 = this.h[(j + 1) * s + i + 1]!;
    return (h00 * (1 - u) + h10 * u) * (1 - w) + (h01 * (1 - u) + h11 * u) * w;
  }
}

export interface Site {
  x: number;
  y: number;
  z: number;
  /** Distance from the base centre. */
  r: number;
}

export const SPACING = 2.6;
export const MAX_TURRETS = 500;

/** Flat plateau sites on a hex grid, nearest the base centre first. */
export function turretSites(ground: Ground, max = MAX_TURRETS): Site[] {
  const out: Site[] = [];
  const dz = SPACING * Math.sqrt(3) / 2;
  for (let row = -24; row <= 24; row++) {
    for (let col = -24; col <= 24; col++) {
      const x = BASE.x + col * SPACING + (row & 1 ? SPACING / 2 : 0);
      const z = BASE.z + row * dz;
      const r = Math.hypot(x - BASE.x, z - BASE.z);
      if (r > 48) continue;
      // the footprint and the barrel's sweep must sit on flat plateau ground
      let lo = Infinity;
      let hi = -Infinity;
      for (const [ox, oz] of [[0, 0], [1.1, 0], [-1.1, 0], [0, 1.1], [0, -1.1], [0.8, 0.8], [-0.8, 0.8], [0.8, -0.8], [-0.8, -0.8], [1.6, 0], [-1.6, 0], [0, 1.6], [0, -1.6]] as const) {
        const h = ground.height(x + ox, z + oz);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
      if (hi - lo > 0.3 || lo < -0.6 || hi > 0.6) continue;
      out.push({ x, y: hi, z, r });
    }
  }
  out.sort((a, b) => a.r - b.r || a.z - b.z || a.x - b.x);
  return out.slice(0, max);
}

/** Bearing (turret convention: direction (cos b, 0, −sin b)) from the base centre, degrees. */
export interface Lane {
  name: string;
  /** Approach polyline (x, z) before the last leg to the hold point. */
  approach: Array<[number, number]>;
  bearing: number;
}

const dir = (deg: number, r: number): [number, number] => [BASE.x + Math.cos((deg * Math.PI) / 180) * r, BASE.z - Math.sin((deg * Math.PI) / 180) * r];

export const LANES: Lane[] = [
  { name: 'north corridor', approach: [[PATHS.north[0]!.x, PATHS.north[0]!.z - 20], [PATHS.north[1]!.x, PATHS.north[1]!.z]], bearing: 90 },
  { name: 'east corridor', approach: [[PATHS.east[0]!.x + 10, PATHS.east[0]!.z], [PATHS.east[1]!.x, PATHS.east[1]!.z]], bearing: 0 },
  { name: 'west-north-west', approach: [dir(157.5, 125), dir(157.5, 70)], bearing: 157.5 },
  { name: 'south-west', approach: [dir(225, 125), dir(225, 70)], bearing: 225 },
  { name: 'south-south-west', approach: [dir(247.5, 120), dir(247.5, 70)], bearing: 247.5 },
];

export { BASE };
