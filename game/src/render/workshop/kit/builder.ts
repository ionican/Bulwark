// Ported from look/src/kit/builder.ts for W24 run 2a (game/src/render/workshop/README: copies, adapted only where noted).
// Level-aware part builder for the W22 parts kit. One description of a part produces its full,
// middle and simple levels, so the three levels keep the same outline:
//
//   full    every piece, chamfers (with W20's edge wear), bolts, fine fittings, W20's segment counts
//   middle  drops bolts and pieces marked 'fine', no chamfers or wear, round parts at 40 % of the
//           segments (min 8) — the W21 middle-level rules
//   simple  only pieces marked 'major', no chamfers, round parts at 20 % of the segments (min 6)
//
// Pieces go into W20's TB (geo.ts), keyed by the shared turret materials, so a built part splits
// into one geometry per material exactly as W21 splits W20's parts.

import { BufferGeometry, LatheGeometry, Matrix4, Quaternion, Vector2, Vector3 } from 'three';
import { cbox, cyl, prism, profile, taper, tfMatrix, tubeX, type Tf } from '../models/kit.ts';
import { TB, plate, type Pt, type TKey } from '../bench/geo.ts';

/** 0 full, 1 middle, 2 simple. */
export type Lv = 0 | 1 | 2;
/**
 * Kept at: major = every level, minor = full and middle, fine = full only, simple = the simple
 * level only (a coarse stand-in for pieces marked minor).
 */
export type Imp = 'major' | 'minor' | 'fine' | 'simple';
const KEEP: Record<Exclude<Imp, 'simple'>, number> = { major: 2, minor: 1, fine: 0 };

export interface PieceOpts {
  imp?: Imp;
  /** Chamfer at full detail (tiles). */
  c?: number;
  /** Corner cut of boxes at full detail (defaults to c). */
  corner?: number;
  seg?: number;
}

const Y = new Vector3(0, 1, 0);

export class PB {
  /** Pieces added so far (an empty level builds no geometry). */
  count = 0;

  constructor(
    readonly lv: Lv,
    public tb: TB = new TB(),
  ) {}

  get full(): boolean {
    return this.lv === 0;
  }

  keep(imp: Imp = 'major'): boolean {
    if (imp === 'simple') return this.lv === 2;
    return this.lv <= KEEP[imp];
  }

  /** Segment count at this level for a round part with n segments at full detail. */
  seg(n: number): number {
    if (this.lv === 0) return n;
    if (this.lv === 1) return Math.max(8, Math.round(n * 0.4));
    return Math.max(6, Math.round(n * 0.2));
  }

  private ch(c: number | undefined, def: number): number {
    return this.lv === 0 ? (c ?? def) : 0;
  }

  private add(key: TKey, g: BufferGeometry, t: Tf | Matrix4): this {
    this.count++;
    this.tb.add(key, g, t, this.lv === 0 && key !== 'dark' && key !== 'glow' ? 'auto' : 'none');
    return this;
  }

  /** Chamfered box (kit.cbox: base on y = 0, centred in x and z). */
  box(key: TKey, w: number, h: number, d: number, t: Tf | Matrix4 = {}, o: PieceOpts = {}): this {
    if (!this.keep(o.imp)) return this;
    const c = this.ch(o.c, 0.012);
    return this.add(key, cbox(w, h, d, c, this.lv === 0 ? (o.corner ?? c) : 0), t);
  }

  /** Box whose top is scaled by `top` (a frustum). */
  frustum(key: TKey, w: number, h: number, d: number, top: number, t: Tf = {}, o: PieceOpts = {}): this {
    if (!this.keep(o.imp)) return this;
    const c = this.ch(o.c, 0.012);
    const g = taper(cbox(w, h, d, c, this.lv === 0 ? (o.corner ?? c) : 0), top, h);
    g.userData.chamfered = c > 0;
    return this.add(key, g, t);
  }

  prism(key: TKey, n: number, r: number, h: number, t: Tf = {}, o: PieceOpts = {}): this {
    if (!this.keep(o.imp)) return this;
    return this.add(key, prism(n, r, h, this.ch(o.c, 0.012)), t);
  }

  /** Side profile (XY, x forward) extruded across z, centred (kit.profile). */
  prof(key: TKey, pts: Pt[], w: number, t: Tf = {}, o: PieceOpts = {}): this {
    if (!this.keep(o.imp)) return this;
    return this.add(key, profile(pts, w, this.ch(o.c, 0.012)), t);
  }

  /** Polygon plate (geo.plate: XY outline extruded across z). */
  plate(key: TKey, pts: Pt[], w: number, t: Tf = {}, o: PieceOpts = {}): this {
    if (!this.keep(o.imp)) return this;
    return this.add(key, plate(pts, w, this.ch(o.c, 0.01)), t);
  }

  /** Vertical cylinder, base on y = 0. */
  cylY(key: TKey, rTop: number, rBot: number, h: number, t: Tf = {}, o: PieceOpts & { open?: boolean } = {}): this {
    if (!this.keep(o.imp)) return this;
    return this.add(key, cyl(rTop, rBot, h, this.seg(o.seg ?? 32), o.open), t);
  }

