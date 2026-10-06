// Geometry kit for code-built models: chamfered blocks and prisms (ExtrudeGeometry with a single
// bevel segment), tapered blocks, gears, lathes and tubes. A Builder collects parts per material,
// box-projects UVs in tile units and merges them into one geometry with one group per material.
// Chamfer faces get the vertex attribute `wear` = 1, which the ivory and hull materials turn into
// chipped edges.

import {
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  LatheGeometry,
  Matrix4,
  Quaternion,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MatKey, Mats } from './materials.ts';

export interface Tf {
  x?: number;
  y?: number;
  z?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  s?: number;
  sx?: number;
  sy?: number;
  sz?: number;
}

export function tfMatrix(t: Tf): Matrix4 {
  const m = new Matrix4();
  const q = new Quaternion().setFromEuler(new Euler(t.rx ?? 0, t.ry ?? 0, t.rz ?? 0, 'YXZ'));
  const s = t.s ?? 1;
  m.compose(new Vector3(t.x ?? 0, t.y ?? 0, t.z ?? 0), q, new Vector3((t.sx ?? 1) * s, (t.sy ?? 1) * s, (t.sz ?? 1) * s));
  return m;
}

// ---- shapes -----------------------------------------------------------------------------------

function polyShape(pts: Array<[number, number]>): Shape {
  const s = new Shape();
  pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  s.closePath();
  return s;
}

/** Rectangle w × d with corners cut by `k` (k = 0: plain rectangle). */
function rectShape(w: number, d: number, k: number): Shape {
  const a = w / 2;
  const b = d / 2;
  if (k <= 0) return polyShape([[-a, -b], [a, -b], [a, b], [-a, b]]);
  return polyShape([[-a + k, -b], [a - k, -b], [a, -b + k], [a, b - k], [a - k, b], [-a + k, b], [-a, b - k], [-a, -b + k]]);
}

/** Extrudes `shape` (XY) upwards along +Y to height h with a chamfer c on top and bottom edges. */
function extrudeUp(shape: Shape, h: number, c: number): BufferGeometry {
  const g = new ExtrudeGeometry(shape, {
    depth: Math.max(0.001, h - 2 * c),
    bevelEnabled: c > 0,
    bevelThickness: c,
    bevelSize: c,
    bevelOffset: -c,
    bevelSegments: 1,
    curveSegments: 1,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, c, 0);
  g.deleteAttribute('uv');
  g.userData.chamfered = true;
  return g;
}

/** Chamfered box, base on y = 0. `corner` cuts the vertical edges, `c` chamfers top and bottom edges. */
export function cbox(w: number, h: number, d: number, c = 0.05, corner = c): BufferGeometry {
  return extrudeUp(rectShape(w, d, corner), h, Math.min(c, h / 2.2));
}

/** Regular prism with `n` sides of circumradius r (flat side facing +X when `flat`). */
export function prism(n: number, r: number, h: number, c = 0.04, flat = true): BufferGeometry {
  const pts: Array<[number, number]> = [];
  const off = flat ? Math.PI / n : 0;
  for (let i = 0; i < n; i++) {
    const a = off + (i / n) * Math.PI * 2;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return extrudeUp(polyShape(pts), h, Math.min(c, h / 2.2));
}

/** Any outline (XY points, counter-clockwise) extruded up. */
export function slab(pts: Array<[number, number]>, h: number, c = 0.04): BufferGeometry {
  return extrudeUp(polyShape(pts), h, Math.min(c, h / 2.2));
}

/** Scales x/z of every vertex by lerp(1, top, y / h): tapered blocks and pyramids. */
export function taper(g: BufferGeometry, top: number, h?: number): BufferGeometry {
  const p = g.getAttribute('position') as BufferAttribute;
  g.computeBoundingBox();
  const y0 = g.boundingBox!.min.y;
  const hh = h ?? g.boundingBox!.max.y - y0;
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) - y0) / hh;
    const s = 1 + (top - 1) * t;
    p.setX(i, p.getX(i) * s);
    p.setZ(i, p.getZ(i) * s);
  }
  g.computeVertexNormals();
  return g;
}

