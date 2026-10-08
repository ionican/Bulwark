// W23 wall and gate geometry: every part of layout.ts at full, middle and simple detail, in the
// shared material set (ivory ceramic, gunmetal, bronze, dark, cyan glow), built with W22's
// level-aware builder (kit/builder.ts) and W20's piece finisher (edge wear on chamfers).
//
// Faces are profile strips: a cross-section in the (outward x, height y) plane extruded along z
// between the segment's ends, with the chamfers cut into the cross-section and flat ends. A run of
// face segments therefore meets on the tile edges with identical cross-sections and no chamfer
// lines, and the materials' texture repeat is a whole number per tile (mats.ts) so the texture
// carries on across the join. Features that repeat along the wall (ribs, clamps, merlons, frame
// posts) sit at z = 0 and ±0.25 or ±0.5 in every tile, so the rhythm is the same on every tile and
// pieces that straddle a tile edge are split into two strips that meet flush.
//
// Tiers (W7: tiers raise strength), outward face thickness and parapet height in layout.ts TIERS:
//   1  ivory panels in a gunmetal frame: plinth, ribs, mid rail, gunmetal parapet with an ivory cap
//   2  thicker armour: sloped ivory glacis, ivory armour panels, bronze band and bronze clamps,
//      ivory parapet with a gunmetal coping
//   3  heavy plating: deep glacis, gunmetal backing under heavy ivory plates, bronze band,
//      crenellated parapet whose merlons carry cyan light slits
// Behind every face there is an inner frame (gunmetal rails and posts against the dark core),
// hidden inside the panels until damage state 2 cuts holes in the ivory and shows it.

import { BufferGeometry, ExtrudeGeometry, Matrix4, Shape } from 'three';
import type { PB, Lv } from '../../kit/builder.ts';
import type { Pt, TKey } from '../../bench/geo.ts';
import type { Piece } from './grid.ts';
import { DECK, HALF, LEAF_H, PYLON_H, PYLON_W, TIERS } from './layout.ts';

export type Build = (p: PB) => void;

/** Profile (x outward, y up) extruded along z from z0 to z1; flat ends, no bevel. */
export function stripGeo(pts: Pt[], z0: number, z1: number, chamfered: boolean): BufferGeometry {
  const s = new Shape();
  pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth: z1 - z0, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, z0);
  g.deleteAttribute('uv');
  g.userData.chamfered = chamfered;
  return g;
}

/**
 * Rectangle profile [x0, x1] × [y0, y1] with the outer corners (at x1) chamfered by c at full
 * detail: `top` / `bottom` choose which.
 */
function rectProf(x0: number, y0: number, x1: number, y1: number, c: number, top = true, bottom = true): Pt[] {
  if (c <= 0) return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const pts: Pt[] = [[x0, y0]];
  if (bottom) pts.push([x1 - c, y0], [x1, y0 + c]);
  else pts.push([x1, y0]);
  if (top) pts.push([x1, y1 - c], [x1 - c, y1]);
  else pts.push([x1, y1]);
  pts.push([x0, y1]);
  return pts;
}

/** Adds a strip over [z0, z1] ∩ [a, b] if it is not empty. */
function strip(p: PB, key: TKey, prof: (c: number) => Pt[], z0: number, z1: number, a = -1, b = 1, imp: 'major' | 'minor' | 'fine' = 'major', c = 0.012): void {
  if (!p.keep(imp)) return;
  const lo = Math.max(z0, a);
  const hi = Math.min(z1, b);
  if (hi - lo < 1e-6) return;
  const cc = p.full ? c : 0;
  p.tb.add(key, stripGeo(prof(cc), lo, hi, cc > 0), {}, p.full && key !== 'dark' && key !== 'glow' ? 'auto' : 'none');
  p.count++;
}

/** A feature repeated at z = centre ± w/2 in every tile, clipped to the segment. */
function every(centres: number[], w: number, z0: number, z1: number, fn: (a: number, b: number, inside: boolean) => void): void {
  for (const zc of centres) {
    const a = zc - w / 2;
    const b = zc + w / 2;
    if (b <= z0 + 1e-6 || a >= z1 - 1e-6) continue;
    fn(a, b, a >= z0 - 1e-6 && b <= z1 + 1e-6);
  }
}

