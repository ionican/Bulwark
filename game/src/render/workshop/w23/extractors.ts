// Ported from look/src/w23/extractors.ts for W24 run 2a (game/src/render/workshop/README: copies, adapted only where noted).
// W23 mining extractors and deposit points (W6: extractors sit on fixed deposit points that never
// run out; mass on 8 deposits on map 1, the rare material on 3 contested points).
//
// Mass extractor (2 × 2 tiles): a square drilling platform under a lattice derrick. Ivory skirt
// armour on a gunmetal footing, four bronze hydraulic cylinders whose rods drive a crosshead and
// the drill shaft up and down, a toothed bronze drill drum turning in the well, an output hopper on
// one side whose ore level rises and is dumped, and a conduit whose cyan segments pulse in
// sequence away from the hopper (the resource flow). Status lamp on the derrick crown.
// Rare-material extractor (2 × 2 tiles): a round pad with three curved claws that meet over the
// crystal cluster — a different outline from the square derrick and from every turret — a spinning
// collector ring with cyan nodes round the crystals, and a plunger that strikes down into them.
// Same conduit and lamp.
// Deposits: a mass deposit is a low hexagonal kerb round dark rounded ore lumps; a rare point is a
// diamond kerb with four warning pylons round tall pointed crystal shards. With no extractor on it
// the kerb, the ore and a dashed hexagon / diamond icon mark it as a place to build.
//
// Moving parts use three standard pivots: STATIC (the body), SPIN (about the vertical axis through
// the footprint centre) and SLIDE (straight up and down). Every part is in the shared material set.

import { Matrix4, Vector3 } from 'three';
import type { PB } from '../kit/builder.ts';
import type { Pt } from '../bench/geo.ts';

export type ExtractorKind = 'mass' | 'rare';

export interface Extractor {
  kind: ExtractorKind;
  /** Footprint centre (world). */
  x: number;
  y: number;
  z: number;
  rot: number;
  /** 0 … 1 built (1 = complete); below 1 the build cut climbs with it. */
  built: number;
  /** Running (animated, flowing). */
  working: boolean;
  t: number;
  damage: number;
}

export const EXTRACTOR_HEIGHT: Record<ExtractorKind, number> = { mass: 2.2, rare: 1.95 };
/** Conduit glow segments per extractor and their spacing. */
export const FLOW_SEGS = 6;

const ring = (r0: number, r1: number, len: number, c: number): Pt[] => [
  [r0, 0],
  [r1 - c, 0],
  [r1, c],
  [r1, len - c],
  [r1 - c, len],
  [r0, len],
  [r0, 0],
];

const DECK = 0.3;