/** Side profile (XY, x forward) extruded across Z by width w: wedges, angled armour. */
export function profile(pts: Array<[number, number]>, w: number, c = 0.04): BufferGeometry {
  const s = polyShape(pts);
  const g = new ExtrudeGeometry(s, { depth: Math.max(0.001, w - 2 * c), bevelEnabled: c > 0, bevelThickness: c, bevelSize: c, bevelOffset: -c, bevelSegments: 1, curveSegments: 1 });
  g.translate(0, 0, -(w - 2 * c) / 2);
  g.deleteAttribute('uv');
  g.userData.chamfered = true;
  return g;
}

export function cyl(rTop: number, rBot: number, h: number, seg = 16, open = false): BufferGeometry {
  const g = new CylinderGeometry(rTop, rBot, h, seg, 1, open);
  g.translate(0, h / 2, 0);
  return g;
}

/** Cylinder lying along +X, starting at x = 0. */
export function tubeX(r: number, len: number, seg = 16, r2 = r): BufferGeometry {
  const g = new CylinderGeometry(r2, r, len, seg, 1, false);
  g.rotateZ(-Math.PI / 2);
  g.translate(len / 2, 0, 0);
  return g;
}

export function sphere(r: number, w = 16, h = 10, cap = Math.PI): BufferGeometry {
  return new SphereGeometry(r, w, h, 0, Math.PI * 2, 0, cap);
}

export function torus(r: number, tube: number, rs = 8, ts = 24): BufferGeometry {
  const g = new TorusGeometry(r, tube, rs, ts);
  g.rotateX(Math.PI / 2);
  return g;
}

export function lathe(pts: Array<[number, number]>, seg = 24): BufferGeometry {
  return new LatheGeometry(pts.map(([r, y]) => new Vector2(r, y)), seg);
}

/** Toothed ring (slewing ring / gear) of height h. */
export function gear(rIn: number, rOut: number, teeth: number, h: number, toothDepth = 0.06): BufferGeometry {
  const s = new Shape();
  const n = teeth * 4;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = i % 4 < 2 ? rOut : rOut - toothDepth;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  const hole = new Shape();
  for (let i = 0; i < 48; i++) {
    const a = -(i / 48) * Math.PI * 2;
    const x = Math.cos(a) * rIn;
    const y = Math.sin(a) * rIn;
    if (i === 0) hole.moveTo(x, y);
    else hole.lineTo(x, y);
  }
  s.holes.push(hole);
  const g = new ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 1 });
  g.rotateX(-Math.PI / 2);
  g.deleteAttribute('uv');
  return g;
}

/** Hex bolt head (small prism) standing on y = 0. */
export function bolt(r = 0.05, h = 0.03): BufferGeometry {
  return prism(6, r, h, 0.008);
}

// ---- builder ----------------------------------------------------------------------------------

const _n = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _t1 = new Vector3();
const _t2 = new Vector3();