const h = HALF;

/** One face segment of a tier, side E (outward +x), from z0 to z1. */
export function faceSegment(p: PB, tier: number, z0: number, z1: number): void {
  const f = TIERS[tier]!.face;
  const xf = h + f;
  const box = (key: TKey, x0: number, x1: number, y0: number, y1: number, a: number, b: number, imp: 'major' | 'minor' | 'fine' = 'minor', c = 0.006) => {
    // a box fully inside the segment, chamfered all round at full detail
    p.box(key, x1 - x0, y1 - y0, b - a, { x: (x0 + x1) / 2, y: y0, z: (a + b) / 2 }, { imp, c });
  };
  // inner frame against the core: two rails and posts at z = 0 and ±0.5 (shown by damage holes)
  const fx0 = h + 0.004;
  const fx1 = h + Math.min(0.03, f - 0.012);
  for (const y of [0.42, 0.86]) strip(p, 'gunmetal', () => rectProf(fx0, y, fx1, y + 0.05, 0), z0, z1, -1, 1, 'minor');
  every([-0.5, 0, 0.5], 0.06, z0, z1, (a, b) => strip(p, 'gunmetal', () => rectProf(fx0, 0.15, fx1, DECK - 0.04, 0), z0, z1, a, b, 'minor'));
  // the core's outer skin behind the frame is dark (core/* parts)

  if (tier === 1) {
    strip(p, 'gunmetal', (c) => rectProf(h - 0.02, 0, xf + 0.03, 0.16, c, true, false), z0, z1);
    strip(p, 'ceramic', (c) => rectProf(h, 0.16, xf, 1.12, c), z0, z1);
    strip(p, 'gunmetal', (c) => rectProf(xf - 0.01, 0.6, xf + 0.014, 0.665, c * 0.5), z0, z1, -1, 1, 'minor');
    // gunmetal ribs over the panels, bolted
    every([-0.25, 0.25], 0.05, z0, z1, (a, b, inside) => {
      if (inside) box('gunmetal', xf - 0.01, xf + 0.022, 0.15, 1.12, a, b, 'major', 0.008);
      else strip(p, 'gunmetal', () => rectProf(xf - 0.01, 0.15, xf + 0.022, 1.12, 0), z0, z1, a, b);
      if (inside) for (const y of [0.32, 0.9]) p.bolt('bronze', [xf + 0.022, y, (a + b) / 2], 0.012, [1, 0, 0]);
    });
    // parapet: gunmetal wall on the outer edge of the deck with an ivory cap
    strip(p, 'gunmetal', (c) => rectProf(h - 0.07, 1.12, xf + 0.006, 1.36, c, false, true), z0, z1);
    strip(p, 'ceramic', (c) => [[h - 0.085, 1.36], [xf + 0.016 - c, 1.36], [xf + 0.016, 1.36 + c], [xf + 0.016, 1.385], [xf, 1.4], [h - 0.07, 1.4], [h - 0.085, 1.385]] as Pt[], z0, z1);
  } else if (tier === 2) {
    strip(p, 'ceramic', (c) => [[h, 0], [xf + 0.09, 0], [xf + 0.09, 0.03], [xf, 0.3 - c], [xf - c, 0.3], [h, 0.3]] as Pt[], z0, z1, -1, 1, 'major', 0.014);
    strip(p, 'gunmetal', (c) => rectProf(xf + 0.075, 0, xf + 0.11, 0.05, c * 0.5, true, false), z0, z1, -1, 1, 'minor');
    strip(p, 'ceramic', (c) => rectProf(h, 0.3, xf, 1.14, c), z0, z1, -1, 1, 'major', 0.014);
    strip(p, 'dark', () => rectProf(xf - 0.006, 0.47, xf + 0.002, 0.482, 0), z0, z1, -1, 1, 'fine');
    strip(p, 'bronze', (c) => rectProf(xf - 0.005, 0.66, xf + 0.02, 0.77, c * 0.6), z0, z1, -1, 1, 'major', 0.01);
    // bronze clamps over the panel joints, bolted
    every([-0.25, 0.25], 0.07, z0, z1, (a, b, inside) => {
      if (inside) {
        box('bronze', xf - 0.006, xf + 0.024, 0.33, 1.1, a, b, 'minor', 0.008);
        for (const y of [0.42, 0.98]) p.bolt('gunmetal', [xf + 0.024, y, (a + b) / 2], 0.013, [1, 0, 0]);
      } else strip(p, 'bronze', () => rectProf(xf - 0.006, 0.33, xf + 0.024, 1.1, 0), z0, z1, a, b, 'minor');
    });
    strip(p, 'ceramic', (c) => [[h - 0.08, 1.14], [xf, 1.14], [xf, 1.42], [xf - 0.03, 1.45], [h - 0.08, 1.45]] as Pt[], z0, z1, -1, 1, 'major', 0);
    strip(p, 'gunmetal', (c) => rectProf(h - 0.1, 1.45, xf - 0.025, 1.47, c * 0.5, true, false), z0, z1, -1, 1, 'major');
  } else {
    strip(p, 'ceramic', (c) => [[h, 0], [xf + 0.13, 0], [xf + 0.13, 0.04], [xf, 0.38 - c], [xf - c, 0.38], [h, 0.38]] as Pt[], z0, z1, -1, 1, 'major', 0.016);
    strip(p, 'gunmetal', (c) => rectProf(xf + 0.11, 0, xf + 0.16, 0.06, c * 0.5, true, false), z0, z1, -1, 1, 'minor');
    strip(p, 'gunmetal', () => rectProf(h, 0.38, h + 0.05, 1.14, 0), z0, z1, -1, 1, 'minor');
    strip(p, 'ceramic', (c) => rectProf(h + 0.04, 0.38, xf, 1.14, c), z0, z1, -1, 1, 'major', 0.016);
    // plate seams (dark grooves) between the heavy plates
    every([-0.25, 0.25], 0.012, z0, z1, (a, b) => strip(p, 'dark', () => rectProf(xf - 0.008, 0.4, xf + 0.002, 0.96, 0), z0, z1, a, b, 'fine'));
    strip(p, 'bronze', (c) => rectProf(xf - 0.004, 0.97, xf + 0.018, 1.07, c * 0.6), z0, z1, -1, 1, 'major', 0.01);
    strip(p, 'ceramic', (c) => rectProf(h - 0.09, 1.14, xf + 0.012, 1.4, c, true, false), z0, z1);
    strip(p, 'gunmetal', (c) => rectProf(h - 0.1, 1.4, xf + 0.022, 1.44, c * 0.5, true, false), z0, z1);
    // merlons at z = 0 and ±0.5 (those on the tile edge are split between the two tiles), each with
    // a cyan light slit on its outer face
    every([-0.5, 0, 0.5], 0.22, z0, z1, (a, b) => {
      strip(p, 'ceramic', (c) => [[h - 0.06, 1.44], [xf + 0.01, 1.44], [xf + 0.01, 1.62 - c], [xf + 0.01 - c, 1.62], [h - 0.06, 1.62]] as Pt[], z0, z1, a, b, 'major');
      strip(p, 'gunmetal', () => rectProf(h - 0.07, 1.62, xf + 0.016, 1.66, 0), z0, z1, a, b, 'minor');
    });
    every([-0.5, 0, 0.5], 0.1, z0, z1, (a, b) => strip(p, 'glow', () => rectProf(xf + 0.01, 1.51, xf + 0.018, 1.545, 0), z0, z1, a, b, 'minor'));
  }
}