export function extractorBuilders(): Map<string, (p: PB) => void> {
  const m = new Map<string, (p: PB) => void>();

  // ---- mass extractor
  m.set('mass/base', (p) => {
    p.box('gunmetal', 1.94, 0.08, 1.94, {}, { c: 0.02 });
    // skirt armour on four sides (two panels a side at full detail)
    const sk: Pt[] = [[0.62, 0.08], [0.94, 0.08], [0.94, 0.15], [0.9, 0.19], [0.72, DECK], [0.62, DECK]];
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      if (p.full) for (const s of [-1, 1]) p.prof('ceramic', sk, 0.62, { x: Math.sin(a) * s * 0.33, z: Math.cos(a) * s * 0.33, ry: a }, { c: 0.014 });
      else p.prof('ceramic', sk, 1.3, { ry: a });
      for (const s of [-0.45, 0, 0.45]) p.bolt('bronze', [Math.cos(a) * 0.93 - Math.sin(a) * s, 0.08, -Math.sin(a) * 0.93 - Math.cos(a) * s], 0.016);
    }
    p.box('gunmetal', 1.36, DECK - 0.08, 1.36, { y: 0.08 }, { c: 0.012, imp: 'minor' });
    // corner bollards with bronze caps
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      p.box('gunmetal', 0.3, 0.44, 0.3, { x: sx * 0.8, z: sz * 0.8 }, { c: 0.016 });
      p.box('bronze', 0.24, 0.05, 0.24, { x: sx * 0.8, y: 0.44, z: sz * 0.8 }, { c: 0.008, imp: 'minor' });
      p.bolt('gunmetal', [sx * 0.8, 0.49, sz * 0.8], 0.026);
    }
    // deck and the drill well ring
    p.box('gunmetal', 1.3, 0.03, 1.3, { y: DECK }, { c: 0.008 });
    p.lathe('bronze', ring(0.4, 0.5, 0.06, 0.012), { y: DECK }, { seg: 40, wear: [1, 3] });
    // hydraulic cylinder bodies at the inner corners
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      p.cylY('bronze', 0.065, 0.075, 0.62, { x: sx * 0.46, y: DECK, z: sz * 0.46 }, { seg: 16 });
      p.cylY('gunmetal', 0.085, 0.085, 0.05, { x: sx * 0.46, y: DECK, z: sz * 0.46 }, { seg: 16, imp: 'minor' });
    }
    // derrick: four legs leaning in to the crown, cross braces, crown block
    const top = 2.02;
    const foot = (sx: number, sz: number): [number, number, number] => [sx * 0.6, DECK, sz * 0.6];
    const head = (sx: number, sz: number): [number, number, number] => [sx * 0.16, top, sz * 0.16];
    const lerp = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const corners: Array<[number, number]> = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
    corners.forEach(([sx, sz], k) => {
      p.beam('gunmetal', foot(sx, sz), head(sx, sz), 0.07, 0.07, { c: 0.01 });
      const [nx, nz] = corners[(k + 1) % 4]!;
      for (const [t0, t1] of [[0.12, 0.45], [0.45, 0.78]] as const) {
        p.beam('gunmetal', lerp(foot(sx, sz), head(sx, sz), t0), lerp(foot(nx, nz), head(nx, nz), t1), 0.028, 0.028, { imp: 'minor', c: 0.004 });
        p.beam('gunmetal', lerp(foot(nx, nz), head(nx, nz), t0), lerp(foot(sx, sz), head(sx, sz), t1), 0.028, 0.028, { imp: 'fine', c: 0.004 });
      }
    });
    p.box('gunmetal', 0.46, 0.16, 0.46, { y: top }, { c: 0.02 });
    p.box('ceramic', 0.5, 0.06, 0.5, { y: top + 0.16 }, { c: 0.014 });
    p.cylY('bronze', 0.06, 0.08, 0.1, { y: top + 0.22 }, { seg: 12 });
    // output hopper on +x with the conduit leaving it
    p.box('gunmetal', 0.5, 0.06, 0.62, { x: 1.18, y: 0 }, { c: 0.01 });
    for (const s of [-1, 1]) p.box('ceramic', 0.5, 0.5, 0.05, { x: 1.18, y: 0.06, z: s * 0.285 }, { c: 0.012 });
    for (const s of [-1, 1]) p.box('ceramic', 0.05, 0.5, 0.52, { x: 1.18 + s * 0.225, y: 0.06 }, { c: 0.012 });
    p.box('bronze', 0.56, 0.04, 0.68, { x: 1.18, y: 0.56 }, { c: 0.008, imp: 'minor' });
    p.box('dark', 0.4, 0.02, 0.52, { x: 1.18, y: 0.06 }, { c: 0, imp: 'minor' });
    p.tube('gunmetal', 0.07, 0.6, { x: 1.43, y: 0.12 }, { seg: 14 });
    p.cylZ('bronze', 0.09, 0.05, 1.5, 0.12, 0, { seg: 14, imp: 'minor' });
    // cyan conduit bed for the flow segments
    p.box('dark', 0.8, 0.02, 0.12, { x: 1.85, y: 0 }, { c: 0, imp: 'minor' });
  });
  m.set('mass/drum', (p) => {
    p.lathe('bronze', ring(0.12, 0.34, 0.2, 0.016), { y: DECK - 0.12 }, { seg: 36, wear: [1, 3] });
    // cutting teeth round the drum
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI * 2) / 12;
      p.box('gunmetal', 0.07, 0.12, 0.05, { x: Math.cos(a) * 0.35, y: DECK - 0.1, z: -Math.sin(a) * 0.35, ry: a + 0.5 }, { c: 0.008, imp: 'minor' });
    }
    p.cylY('dark', 0.11, 0.11, 0.21, { y: DECK - 0.12 }, { seg: 12, imp: 'minor' });
  });
  m.set('mass/head', (p) => {
    // crosshead carried on four piston rods, the drill shaft through the middle
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) p.cylY('gunmetal', 0.035, 0.035, 0.5, { x: sx * 0.46, y: DECK + 0.55, z: sz * 0.46 }, { seg: 10 });
    p.box('ceramic', 1.08, 0.12, 1.08, { y: DECK + 1.02 }, { c: 0.018 });
    p.box('gunmetal', 0.4, 0.2, 0.4, { y: DECK + 0.95 }, { c: 0.014 });
    p.cylY('gunmetal', 0.07, 0.07, 1.3, { y: DECK - 0.15 }, { seg: 14 });
    p.cylY('bronze', 0.1, 0.1, 0.06, { y: DECK + 0.3 }, { seg: 14, imp: 'minor' });
    for (const s of [-1, 1]) p.box('glow', 0.008, 0.03, 0.5, { x: s * 0.545, y: DECK + 1.06 }, { c: 0.002, imp: 'minor' });
  });
  m.set('mass/fill', (p) => {
    // ore heaped in the hopper (moved up as it fills)
    p.box('dark', 0.38, 0.06, 0.5, { x: 1.18 }, { c: 0.01 });
    for (const [x, z, r] of [[1.1, -0.12, 0.08], [1.25, 0.1, 0.07], [1.16, 0.12, 0.06], [1.27, -0.1, 0.06]] as const) p.prism('gunmetal', 5, r, 0.07, { x, y: 0.04, z, ry: x * 9 }, { c: 0.01, imp: 'minor' });
  });
  m.set('mass/light', (p) => {
    p.cylY('glow', 0.05, 0.05, 0.07, { y: 2.02 + 0.32 }, { seg: 12 });
  });

  // ---- rare-material extractor
  m.set('rare/base', (p) => {
    p.lathe('gunmetal', ring(0.0, 0.98, 0.1, 0.02), {}, { seg: 48, wear: [1, 3] });
    p.lathe('ceramic', [[0.62, 0.1], [0.98, 0.1], [0.96, 0.16], [0.7, 0.24], [0.62, 0.24]], {}, { seg: 48, wear: [1, 2] });
    // three claws: a footing, then a curve of armoured segments meeting over the middle
    for (let k = 0; k < 3; k++) {
      const a = (k * Math.PI * 2) / 3 + Math.PI / 6;
      const P = (r: number, y: number): [number, number, number] => [Math.cos(a) * r, y, -Math.sin(a) * r];
      p.box('gunmetal', 0.34, 0.3, 0.3, { x: Math.cos(a) * 0.84, z: -Math.sin(a) * 0.84, ry: a }, { c: 0.02 });
      const arc: Array<[number, number]> = [[0.84, 0.28], [0.9, 0.72], [0.78, 1.18], [0.5, 1.55], [0.18, 1.74]];
      for (let i = 0; i + 1 < arc.length; i++) {
        const [r0, y0] = arc[i]!;
        const [r1, y1] = arc[i + 1]!;
        p.beam('bronze', P(r0, y0), P(r1, y1), 0.1, 0.13, { c: 0.012, spin: a });
        // ivory armour plate on the outside of each claw segment
        const mx = (r0 + r1) / 2 + 0.06;
        const my = (y0 + y1) / 2;
        p.beam('ceramic', P(mx + (r0 - r1) * 0.3, y0 + 0.02), P(mx - (r1 - r0) * -0.3 + (r1 - r0) * 0.6, y1 - 0.02), 0.05, 0.17, { c: 0.012, spin: a, imp: 'minor' });
        if (i === 1) p.box('glow', 0.02, 0.1, 0.04, { x: Math.cos(a) * (mx + 0.04), y: my - 0.05, z: -Math.sin(a) * (mx + 0.04), ry: a }, { c: 0.003, imp: 'minor' });
      }
    }
    // crown hub where the claws meet, with the plunger housing
    p.lathe('gunmetal', [[0, 1.7], [0.26, 1.7], [0.3, 1.78], [0.26, 1.9], [0.1, 1.94], [0, 1.94]], {}, { seg: 28, wear: [1, 2] });
    p.lathe('bronze', ring(0.27, 0.31, 0.05, 0.01), { y: 1.74 }, { seg: 28, imp: 'minor' });
    // conduit leaving the pad
    p.tube('gunmetal', 0.07, 0.62, { x: 0.94, y: 0.1 }, { seg: 14 });
    p.box('dark', 0.8, 0.02, 0.12, { x: 1.85, y: 0 }, { c: 0, imp: 'minor' });
  });
  m.set('rare/ring', (p) => {
    p.lathe('gunmetal', ring(0.5, 0.6, 0.08, 0.012), { y: 0.62 }, { seg: 40, wear: [1, 3] });
    for (let k = 0; k < 3; k++) {
      const a = (k * Math.PI * 2) / 3;
      p.box('bronze', 0.14, 0.14, 0.14, { x: Math.cos(a) * 0.6, y: 0.59, z: -Math.sin(a) * 0.6, ry: a }, { c: 0.014 });
      p.box('glow', 0.02, 0.06, 0.08, { x: Math.cos(a) * 0.675, y: 0.63, z: -Math.sin(a) * 0.675, ry: a }, { c: 0.003 });
    }
  });
  m.set('rare/pump', (p) => {
    p.cylY('bronze', 0.05, 0.05, 0.9, { y: 0.9 }, { seg: 12 });
    p.cylY('gunmetal', 0.13, 0.09, 0.2, { y: 0.78 }, { seg: 16 });
    p.cylY('glow', 0.06, 0.03, 0.06, { y: 0.74 }, { seg: 12, imp: 'minor' });
  });
  m.set('rare/light', (p) => {
    p.cylY('glow', 0.06, 0.06, 0.08, { y: 1.94 }, { seg: 12 });
  });

  // ---- shared: one conduit flow segment (lit in sequence)
  m.set('flow/seg', (p) => {
    p.box('glow', 0.1, 0.03, 0.08, {}, { c: 0.004 });
  });

  // ---- deposits
  m.set('deposit/massOre', (p) => {
    const lumps: Array<[number, number, number, number]> = [
      [0, 0, 0.34, 0.2], [0.42, 0.25, 0.22, 0.14], [-0.38, 0.3, 0.26, 0.16], [0.3, -0.42, 0.2, 0.13], [-0.32, -0.36, 0.24, 0.15],
      [0.62, -0.1, 0.15, 0.1], [-0.6, -0.02, 0.14, 0.1], [0.08, 0.55, 0.16, 0.1], [-0.1, -0.62, 0.13, 0.09],
    ];
    lumps.forEach(([x, z, r, h], i) => {
      // rounded ore: a squashed dome, alternately gunmetal (metallic ore) and dark
      const pts: Pt[] = [];
      const n = p.full ? 6 : 3;
      for (let k = n; k >= 0; k--) {
        const a = (k / n) * (Math.PI / 2);
        pts.push([r * Math.sin(a) * (1 + 0.1 * Math.cos(k * 2.3 + i)), h * Math.cos(a)]);
      }
      p.lathe(i % 2 ? 'dark' : 'gunmetal', pts, { x, y: -0.02, z, ry: i }, { seg: p.full ? 9 : 6, smooth: true });
    });
  });
  m.set('deposit/rareCrystal', (p) => {
    const shards: Array<[number, number, number, number, number, number]> = [
      [0, 0, 0.11, 1.0, 0, 0], [0.18, 0.1, 0.08, 0.72, 0.25, 0.2], [-0.16, 0.12, 0.08, 0.66, -0.3, 0.15], [0.05, -0.2, 0.09, 0.8, 0.1, -0.28],
      [-0.12, -0.14, 0.06, 0.5, -0.3, -0.3], [0.26, -0.12, 0.06, 0.48, 0.42, -0.2], [-0.3, -0.02, 0.05, 0.42, -0.5, 0], [0.12, 0.28, 0.06, 0.52, 0.2, 0.42],
      [0.42, 0.22, 0.05, 0.36, 0.5, 0.3], [-0.38, 0.3, 0.05, 0.34, -0.45, 0.4],
    ];
    shards.forEach(([x, z, r, h, tx, tz], i) => {
      // hexagonal prism with a pointed tip, tilted outwards
      const pts: Pt[] = [[0, -0.05], [r, -0.05], [r, h * 0.78], [0, h]];
      p.lathe(i < 4 ? 'glow' : i % 2 ? 'glow' : 'dark', pts, { x, z, rx: tz * 0.6, rz: -tx * 0.6, ry: i * 0.7 }, { seg: 6 });
    });
    // dark rock collar the crystals grow from
    p.lathe('dark', [[0, 0.06], [0.45, 0.02], [0.62, -0.02], [0, -0.02]], {}, { seg: 12 });
  });
  m.set('deposit/markerMass', (p) => {
    // hexagonal kerb (six low segments) with a bronze cap at each corner
    for (let k = 0; k < 6; k++) {
      const a0 = (k * Math.PI) / 3;
      const a1 = ((k + 1) * Math.PI) / 3;
      const R = 1.2;
      p.beam('ceramic', [Math.cos(a0) * R, 0.04, -Math.sin(a0) * R], [Math.cos(a1) * R, 0.04, -Math.sin(a1) * R], 0.08, 0.14, { c: 0.01, spin: Math.PI / 2 });
      p.cylY('bronze', 0.07, 0.08, 0.16, { x: Math.cos(a0) * R, z: -Math.sin(a0) * R }, { seg: 10 });
    }
  });
  m.set('deposit/markerRare', (p) => {
    // diamond kerb with four warning pylons (contested point)
    for (let k = 0; k < 4; k++) {
      const a0 = (k * Math.PI) / 2;
      const a1 = ((k + 1) * Math.PI) / 2;
      const R = 1.3;
      p.beam('ceramic', [Math.cos(a0) * R, 0.04, -Math.sin(a0) * R], [Math.cos(a1) * R, 0.04, -Math.sin(a1) * R], 0.08, 0.14, { c: 0.01, spin: Math.PI / 2 });
      const px = Math.cos(a0) * (R + 0.12);
      const pz = -Math.sin(a0) * (R + 0.12);
      p.frustum('gunmetal', 0.16, 0.5, 0.16, 0.6, { x: px, z: pz }, { c: 0.012 });
      p.box('bronze', 0.08, 0.06, 0.08, { x: px, y: 0.5, z: pz }, { c: 0.006, imp: 'minor' });
      p.box('glow', 0.05, 0.03, 0.05, { x: px, y: 0.56, z: pz }, { c: 0.002, imp: 'minor' });
    }
  });
  return m;
}