/** Non-indexed copy with per-face box-projected UVs (tile units) and a per-face `wear` flag. */
function finish(g: BufferGeometry, wearEdges: boolean): BufferGeometry {
  const chamfered = !!g.userData.chamfered;
  const ng = g.index ? g.toNonIndexed() : g;
  if (!ng.getAttribute('normal')) ng.computeVertexNormals();
  const p = ng.getAttribute('position') as BufferAttribute;
  const uv = new Float32Array(p.count * 2);
  const wear = new Float32Array(p.count);
  for (let i = 0; i < p.count; i += 3) {
    _a.fromBufferAttribute(p, i);
    _b.fromBufferAttribute(p, i + 1);
    _c.fromBufferAttribute(p, i + 2);
    _n.subVectors(_c, _b).cross(_a.clone().sub(_b)).normalize();
    const ax = Math.abs(_n.x);
    const ay = Math.abs(_n.y);
    const az = Math.abs(_n.z);
    // chamfer strips are thin: area / longest edge (≈ strip width) below 0.07 tiles
    const ab = _a.distanceTo(_b);
    const bc = _b.distanceTo(_c);
    const ca = _c.distanceTo(_a);
    const area = _t1.subVectors(_b, _a).cross(_t2.subVectors(_c, _a)).length() / 2;
    const width = (2 * area) / Math.max(ab, bc, ca, 1e-6);
    const w = wearEdges && chamfered && Math.max(ax, ay, az) < 0.97 && width < 0.07 ? 1 : 0;
    for (let k = 0; k < 3; k++) {
      const v = k === 0 ? _a : k === 1 ? _b : _c;
      let u0: number;
      let v0: number;
      if (ay >= ax && ay >= az) {
        u0 = v.x;
        v0 = v.z;
      } else if (ax >= az) {
        u0 = v.z;
        v0 = v.y;
      } else {
        u0 = v.x;
        v0 = v.y;
      }
      uv[(i + k) * 2] = u0;
      uv[(i + k) * 2 + 1] = v0;
      wear[i + k] = w;
    }
  }
  ng.setAttribute('uv', new BufferAttribute(uv, 2));
  ng.setAttribute('wear', new BufferAttribute(wear, 1));
  for (const name of Object.keys(ng.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'wear') ng.deleteAttribute(name);
  ng.clearGroups();
  return ng;
}

export class Builder {
  private byMat = new Map<MatKey, BufferGeometry[]>();
  constructor(private mats: Mats) {}

  add(mat: MatKey, geo: BufferGeometry, t: Tf | Matrix4 = {}, opts: { wear?: boolean } = {}): this {
    const m = t instanceof Matrix4 ? t : tfMatrix(t);
    const g = geo.clone();
    g.applyMatrix4(m);
    const wear = opts.wear ?? (mat === 'ivory' || mat === 'hull');
    const list = this.byMat.get(mat) ?? [];
    list.push(finish(g, wear));
    this.byMat.set(mat, list);
    return this;
  }

  /** Mirror-copies everything added by `fn` across the XY plane (z → -z). */
  mirrorZ(fn: (b: Builder) => void): this {
    fn(this);
    const flip = new Matrix4().makeScale(1, 1, -1);
    const tmp = new Builder(this.mats);
    fn(tmp);
    for (const [mat, list] of tmp.byMat) {
      for (const g of list) {
        g.applyMatrix4(flip);
        // flip winding
        const p = g.getAttribute('position') as BufferAttribute;
        const n = g.getAttribute('normal') as BufferAttribute;
        const uv = g.getAttribute('uv') as BufferAttribute;
        const w = g.getAttribute('wear') as BufferAttribute;
        for (let i = 0; i < p.count; i += 3) {
          for (const attr of [p, n, uv, w]) {
            const s = attr.itemSize;
            for (let c = 0; c < s; c++) {
              const a = attr.array[(i + 1) * s + c]!;
              (attr.array as Float32Array)[(i + 1) * s + c] = attr.array[(i + 2) * s + c]!;
              (attr.array as Float32Array)[(i + 2) * s + c] = a;
            }
          }
        }
        const list2 = this.byMat.get(mat) ?? [];
        list2.push(g);
        this.byMat.set(mat, list2);
      }
    }
    return this;
  }

  get empty(): boolean {
    return this.byMat.size === 0;
  }

  /** One geometry, one group per material, plus the matching material array. */
  build(): { geometry: BufferGeometry; material: Material[] } {
    const geos: BufferGeometry[] = [];
    const mats: Material[] = [];
    for (const [k, list] of this.byMat) {
      geos.push(mergeGeometries(list, false)!);
      mats.push(this.mats[k]);
    }
    const geometry = mergeGeometries(geos, true)!;
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    return { geometry, material: mats };
  }
}
