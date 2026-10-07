// A small canyon range for the turret bench, built the W17 way at small scale: an analytic
// heightfield (an open arena round the turret, three gullies leading in, terraced canyon walls),
// drawn with W17's terrain material (cliff photo with height strata on steep faces, sand photo on
// the flats, dark rock in the gullies, pale compacted ground round the turret), boulders at the
// wall feet, and a faint ring on the ground at the turret's range.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Euler,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  ShaderMaterial,
  Quaternion,
  Vector3,
} from 'three';
import type { TextureBank } from '../assets/textures.ts';
import { Builder } from '../models/kit.ts';
import type { Mats } from '../models/materials.ts';
import { Rand, fbm, noise2, smoothstep } from '../noise.ts';
import { terrainMaterial } from '../world/terrainMesh.ts';

/** Gully bearings (world angle a ↔ direction (cos a, 0, −sin a)), degrees. */
export const GULLIES = [0, 52, -58];
const ARENA_R = 31;
const GULLY_LEN = 92;
const WALL_H = 9;

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): { d: number; t: number } {
  const vx = bx - ax;
  const vz = bz - az;
  const l2 = vx * vx + vz * vz;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / l2));
  return { d: Math.hypot(px - ax - vx * t, pz - az - vz * t), t };
}

/** Signed distance to the open floor (negative inside the arena or a gully). */
function openSdf(x: number, z: number): number {
  let d = Math.hypot(x, z) - ARENA_R - 3 * noise2(x * 0.05 + 3, z * 0.05);
  for (const deg of GULLIES) {
    const a = (deg * Math.PI) / 180;
    const s = segDist(x, z, 0, 0, Math.cos(a) * GULLY_LEN, -Math.sin(a) * GULLY_LEN);
    const w = 7.5 + 2.5 * noise2(s.t * 6 + deg, 1.7);
    d = Math.min(d, s.d - w);
  }
  return d;
}

function terrace(h: number, step: number): number {
  const k = h / step;
  const f = k - Math.floor(k);
  return (Math.floor(k) + smoothstep(0.62, 0.95, f)) * step;
}

export function rangeHeight(x: number, z: number): number {
  const d = openSdf(x, z) + 2.2 * fbm(x * 0.08, z * 0.08, 3);
  const wall = smoothstep(0, 7, d);
  const top = WALL_H * (0.85 + 0.25 * fbm(x * 0.02 + 9, z * 0.02, 2));
  let h = terrace(wall * top, 1.7);
  // floor: gentle undulation, flat round the turret
  const r = Math.hypot(x, z);
  h += 0.35 * fbm(x * 0.06 + 4, z * 0.06 - 2, 3) * smoothstep(4, 12, r) * (1 - wall);
  return h;
}

/** Ray against the heightfield (ray marching, then bisection). Returns null if it never lands. */
export function rayGround(o: Vector3, d: Vector3, maxT = 400): Vector3 | null {
  let t = 0;
  let prev = 0;
  const p = new Vector3();
  const above = (tt: number) => {
    p.copy(o).addScaledVector(d, tt);
    return p.y - rangeHeight(p.x, p.z);
  };
  if (above(0) < 0) return null;
  while (t < maxT) {
    prev = t;
    const gap = above(t);
    t += Math.max(0.05, gap * 0.5);
    if (above(t) < 0) {
      let a = prev;
      let b = t;
      for (let i = 0; i < 30; i++) {
        const m = (a + b) / 2;
        if (above(m) > 0) a = m;
        else b = m;
      }
      return new Vector3().copy(o).addScaledVector(d, b);
    }
  }
  return null;
}

export interface RangeBuild {
  group: Group;
  terrain: Mesh;
  ring: Mesh;
  triangles: number;
}