// ---- animation --------------------------------------------------------------------------------------

export interface ExtractorPose {
  spin: number;
  slide: number;
  fill: number;
  light: number;
  flow: number[];
}

/** Moving-part state of an extractor at its time t (seconds of working). */
export function extractorPose(e: Extractor, out: ExtractorPose): ExtractorPose {
  const t = e.t;
  out.flow.length = FLOW_SEGS;
  if (!e.working) {
    out.spin = 0;
    out.slide = 0;
    out.fill = 0;
    // idle: lamp breathes slowly
    out.light = e.built >= 1 ? 0.25 + 0.15 * Math.sin(t * 1.5) : 0;
    out.flow.fill(0.05);
    return out;
  }
  if (e.kind === 'mass') {
    out.spin = t * 2.4;
    // piston cycle 1.6 s: down stroke while drilling, quick return
    const c = (t % 1.6) / 1.6;
    out.slide = c < 0.7 ? -0.22 * Math.sin((c / 0.7) * (Math.PI / 2)) : -0.22 * Math.cos(((c - 0.7) / 0.3) * (Math.PI / 2));
    // hopper fills over 6 s, then dumps
    const f = (t % 6) / 6;
    out.fill = f < 0.9 ? 0.4 * (f / 0.9) : 0.4 * (1 - (f - 0.9) / 0.1);
  } else {
    out.spin = -t * 1.7;
    const c = (t % 2.0) / 2.0;
    out.slide = c < 0.25 ? -0.32 * Math.sin((c / 0.25) * (Math.PI / 2)) : -0.32 * (1 - (c - 0.25) / 0.75);
    out.fill = 0;
  }
  // status: steady with a short blink every 2 s
  out.light = (t % 2) < 0.15 ? 0.2 : 1;
  // flow: a pulse running out along the conduit, one segment after another
  for (let k = 0; k < FLOW_SEGS; k++) {
    const u = (t * 2.2 - k * 0.35) % 2.1;
    out.flow[k] = 0.15 + 1.6 * Math.max(0, 1 - Math.abs(u - 0.3) * 3);
  }
  return out;
}

/** Conduit segment positions (extractor space): along +x beyond the hopper/pad. */
export function flowSegment(kind: ExtractorKind, k: number): [number, number, number] {
  const x0 = kind === 'mass' ? 1.5 : 1.55;
  return [x0 + k * 0.14, 0.02, 0];
}

const _m = new Matrix4();
const _v = new Vector3();

/** Base matrix: T(x, y, z) · Ry(rot). */
export function extractorMatrix(out: Matrix4, e: { x: number; y: number; z: number; rot: number }): Matrix4 {
  return out.makeRotationY(e.rot).setPosition(_v.set(e.x, e.y, e.z));
}

/** Matrix of a moving part on its pivot: base · Ry(spin) or base · T(0, slide, 0). */
export function pivotMatrix(out: Matrix4, base: Matrix4, spin: number, slide: number, off: [number, number, number] = [0, 0, 0]): Matrix4 {
  out.copy(base);
  if (off[0] || off[1] || off[2] || slide) out.multiply(_m.makeTranslation(off[0], off[1] + slide, off[2]));
  if (spin) out.multiply(_m.makeRotationY(spin));
  return out;
}