/** Convex corner pilaster, quadrant SE (corner of the hub at (h, h)). */
function convex(p: PB, tier: number): void {
  const T = TIERS[tier]!;
  const lo = h - 0.03;
  const hi = h + T.face + 0.035;
  const w = hi - lo;
  const c = (lo + hi) / 2;
  if (tier === 1) {
    p.box('gunmetal', w, T.parapet + 0.03, w, { x: c, z: c }, { c: 0.012 });
    p.box('ceramic', w + 0.02, 0.04, w + 0.02, { x: c, y: T.parapet + 0.03, z: c }, { c: 0.01, imp: 'minor' });
    p.bolt('bronze', [c, T.parapet + 0.07, c], 0.02);
  } else if (tier === 2) {
    p.box('ceramic', w, T.parapet + 0.04, w, { x: c, z: c }, { c: 0.016 });
    p.box('bronze', w + 0.012, 0.11, w + 0.012, { x: c, y: 0.66, z: c }, { c: 0.008, imp: 'minor' });
    p.box('gunmetal', w + 0.02, 0.03, w + 0.02, { x: c, y: T.parapet + 0.04, z: c }, { c: 0.008, imp: 'minor' });
  } else {
    // a small corner tower above the crenellations
    p.box('ceramic', w + 0.02, T.top + 0.06, w + 0.02, { x: c, z: c }, { c: 0.018 });
    p.box('bronze', w + 0.034, 0.1, w + 0.034, { x: c, y: 0.97, z: c }, { c: 0.008, imp: 'minor' });
    p.box('gunmetal', w + 0.04, 0.05, w + 0.04, { x: c, y: T.top + 0.06, z: c }, { c: 0.01 });
    p.box('glow', 0.008, 0.04, 0.12, { x: hi + 0.011, y: T.top - 0.12, z: c }, { imp: 'minor', c: 0.002 });
    p.box('glow', 0.12, 0.04, 0.008, { x: c, y: T.top - 0.12, z: hi + 0.011 }, { imp: 'minor', c: 0.002 });
  }
}

