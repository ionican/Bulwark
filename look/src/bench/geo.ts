// Geometry helpers for the W20 turret. Builds on the W17 kit (look/src/models/kit.ts) with:
//   - a builder keyed by the turret's five materials that judges edge wear on each piece BEFORE it
//     is placed (so a rotated box does not count as all-edge), and box-projects UVs AFTER placing
//     (so texture runs continuously across neighbouring pieces of one part);
//   - lathe "bands" (one LatheGeometry per profile segment) so turned parts keep hard edges, with
//     wear flagged on the chamfer bands only;
//   - toothed rings with trapezoid teeth and chamfered edges, annular sectors, polygon offset and
//     clipping for split armour plates, and a wedge transform that fits panels to an octagon.

import { BufferAttribute, BufferGeometry, ExtrudeGeometry, LatheGeometry, Matrix4, Quaternion, Shape, Vector2, Vector3, type Material } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { tfMatrix, type Tf } from '../models/kit.ts';
import type { TurretMats } from './surface.ts';

export type TKey = 'ceramic' | 'gunmetal' | 'bronze' | 'dark' | 'glow';
export type Pt = [number, number];
type WearMode = 'auto' | 'all' | 'none';

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _n = new Vector3();
const _t1 = new Vector3();
const _t2 = new Vector3();

/** Per-face wear flag from the unplaced piece: thin, non-axis-aligned faces of chamfered shapes. */
function wearFlags(g: BufferGeometry, mode: WearMode): Float32Array {
  const p = g.getAttribute('position') as BufferAttribute;
  const out = new Float32Array(p.count);
  if (mode === 'none') return out;
  if (mode === 'all') return out.fill(1);
  if (!g.userData.chamfered) return out;
  for (let i = 0; i < p.count; i += 3) {
    _a.fromBufferAttribute(p, i);
    _b.fromBufferAttribute(p, i + 1);
    _c.fromBufferAttribute(p, i + 2);
    _n.subVectors(_c, _b).cross(_t1.subVectors(_a, _b)).normalize();
    const m = Math.max(Math.abs(_n.x), Math.abs(_n.y), Math.abs(_n.z));
    const area = _t1.subVectors(_b, _a).cross(_t2.subVectors(_c, _a)).length() / 2;
    const width = (2 * area) / Math.max(_a.distanceTo(_b), _b.distanceTo(_c), _c.distanceTo(_a), 1e-6);
    const w = m < 0.97 && width < 0.035 ? 1 : 0;
    out[i] = out[i + 1] = out[i + 2] = w;
  }
  return out;
}

/** Non-indexed, placed, with box-projected UVs (tile units) and the `wear` attribute. */
export function finishPiece(src: BufferGeometry, m: Matrix4, mode: WearMode): BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src.clone();
  g.userData.chamfered = src.userData.chamfered;
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const wear = wearFlags(g, mode);
  g.applyMatrix4(m);
  const p = g.getAttribute('position') as BufferAttribute;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i += 3) {
    _a.fromBufferAttribute(p, i);
    _b.fromBufferAttribute(p, i + 1);
    _c.fromBufferAttribute(p, i + 2);
    _n.subVectors(_c, _b).cross(_t1.subVectors(_a, _b));
    const ax = Math.abs(_n.x);
    const ay = Math.abs(_n.y);
    const az = Math.abs(_n.z);
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
    }
  }
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setAttribute('wear', new BufferAttribute(wear, 1));
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'wear'].includes(name)) g.deleteAttribute(name);
  g.clearGroups();
  return g;
}

export interface BoltSpec {
  key: 'bronze' | 'gunmetal' | 'dark';
  /** Placement: position, the bolt's axis (+Y of the bolt) and head radius. */
  pos: [number, number, number];
  axis: [number, number, number];
  r: number;
  /** Spin about the axis, rad (hex orientation). */
  spin?: number;
}

export class TB {
  private byKey = new Map<TKey, BufferGeometry[]>();
  readonly bolts: BoltSpec[] = [];

  add(key: TKey, geo: BufferGeometry, t: Tf | Matrix4 = {}, wear: WearMode = key === 'dark' || key === 'glow' ? 'none' : 'auto'): this {
    const m = t instanceof Matrix4 ? t : tfMatrix(t);
    const list = this.byKey.get(key) ?? [];
    list.push(finishPiece(geo, m, wear));
    this.byKey.set(key, list);
    return this;
  }

  bolt(key: BoltSpec['key'], pos: [number, number, number], r: number, axis: [number, number, number] = [0, 1, 0], spin = 0): this {
    this.bolts.push({ key, pos, axis, r, spin });
    return this;
  }