  /** Cylinder along +X from x = 0 (radius r at x = 0, r2 at x = len). */
  tube(key: TKey, r: number, len: number, t: Tf = {}, o: PieceOpts & { r2?: number } = {}): this {
    if (!this.keep(o.imp)) return this;
    return this.add(key, tubeX(r, len, this.seg(o.seg ?? 32), o.r2 ?? r), t);
  }

  /** Cylinder along z, centred on (x, y, z). */
  cylZ(key: TKey, r: number, len: number, x: number, y: number, z: number, o: PieceOpts = {}): this {
    if (!this.keep(o.imp)) return this;
    return this.add(key, cyl(r, r, len, this.seg(o.seg ?? 32)), { x, y, z: z - len / 2, rx: Math.PI / 2 });
  }

  /**
   * Turned part: profile [radius, axial], one band per segment (hard edges between bands), the
   * bands listed in `wear` flagged as chamfers at full detail. Optional sector (phiStart,
   * phiLength) for panelled shells. Axis +Y, or turned to +X / +Z.
   */
  lathe(key: TKey, pts: Pt[], t: Tf = {}, o: PieceOpts & { axis?: 'x' | 'y' | 'z'; wear?: number[]; phi?: [number, number]; smooth?: boolean } = {}): this {
    if (!this.keep(o.imp)) return this;
    const seg = this.seg(o.seg ?? 40);
    const [p0, pl] = o.phi ?? [0, Math.PI * 2];
    const turn = (g: BufferGeometry) => {
      if (o.axis === 'x') g.rotateZ(-Math.PI / 2);
      else if (o.axis === 'z') g.rotateX(Math.PI / 2);
      return g;
    };
    if (o.smooth) {
      // one lathe over the whole profile (smooth normals along it): domes
      this.tb.add(key, turn(new LatheGeometry(pts.map(([r, a]) => new Vector2(r, a)), seg, p0, pl)), t, 'none');
      this.count++;
      return this;
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      if (a[0] === b[0] && a[1] === b[1]) continue;
      const g = turn(new LatheGeometry([new Vector2(a[0], a[1]), new Vector2(b[0], b[1])], seg, p0, pl));
      this.tb.add(key, g, t, this.lv === 0 && (o.wear ?? []).includes(i) ? 'all' : 'none');
      this.count++;
    }
    return this;
  }

  /** Box of cross-section w × d from point a to point b. */
  beam(key: TKey, a: [number, number, number], b: [number, number, number], w: number, d: number, o: PieceOpts & { spin?: number } = {}): this {
    if (!this.keep(o.imp)) return this;
    const va = new Vector3(...a);
    const dir = new Vector3(...b).sub(va);
    const len = dir.length();
    const q = new Quaternion().setFromUnitVectors(Y, dir.normalize());
    if (o.spin) q.multiply(new Quaternion().setFromAxisAngle(Y, o.spin));
    const m = new Matrix4().compose(va, q, new Vector3(1, 1, 1));
    const c = this.ch(o.c, 0.006);
    return this.add(key, cbox(w, len, d, Math.min(c, len / 3), this.lv === 0 ? c : 0), m);
  }

  /** Hex bolt (W20's 30-triangle bolt), full detail only. */
  bolt(key: 'bronze' | 'gunmetal' | 'dark', pos: [number, number, number], r: number, axis: [number, number, number] = [0, 1, 0], spin = 0): this {
    if (this.lv === 0) {
      this.tb.bolt(key, pos, r, axis, spin);
      this.count++;
    }
    return this;
  }

  /** Runs `fn` twice, the second time mirrored across z = 0. */
  mirrorZ(fn: (p: PB) => void): this {
    const outer = this.tb;
    outer.mirrorZ((tb) => {
      this.tb = tb;
      fn(this);
    });
    this.tb = outer;
    return this;
  }

  /** `fn` once per rotation about +Y (k × 2π / n + offset), pieces placed through `place`. */
  around(n: number, offset: number, fn: (a: number, k: number) => void): this {
    for (let k = 0; k < n; k++) fn(offset + (k * Math.PI * 2) / n, k);
    return this;
  }
}

/** Placement at angle a (direction (cos a, 0, −sin a)) and radius r, local +X turned onto it. */
export function polar(a: number, r: number, lateral = 0, y = 0): Tf & { x: number; y: number; z: number; ry: number } {
  return { x: Math.cos(a) * r + Math.sin(a) * lateral, y, z: -Math.sin(a) * r + Math.cos(a) * lateral, ry: a };
}

export function polarPos(a: number, r: number, lateral: number, y: number): [number, number, number] {
  const p = polar(a, r, lateral, y);
  return [p.x, p.y, p.z];
}

export function polarDir(a: number): [number, number, number] {
  return [Math.cos(a), 0, -Math.sin(a)];
}

/** Closed chamfered ring profile (same as geo.ringProfile). */
export function ring(r0: number, r1: number, len: number, c: number): Pt[] {
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

export { tfMatrix };