/** Concave corner fillet, quadrant SE (inside of an L between the E and S arms). */
function concave(p: PB, tier: number): void {
  const T = TIERS[tier]!;
  const x = h + T.face;
  const key: TKey = tier === 1 ? 'gunmetal' : 'bronze';
  p.box(key, 0.06, T.parapet - 0.12, 0.06, { x: x + 0.004, y: 0.06, z: x + 0.004 }, { c: 0.01 });
  p.box('gunmetal', 0.09, 0.05, 0.09, { x: x + 0.004, y: 0.02, z: x + 0.004 }, { c: 0.008, imp: 'minor' });
}

/** Buttress on side E of a wall at least two deep, centred on the tile. */
function buttress(p: PB, tier: number): void {
  const f = TIERS[tier]!.face;
  const x0 = h + f - 0.01;
  const len = 0.3 + tier * 0.03;
  const top = 0.8 + tier * 0.06;
  const prof: Pt[] = [
    [x0, 0],
    [x0 + len, 0],
    [x0 + len, 0.08],
    [x0 + 0.05, top],
    [x0, top],
  ];
  const w = 0.16 + tier * 0.02;
  if (tier === 1) {
    p.prof('gunmetal', prof, w, {}, { c: 0.012 });
  } else {
    p.prof('ceramic', prof, w, {}, { c: 0.014 });
    p.box('gunmetal', len + 0.04, 0.05, w + 0.04, { x: x0 + len / 2, y: 0 }, { c: 0.008, imp: 'minor' });
    // bronze strap over the slope
    const ang = Math.atan2(top - 0.08, len - 0.05);
    p.box('bronze', 0.05, 0.022, w + 0.012, { x: x0 + len * 0.52, y: 0.08 + (top - 0.08) * 0.47, z: 0, rz: ang }, { c: 0.005, imp: 'minor' });
    if (tier === 3) p.box('bronze', 0.08, 0.04, w + 0.02, { x: x0 + 0.03, y: top, z: 0 }, { c: 0.008, imp: 'minor' });
    for (const s of [-1, 1]) p.bolt('bronze', [x0 + len - 0.06, 0.05, s * (w / 2 + 0.002)], 0.012, [0, 0, s]);
  }
}