  /** Runs `fn` twice, the second time mirrored across z = 0 (pieces and bolts). */
  mirrorZ(fn: (b: TB) => void): this {
    fn(this);
    const tmp = new TB();
    fn(tmp);
    const flip = new Matrix4().makeScale(1, 1, -1);
    for (const [k, list] of tmp.byKey) {
      for (const g of list) {
        g.applyMatrix4(flip);
        // mirroring flips the winding: swap the 2nd and 3rd vertex of every triangle
        for (const name of ['position', 'normal', 'uv', 'wear']) {
          const attr = g.getAttribute(name) as BufferAttribute;
          const s = attr.itemSize;
          const arr = attr.array as Float32Array;
          for (let i = 0; i < attr.count; i += 3)
            for (let c = 0; c < s; c++) {
              const t = arr[(i + 1) * s + c]!;
              arr[(i + 1) * s + c] = arr[(i + 2) * s + c]!;
              arr[(i + 2) * s + c] = t;
            }
        }
        const l2 = this.byKey.get(k) ?? [];
        l2.push(g);
        this.byKey.set(k, l2);
      }
    }
    for (const b of tmp.bolts) this.bolts.push({ ...b, pos: [b.pos[0], b.pos[1], -b.pos[2]], axis: [b.axis[0], b.axis[1], -b.axis[2]], spin: -(b.spin ?? 0) });
    return this;
  }

  /** All pieces merged into one geometry, no groups (for single-material instanced meshes). */
  geometryOnly(): BufferGeometry {
    const g = mergeGeometries([...this.byKey.values()].flat(), false)!;
    g.computeBoundingSphere();
    return g;
  }

  build(mats: TurretMats): { geometry: BufferGeometry; material: Material[] } {
    const geos: BufferGeometry[] = [];
    const material: Material[] = [];
    const lookup: Record<TKey, Material> = { ceramic: mats.ceramic, gunmetal: mats.gunmetal, bronze: mats.bronze, dark: mats.dark, glow: mats.glow };
    for (const [k, list] of this.byKey) {
      geos.push(mergeGeometries(list, false)!);
      material.push(lookup[k]);
    }
    const geometry = mergeGeometries(geos, true)!;
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    return { geometry, material };
  }
}

// ---- shapes -------------------------------------------------------------------------------------

function polyShape(pts: Pt[]): Shape {
  const s = new Shape();
  pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  s.closePath();
  return s;
}

/** Polygon (XY, x forward, y up) extruded across Z by width w, centred on z = 0, chamfer c. */
export function plate(pts: Pt[], w: number, c = 0.012): BufferGeometry {
  const cc = Math.min(c, w / 2.2);
  const g = new ExtrudeGeometry(polyShape(pts), { depth: Math.max(0.001, w - 2 * cc), bevelEnabled: cc > 0, bevelThickness: cc, bevelSize: cc, bevelOffset: -cc, bevelSegments: 1, curveSegments: 1 });
  g.translate(0, 0, -(w - 2 * cc) / 2);
  g.deleteAttribute('uv');
  g.userData.chamfered = cc > 0;
  return g;
}

/** Signed area (positive = counter-clockwise). */
function area(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i]!;
    const [x1, y1] = p[(i + 1) % p.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** Moves every edge of a convex counter-clockwise polygon inwards by d (mitred corners). */
export function inset(p: Pt[], d: number): Pt[] {
  const n = p.length;
  const s = area(p) >= 0 ? 1 : -1;
  const lines = p.map((a, i) => {
    const b = p[(i + 1) % n]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    const nx = (-dy / l) * s;
    const ny = (dx / l) * s;
    return { px: a[0] + nx * d, py: a[1] + ny * d, dx, dy };
  });
  return lines.map((L1, i) => {
    const L0 = lines[(i - 1 + n) % n]!;
    const den = L0.dx * L1.dy - L0.dy * L1.dx;
    if (Math.abs(den) < 1e-9) return [L1.px, L1.py] as Pt;
    const t = ((L1.px - L0.px) * L1.dy - (L1.py - L0.py) * L1.dx) / den;
    return [L0.px + L0.dx * t, L0.py + L0.dy * t] as Pt;
  });
}

/** Keeps the part of a polygon on the left of the directed line a→b (Sutherland–Hodgman). */
export function clipLeft(p: Pt[], a: Pt, b: Pt): Pt[] {
  const side = (q: Pt) => (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
  const out: Pt[] = [];
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    const d = p[(i + 1) % p.length]!;
    const sc = side(c);
    const sd = side(d);
    if (sc >= 0) out.push(c);
    if (sc >= 0 !== sd >= 0) {
      const t = sc / (sc - sd);
      out.push([c[0] + (d[0] - c[0]) * t, c[1] + (d[1] - c[1]) * t]);
    }
  }
  return out;
}

/** Scales z of every vertex by x / rOut: a radial slab becomes a wedge whose ends lie on radii. */
export function wedge(g: BufferGeometry, rOut: number): BufferGeometry {
  const p = g.getAttribute('position') as BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) * (p.getX(i) / rOut));
  g.computeVertexNormals();
  return g;
}

/**
 * Turned part as one lathe band per profile segment (hard edges between bands). Profile points
 * are [radius, axial]; `wearBands` lists the segment indices that are chamfers. Axis = +Y.
 */