export function buildRange(bank: TextureBank, mats: Mats, range: number): RangeBuild {
  const group = new Group();
  // grid: 0.5 tiles near the arena, coarser out to the far gully ends
  const X0 = -70;
  const X1 = 100;
  const Z0 = -90;
  const Z1 = 90;
  const axis = (a0: number, a1: number, n: number) => {
    const out: number[] = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      // denser in the middle third
      const s = u + 0.18 * Math.sin((u - 0.5) * Math.PI * 2) / Math.PI;
      out.push(a0 + (a1 - a0) * s);
    }
    return out;
  };
  const xs = axis(X0, X1, 300);
  const zs = axis(Z0, Z1, 300);
  const nx = xs.length;
  const nz = zs.length;
  const pos = new Float32Array(nx * nz * 3);
  const mask = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const x = xs[i]!;
      const z = zs[j]!;
      const h = rangeHeight(x, z);
      const k = (j * nx + i) * 3;
      pos[k] = x;
      pos[k + 1] = h;
      pos[k + 2] = z;
      const e = 0.6;
      const slope = Math.hypot(rangeHeight(x + e, z) - rangeHeight(x - e, z), rangeHeight(x, z + e) - rangeHeight(x, z - e)) / (2 * e);
      const r = Math.hypot(x, z);
      const sd = openSdf(x, z);
      mask[k] = smoothstep(-6, 0, sd) * (1 - smoothstep(0, 4, sd)) * 0.9; // dark rock at the wall feet
      mask[k + 1] = 1 - smoothstep(3.5, 7, r); // pale compacted ground round the turret
      mask[k + 2] = smoothstep(0.35, 0.8, slope);
    }
  const idx: number[] = [];
  for (let j = 0; j + 1 < nz; j++)
    for (let i = 0; i + 1 < nx; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      const h1 = Math.abs(pos[a * 3 + 1]! - pos[d * 3 + 1]!);
      const h2 = Math.abs(pos[b * 3 + 1]! - pos[c * 3 + 1]!);
      if (h1 <= h2) idx.push(a, c, d, a, d, b);
      else idx.push(a, c, b, b, c, d);
    }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('aMask', new BufferAttribute(mask, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const terrain = new Mesh(g, terrainMaterial(bank));
  terrain.receiveShadow = true;
  terrain.castShadow = true;
  terrain.name = 'range-terrain';
  group.add(terrain);

  // boulders at the wall feet and a few on the floor
  const r = new Rand(2020);
  const boulders: Matrix4[] = [];
  const q = new Quaternion();
  for (let k = 0; k < 20000 && boulders.length < 380; k++) {
    const x = r.range(X0 + 5, X1 - 5);
    const z = r.range(Z0 + 5, Z1 - 5);
    const sd = openSdf(x, z);
    if (Math.hypot(x, z) < 9) continue;
    if (!(sd > -3 && sd < 2.5) && r.next() > 0.03) continue;
    const s = r.range(0.25, 1.1);
    q.setFromEuler(new Euler(r.range(-0.5, 0.5), r.range(0, 6.28), r.range(-0.5, 0.5)));
    boulders.push(new Matrix4().compose(new Vector3(x, rangeHeight(x, z) - s * 0.2, z), q.clone(), new Vector3(s * r.range(0.8, 1.5), s, s * r.range(0.8, 1.3))));
  }
  const lumpy = new IcosahedronGeometry(1, 1);
  const lp = lumpy.getAttribute('position') as BufferAttribute;
  const cache = new Map<string, number>();
  for (let i = 0; i < lp.count; i++) {
    const key = `${lp.getX(i).toFixed(3)},${lp.getY(i).toFixed(3)},${lp.getZ(i).toFixed(3)}`;
    let k = cache.get(key);
    if (k === undefined) cache.set(key, (k = 1 + r.range(-0.3, 0.3)));
    lp.setXYZ(i, lp.getX(i) * k, lp.getY(i) * k * 0.7, lp.getZ(i) * k);
  }
  lumpy.computeVertexNormals();
  const bg = new Builder(mats).add('rock', lumpy, {}, { wear: false }).build();
  const bm = new InstancedMesh(bg.geometry, bg.material, boulders.length);
  boulders.forEach((m, i) => bm.setMatrixAt(i, m));
  bm.castShadow = bm.receiveShadow = true;
  bm.computeBoundingSphere();
  group.add(bm);

  // range ring: a soft cyan band following the ground
  const ring = rangeRing(range);
  group.add(ring);
  return { group, terrain, ring, triangles: idx.length / 3 };
}

function rangeRing(range: number): Mesh {
  const n = 256;
  const widths = [-0.7, -0.08, 0.08, 0.7];
  const pos: number[] = [];
  const edge: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    for (const w of widths) {
      const rr = range + w;
      const x = Math.cos(a) * rr;
      const z = -Math.sin(a) * rr;
      pos.push(x, rangeHeight(x, z) + 0.06, z);
      edge.push(Math.abs(w) < 0.1 ? 1 : 0);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      const a = i * 4 + k;
      const b = a + 1;
      const c = a + 4;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('aEdge', new BufferAttribute(new Float32Array(edge), 1));
  g.setIndex(idx);
  const m = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { uCol: { value: new Color(0.25, 0.8, 1.0) }, uAlpha: { value: 0.55 } },
    vertexShader: /* glsl */ `attribute float aEdge; varying float vE; void main(){ vE = aEdge; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `uniform vec3 uCol; uniform float uAlpha; varying float vE; void main(){ float k = 0.12 + 0.88 * vE * vE * vE; gl_FragColor = vec4(uCol * k * uAlpha, 1.0); }`,
  });
  const mesh = new Mesh(g, m);
  mesh.renderOrder = 5;
  mesh.name = 'range-ring';
  return mesh;
}