/** Joint pilaster on the tile edge (z = 0 here; placed at z = ±0.5), side E, sized for `tier`. */
function joint(p: PB, tier: number): void {
  const T = TIERS[tier]!;
  const x0 = h - 0.04;
  const x1 = h + T.face + 0.045;
  p.box('gunmetal', x1 - x0, T.top + 0.05, 0.14, { x: (x0 + x1) / 2 }, { c: 0.012 });
  for (const y of [0.2, 0.7, T.top - 0.12]) p.box('bronze', x1 - x0 + 0.014, 0.05, 0.154, { x: (x0 + x1) / 2, y }, { c: 0.006, imp: 'minor' });
  p.box('glow', 0.008, 0.08, 0.03, { x: x1 + 0.003, y: T.top - 0.3 }, { imp: 'minor', c: 0.002 });
}

/** Cap on the hub of a thin wall, by piece (canonical rotation). */
function cap(p: PB, piece: Exclude<Piece, 'straight'>, tier: number): void {
  const T = TIERS[tier]!;
  const w = 2 * h + 0.06;
  switch (piece) {
    case 'post': {
      // a beacon post: raised block, bronze housing, cyan lamp
      p.box('ceramic', w, 0.22, w, { y: DECK - 0.02 }, { c: 0.016 });
      p.cylY('bronze', 0.13, 0.15, 0.12, { y: DECK + 0.2 }, { seg: 20 });
      p.cylY('glow', 0.08, 0.08, 0.08, { y: DECK + 0.32 }, { seg: 16 });
      p.cylY('gunmetal', 0.11, 0.11, 0.03, { y: DECK + 0.4 }, { seg: 20, imp: 'minor' });
      break;
    }
    case 'end': {
      // terminal block, raised above the parapet, facing away from the arm (−x)
      p.box('ceramic', w, T.parapet - DECK + 0.12, w, { y: DECK }, { c: 0.016 });
      p.box('gunmetal', w + 0.02, 0.04, w + 0.02, { y: T.parapet + 0.12 }, { c: 0.008, imp: 'minor' });
      p.box('glow', 0.008, 0.035, 0.22, { x: -w / 2 - 0.004, y: T.parapet - 0.05 }, { imp: 'minor', c: 0.002 });
      break;
    }
    case 'corner': {
      // corner tower: taller block with a gunmetal crown and a sensor slit
      p.box('ceramic', w + 0.04, T.top - DECK + 0.32, w + 0.04, { y: DECK }, { c: 0.02 });
      p.box('bronze', w + 0.06, 0.06, w + 0.06, { y: T.top + 0.08 }, { c: 0.01, imp: 'minor' });
      p.box('gunmetal', w - 0.12, 0.08, w - 0.12, { y: T.top + 0.32 }, { c: 0.012 });
      p.box('glow', 0.008, 0.04, 0.2, { x: -(w + 0.04) / 2 - 0.004, y: T.top + 0.18, z: 0 }, { imp: 'minor', c: 0.002 });
      p.box('glow', 0.2, 0.04, 0.008, { z: -(w + 0.04) / 2 - 0.004, y: T.top + 0.18 }, { imp: 'minor', c: 0.002 });
      break;
    }
    case 'tee':
    case 'cross': {
      // junction plate: bronze ring with bolts on the deck; the cross adds a lamp post
      p.lathe('bronze', [[0.12, 0], [0.2, 0], [0.2, 0.035], [0.12, 0.035], [0.12, 0]], { y: DECK }, { seg: 24, wear: [1] });
      p.cylY('gunmetal', 0.12, 0.12, 0.025, { y: DECK }, { seg: 20, imp: 'minor' });
      for (let k = 0; k < 8; k++) p.bolt('gunmetal', [Math.cos((k * Math.PI) / 4) * 0.16, DECK + 0.035, Math.sin((k * Math.PI) / 4) * 0.16], 0.012);
      if (piece === 'cross') {
        p.cylY('gunmetal', 0.04, 0.05, 0.3, { y: DECK + 0.03 }, { seg: 12 });
        p.cylY('glow', 0.045, 0.045, 0.05, { y: DECK + 0.33 }, { seg: 12, imp: 'minor' });
      }
      break;
    }
  }
}

// ---- core (shared by every tier) ----------------------------------------------------------------------