export function latheBands(pts: Pt[], seg: number, wearBands: number[] = []): Array<{ g: BufferGeometry; wear: boolean }> {
  const out: Array<{ g: BufferGeometry; wear: boolean }> = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (a[0] === b[0] && a[1] === b[1]) continue;
    const g = new LatheGeometry([new Vector2(a[0], a[1]), new Vector2(b[0], b[1])], seg);
    // LatheGeometry smooths normals along the profile; with two points it is the band's own normal
    out.push({ g, wear: wearBands.includes(i) });
  }
  return out;
}

/** Adds lathe bands to a builder with the axis turned to +X (rotateZ −90°) or kept on +Y. */
export function addLathe(b: TB, key: TKey, pts: Pt[], seg: number, t: Tf, opts: { axis?: 'x' | 'y' | 'z'; wearBands?: number[] } = {}): void {
  const axis = opts.axis ?? 'y';
  for (const { g, wear } of latheBands(pts, seg, opts.wearBands)) {
    if (axis === 'x') g.rotateZ(-Math.PI / 2);
    else if (axis === 'z') g.rotateX(Math.PI / 2);
    b.add(key, g, t, wear ? 'all' : 'none');
  }
}

/** Closed chamfered ring profile [radius, axial] from r0 to r1, length len, chamfer c on the outer edges. */
export function ringProfile(r0: number, r1: number, len: number, c: number): Pt[] {
  return [
    [r0, 0],
    [r1 - c, 0],
    [r1, c],
    [r1, len - c],
    [r1 - c, len],
    [r0, len],
    [r0, 0],
  ];
}

/** Toothed ring (axis +Y, base on y = 0): trapezoid teeth, chamfered top and bottom edges. */
export function toothedRing(rIn: number, rOut: number, teeth: number, h: number, depth: number, c = 0.006, holeSeg = 64): BufferGeometry {
  const s = new Shape();
  const root = rOut - depth;
  const step = (Math.PI * 2) / teeth;
  let first = true;
  for (let i = 0; i < teeth; i++) {
    const a0 = i * step;
    // root land 40 %, flank 12 %, top land 36 %, flank 12 %
    const pts: Array<[number, number]> = [
      [a0, root],
      [a0 + step * 0.4, root],
      [a0 + step * 0.52, rOut],
      [a0 + step * 0.88, rOut],
    ];
    for (const [a, r] of pts) {
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (first) {
        s.moveTo(x, y);
        first = false;
      } else s.lineTo(x, y);
    }
  }
  s.closePath();
  const hole = new Shape();
  for (let i = 0; i < holeSeg; i++) {
    const a = -(i / holeSeg) * Math.PI * 2;
    if (i === 0) hole.moveTo(Math.cos(a) * rIn, Math.sin(a) * rIn);
    else hole.lineTo(Math.cos(a) * rIn, Math.sin(a) * rIn);
  }
  s.holes.push(hole);
  const g = new ExtrudeGeometry(s, { depth: h - 2 * c, bevelEnabled: true, bevelThickness: c, bevelSize: c, bevelOffset: -c, bevelSegments: 1, curveSegments: 1 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, c, 0);
  g.deleteAttribute('uv');
  g.userData.chamfered = true;
  return g;
}

/**
 * Annular sector about +X (for muzzle-brake spines): radii r0..r1, angles a0..a1 measured from +Y
 * towards +Z, from x = 0 to x = len.
 */
export function sectorX(r0: number, r1: number, a0: number, a1: number, len: number, c = 0.004, seg = 8): BufferGeometry {
  const s = new Shape();
  // after rotateY(+90°) shape x becomes world −z, so store −z in shape x
  const P = (r: number, a: number): [number, number] => [-Math.sin(a) * r, Math.cos(a) * r];
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= seg; i++) pts.push(P(r1, a0 + ((a1 - a0) * i) / seg));
  for (let i = seg; i >= 0; i--) pts.push(P(r0, a0 + ((a1 - a0) * i) / seg));
  // ExtrudeGeometry wants counter-clockwise outlines
  let ar = 0;
  for (let i = 0; i < pts.length; i++) ar += pts[i]![0] * pts[(i + 1) % pts.length]![1] - pts[(i + 1) % pts.length]![0] * pts[i]![1];
  if (ar < 0) pts.reverse();
  pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth: len - 2 * c, bevelEnabled: true, bevelThickness: c, bevelSize: c, bevelOffset: -c, bevelSegments: 1, curveSegments: 1 });
  g.translate(0, 0, c);
  g.rotateY(Math.PI / 2);
  g.deleteAttribute('uv');
  g.userData.chamfered = true;
  return g;
}

/** Matrix placing a bolt: +Y of the bolt along `axis`, scaled by r, spun about its axis. */
export function boltMatrix(b: BoltSpec): Matrix4 {
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...b.axis).normalize());
  q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), b.spin ?? 0));
  return new Matrix4().compose(new Vector3(...b.pos), q, new Vector3(b.r, b.r, b.r));
}