/** Core block [x0, x1] × [z0, z1]: dark skin, gunmetal deck plate on top (the walkway). */
function core(p: PB, x0: number, x1: number, z0: number, z1: number): void {
  const deckT = 0.04;
  // the dark skin, flat-ended so neighbouring blocks meet without a seam
  p.tb.add('dark', stripGeo(rectProf(x0, 0, x1, DECK - deckT, 0), z0, z1, false), {}, 'none');
  p.tb.add('gunmetal', stripGeo(rectProf(x0, DECK - deckT, x1, DECK, 0), z0, z1, false), {}, 'none');
  p.count += 2;
}

// ---- gate --------------------------------------------------------------------------------------------

/** Pylon: centred at the origin, x ∈ [−¼, ¼] (inner face, towards the opening, at −x), one row deep. */
function gatePylon(p: PB): void {
  const hw = PYLON_W / 2;
  p.tb.add('gunmetal', stripGeo(rectProf(-hw, 0, hw, PYLON_H, 0), -0.5, 0.5, false), {}, p.full ? 'auto' : 'none');
  p.count++;
  // ivory armour on the outer face, above the wall, and a sloped top
  strip(p, 'ceramic', (c) => [[hw - 0.02, 1.2], [hw + 0.05, 1.2], [hw + 0.05, PYLON_H - 0.1 - c], [hw + 0.05 - c, PYLON_H - 0.1], [hw - 0.02, PYLON_H - 0.06]] as Pt[], -0.5, 0.5);
  // the door slot on the inner face, with bronze guide rails either side
  strip(p, 'dark', () => rectProf(-hw - 0.003, 0.04, -hw + 0.01, 1.5, 0), -0.5, 0.5, -0.11, 0.11, 'minor');
  for (const s of [-1, 1]) strip(p, 'bronze', (c) => rectProf(-hw - 0.02, 0.03, -hw + 0.005, 1.52, c * 0.5), -0.5, 0.5, s * 0.13 - 0.02, s * 0.13 + 0.02, 'minor');
  // top: bronze coping and the status lamp
  p.box('bronze', PYLON_W + 0.04, 0.05, 0.96, { y: PYLON_H }, { c: 0.01, imp: 'minor' });
  p.box('gunmetal', 0.16, 0.08, 0.16, { y: PYLON_H + 0.05 }, { c: 0.01, imp: 'minor' });
  p.box('glow', 0.1, 0.03, 0.1, { y: PYLON_H + 0.13 }, { c: 0.004, imp: 'minor' });
  for (const z of [-0.3, 0, 0.3]) p.bolt('gunmetal', [hw + 0.05, 1.32, z], 0.015, [1, 0, 0]);
}

/** End plate on the open face of a pylon (authored facing +z, at z = 0, centred on the pylon). */
function gateCap(p: PB): void {
  const hw = PYLON_W / 2 + 0.03;
  p.box('ceramic', hw * 2, PYLON_H - 0.08, 0.07, { z: 0.035 }, { c: 0.016 });
  p.box('bronze', hw * 2 + 0.016, 0.07, 0.085, { y: 0.55, z: 0.035 }, { c: 0.008, imp: 'minor' });
  // a gate chevron in cyan: two slanted slits pointing at the opening (−x)
  for (const s of [-1, 1]) p.box('glow', 0.13, 0.026, 0.01, { x: 0.02, y: 1.25 + s * 0.05, z: 0.075, rz: s * 0.55 }, { imp: 'minor', c: 0.002 });
  p.bolt('bronze', [hw - 0.05, 0.2, 0.072], 0.018, [0, 0, 1]);
  p.bolt('bronze', [-hw + 0.05, 0.2, 0.072], 0.018, [0, 0, 1]);
}

/** Floor of the opening, one row: x ∈ [−1, 1], with the door track along z = 0. */
function gateFloor(p: PB): void {
  const x1 = 1.5 - PYLON_W;
  p.tb.add('gunmetal', stripGeo(rectProf(-x1, 0, x1, 0.03, 0), -0.5, 0.5, false), {}, 'none');
  p.count++;
  // the track runs along x: build it as a box across the opening
  p.box('bronze', 2 * x1, 0.012, 0.16, { y: 0.03 }, { c: 0.004, imp: 'minor' });
  p.box('dark', 2 * x1, 0.006, 0.05, { y: 0.04 }, { c: 0, imp: 'minor' });
  for (const x of [-0.6, -0.2, 0.2, 0.6]) p.box('dark', 0.03, 0.004, 0.8, { x, y: 0.03 }, { c: 0, imp: 'fine' });
}

/** Door leaf: 0.5 tiles wide, centred at the origin, LEAF_H tall, 0.08 thick. */
function gateLeaf(p: PB): void {
  p.box('gunmetal', 0.5, LEAF_H, 0.08, {}, { c: 0.01 });
  p.box('ceramic', 0.42, LEAF_H - 0.2, 0.1, { y: 0.1 }, { c: 0.014 });
  p.box('bronze', 0.5, 0.05, 0.1, { y: 0.02 }, { c: 0.006, imp: 'minor' });
  p.box('dark', 0.43, 0.012, 0.104, { y: 0.72 }, { imp: 'fine', c: 0 });
  p.box('glow', 0.3, 0.02, 0.09, { y: LEAF_H - 0.02 }, { imp: 'minor', c: 0.002 });
  for (const x of [-0.17, 0.17]) for (const s of [-1, 1]) p.bolt('bronze', [x, 0.25, s * 0.05], 0.014, [0, 0, s]);
}

// ---- registry --------------------------------------------------------------------------------------

/** Build function of every wall part id (layout.ts names). */
export function wallBuilders(): Map<string, Build> {
  const m = new Map<string, Build>();
  m.set('core/hub', (p) => core(p, -h, h, -h, h));
  m.set('core/arm', (p) => core(p, h, 0.5, -h, h));
  m.set('core/infill', (p) => core(p, h, 0.5, h, 0.5));
  // straight: along x (rotation 0 = E–W)
  m.set('core/straight', (p) => core(p, -0.5, 0.5, -h, h));
  m.set('core/full', (p) => core(p, -0.5, 0.5, -0.5, 0.5));
  for (const t of [1, 2, 3]) {
    m.set(`face/full/${t}`, (p) => faceSegment(p, t, -0.5, 0.5));
    m.set(`face/hub/${t}`, (p) => faceSegment(p, t, -h, h));
    m.set(`face/prev/${t}`, (p) => faceSegment(p, t, -0.5, -h));
    m.set(`face/next/${t}`, (p) => faceSegment(p, t, h, 0.5));
    m.set(`convex/${t}`, (p) => convex(p, t));
    m.set(`concave/${t}`, (p) => concave(p, t));
    m.set(`buttress/${t}`, (p) => buttress(p, t));
    m.set(`joint/${t}`, (p) => joint(p, t));
    for (const pc of ['post', 'end', 'corner', 'tee', 'cross'] as const) m.set(`cap/${pc}/${t}`, (p) => cap(p, pc, t));
  }
  m.set('gate/pylon', gatePylon);
  m.set('gate/cap', gateCap);
  m.set('gate/floor', gateFloor);
  m.set('gate/leaf', gateLeaf);
  return m;
}

/**
 * World matrix of a wall or gate piece: T(x, y, z) · Ry(−rot · 90°) · T(off). (x, z) is the world
 * position of the tile centre (or the gate centre); Ry(−90°) turns +x onto +z, so rot k turns the
 * canonical direction E onto direction k (E, S, W, N).
 */
export function wallMatrix(out: Matrix4, x: number, y: number, z: number, rot: number, off: readonly [number, number, number]): Matrix4 {
  const k = ((rot % 4) + 4) % 4;
  const c = [1, 0, -1, 0][k]!;
  const s = [0, -1, 0, 1][k]!;
  // Ry(θ) with cos θ = c, sin θ = s: x' = c·x + s·z, z' = −s·x + c·z
  const [ox, oy, oz] = off;
  out.set(c, 0, s, x + c * ox + s * oz, 0, 1, 0, y + oy, -s, 0, c, z - s * ox + c * oz, 0, 0, 0, 1);
  return out;
}

export type { Lv };
