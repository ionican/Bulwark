// Ported from look/src/stress/turretMid.ts for W24 run 2a (game/src/render/workshop/README: copies, adapted only where noted).
// W21 middle detail level of the W20 gun turret: about 2,900 triangles against 22,640 at full
// detail. Same parts on the same pivots (base, pinion, slewing ring, head, cradle, barrel), the same
// outline and the same materials, built with the W20 geometry kit. What is dropped is what the
// game camera cannot resolve (at 24–85 tiles a tile is 13–45 px, so a bolt head is under 1.5 px
// and a chamfer under 0.5 px):
//   - every bolt, rivet and washer; hairline cracks and chips stay in the textures as before;
//   - every chamfer and edge-wear strip (pieces are plain extrusions and cylinders);
//   - the slewing ring's 44 teeth and the pinion's 12 (plain rings), the muzzle brake's real port
//     openings (a solid brake with a dark band on each side), the recoil-housing ribs, the access
//     panel, the roof-hatch slots and hinge pins;
//   - two panels per base side become one; the cheek's eight edge plates become one ivory shell.
// Round parts use 8–24 segments instead of 24–56.
//
// Dimensions are W20's (src/bench/turretModel.ts keeps them module-private, so the ones used here
// are repeated); the pinion position and trunnion height come from the built full model.

import type { BufferGeometry } from 'three';
import { cbox, cyl, prism, profile, tubeX } from '../models/kit.ts';
import { TB, clipLeft, inset, plate, wedge, type Pt, type TKey } from '../bench/geo.ts';
import type { Tf } from '../models/kit.ts';

const OCT = Math.PI / 8;
const PLINTH_H = 0.075;
const ARMOUR_H = 0.3;
const R_FACE = 0.86;
const DECK_Y = PLINTH_H + ARMOUR_H;
const DECK_H = 0.04;
const SEAT_Y = DECK_Y + DECK_H;
const SEAT_H = 0.03;
const RING_Y = SEAT_Y + SEAT_H;
const R_BAND = 0.5;
const R_GEAR = 0.535;
const R_TABLE = 0.46;
const HEAD_Y = RING_Y + 0.135;
const CH = 0.68;
const CHEEK: Pt[] = [
  [-0.66, HEAD_Y],
  [0.17, HEAD_Y],
  [0.27, HEAD_Y + 0.1],
  [0.27, HEAD_Y + 0.33],
  [0.1, HEAD_Y + 0.62],
  [-0.43, HEAD_Y + CH],
  [-0.66, HEAD_Y + 0.56],
  [-0.74, HEAD_Y + 0.31],
  [-0.73, HEAD_Y + 0.1],
];
const CHEEK_IN = 0.235;
const CHEEK_OUT = 0.575;
const ROOF_Y = HEAD_Y + 0.6;
const BRAKE_X = 1.16;
const BRAKE_R = 0.106;
const BORE_R = 0.052;
const MUZZLE_X = 1.493;
const TRUNNION_Y = 0.95;

function polar(a: number, r: number, lateral = 0, y = 0): Tf {
  return { x: Math.cos(a) * r + Math.sin(a) * lateral, y, z: -Math.sin(a) * r + Math.cos(a) * lateral, ry: a };
}

/** Adds a piece without edge wear (there are no chamfers to wear at this level). */
function P(b: TB, key: TKey, geo: BufferGeometry, t: Tf = {}): void {
  b.add(key, geo, t, 'none');
}

function onEdge(i: number, u: number): { x: number; y: number; ang: number } {
  const a = CHEEK[i]!;
  const c = CHEEK[(i + 1) % CHEEK.length]!;
  return { x: a[0] + (c[0] - a[0]) * u, y: a[1] + (c[1] - a[1]) * u, ang: Math.atan2(c[1] - a[1], c[0] - a[0]) };
}

function base(): TB {
  const b = new TB();
  P(b, 'gunmetal', prism(8, 1.0, PLINTH_H, 0));
  for (let k = 0; k < 4; k++) {
    const a = OCT + k * (Math.PI / 2);
    P(b, 'gunmetal', cbox(0.42, 0.095, 0.48, 0, 0), polar(a, 0.95));
    P(b, 'gunmetal', cbox(0.18, 0.055, 0.26, 0, 0), { ...polar(a, 1.04), y: 0.095 });
  }
  P(b, 'gunmetal', prism(8, (R_FACE - 0.035) / Math.cos(OCT), ARMOUR_H * 0.62, 0), { y: PLINTH_H });
  // one ivory panel per side, wedge-cut to the octagon, clear of the corner pilasters
  const rIn = 0.55;
  const half = R_FACE * Math.tan(OCT);
  const w = 2 * (half - 0.06);
  for (let i = 0; i < 8; i++) {
    const f = i * (Math.PI / 4);
    const g = profile(
      [
        [rIn, 0],
        [R_FACE, 0],
        [R_FACE, ARMOUR_H * 0.64],
        [R_FACE - 0.05, ARMOUR_H * 0.76],
        [rIn + 0.03, ARMOUR_H],
        [rIn, ARMOUR_H],
      ],
      w,
      0,
    );
    wedge(g, R_FACE);
    P(b, 'ceramic', g, { y: PLINTH_H, ry: f });
  }
  // corner pilasters: block with a cap
  const rV = R_FACE / Math.cos(OCT);
  for (let i = 0; i < 8; i++) {
    const v = OCT + i * (Math.PI / 4);
    const h = ARMOUR_H * 0.64;
    P(b, 'gunmetal', cbox(0.14, h + 0.01, 0.15, 0, 0), { ...polar(v, rV - 0.03), y: PLINTH_H });
    P(b, 'gunmetal', cbox(0.13, 0.03, 0.17, 0, 0), { ...polar(v, rV - 0.035), y: PLINTH_H + h + 0.005 });
  }
  // cyan indicator
  {
    const f = -Math.PI / 4;
    P(b, 'gunmetal', cbox(0.014, 0.06, 0.06, 0, 0), { ...polar(f, R_FACE + 0.001, 0.25), y: PLINTH_H + 0.095 });
    P(b, 'glow', cbox(0.008, 0.032, 0.032, 0, 0), { ...polar(f, R_FACE + 0.012, 0.25), y: PLINTH_H + 0.109 });
  }
  P(b, 'ceramic', prism(8, 0.6, DECK_H, 0), { y: DECK_Y });
  P(b, 'gunmetal', cyl(R_BAND - 0.01, R_BAND - 0.01, SEAT_H, 16, true), { y: SEAT_Y });
  // bronze brackets and gunmetal latches
  for (let k = 0; k < 4; k++) {
    const a = k * (Math.PI / 2) + Math.PI / 4 + OCT * 0.5;
    const pr: Pt[] = [
      [R_GEAR - 0.07, 0],
      [R_GEAR + 0.16, 0],
      [R_GEAR + 0.16, 0.035],
      [R_GEAR + 0.07, 0.14],
      [R_GEAR + 0.01, 0.14],
      [R_GEAR + 0.01, 0.06],
      [R_GEAR - 0.07, 0.06],
    ];
    P(b, 'bronze', plate(pr, 0.18, 0), { ...polar(a, 0), y: SEAT_Y - 0.002 });
    P(b, 'gunmetal', cbox(0.06, 0.13, 0.1, 0, 0), { ...polar(a, R_GEAR + 0.045), y: SEAT_Y + 0.07 });
  }
  // pinion housing
  const pa = (Math.PI * 3) / 4 + OCT;
  const pinionR = R_GEAR + 0.075 - 0.03;
  P(b, 'gunmetal', cbox(0.2, 0.05, 0.24, 0, 0), { ...polar(pa, pinionR + 0.02), y: SEAT_Y - 0.002 });
  P(b, 'gunmetal', cbox(0.2, 0.06, 0.24, 0, 0), { ...polar(pa, pinionR + 0.02), y: RING_Y + 0.085 });
  P(b, 'gunmetal', cbox(0.05, 0.14, 0.2, 0, 0), { ...polar(pa, pinionR + 0.11), y: SEAT_Y + 0.03 });
  P(b, 'bronze', cyl(0.05, 0.055, 0.035, 8), { ...polar(pa, pinionR), y: RING_Y + 0.145 });
  return b;
}

function pinion(): TB {
  const b = new TB();
  P(b, 'bronze', cyl(0.075, 0.075, 0.06, 10));
  return b;
}

function ring(): TB {
  const b = new TB();
  P(b, 'bronze', cyl(R_BAND, R_BAND, 0.05, 24, true), { y: RING_Y });
  P(b, 'gunmetal', cyl(R_GEAR - 0.012, R_GEAR - 0.012, 0.07, 32), { y: RING_Y + 0.05 });
  P(b, 'gunmetal', cyl(R_TABLE, R_TABLE, 0.02, 24, true), { y: RING_Y + 0.12 });
  return b;
}

function head(): TB {
  const b = new TB();
  b.mirrorZ((h) => {
    const zIn = CHEEK_IN;
    const zOut = CHEEK_OUT - 0.04;
    const w = zOut - zIn;
    const zc = (zIn + zOut) / 2;
    // ivory shell of the outline (W20: gunmetal core plus eight ivory edge plates)
    P(h, 'ceramic', plate(CHEEK, w + 0.03, 0), { z: zc + 0.005 });
    // outer side armour, split by the raked seam into two plates
    const side = inset(CHEEK, 0.058);
    const s0: Pt = [-0.2, HEAD_Y - 0.1];
    const s1: Pt = [-0.02, HEAD_Y + 0.85];
    const front = inset(clipLeft(side, s1, s0), 0.005);
    const rear = inset(clipLeft(side, s0, s1), 0.005);
    for (const p of [front, rear]) P(h, 'ceramic', plate(p, 0.05, 0), { z: CHEEK_OUT - 0.025 });
    // hinge leaf and one knuckle, latch with its slot, clamp, slit in its bezel
    P(h, 'bronze', cbox(0.11, 0.34, 0.014, 0, 0), { x: -0.66, y: HEAD_Y + 0.13, z: CHEEK_OUT + 0.007 });
    P(h, 'bronze', cyl(0.03, 0.03, 0.3, 6), { x: -0.715, y: HEAD_Y + 0.11, z: CHEEK_OUT + 0.008 });
    P(h, 'bronze', cbox(0.09, 0.15, 0.03, 0, 0), { x: 0.13, y: HEAD_Y + 0.13, z: CHEEK_OUT - 0.004 });
    P(h, 'dark', cbox(0.03, 0.09, 0.006, 0, 0), { x: 0.13, y: HEAD_Y + 0.16, z: CHEEK_OUT + 0.012 });
    const e = onEdge(4, 0.35);
    P(h, 'bronze', cbox(0.13, 0.065, 0.11, 0, 0), { x: e.x, y: e.y - 0.035, z: zOut - 0.03, rz: e.ang });
    P(h, 'gunmetal', cbox(0.02, 0.055, 0.21, 0, 0), { x: 0.265, y: HEAD_Y + 0.17, z: zc + 0.02 });
    P(h, 'glow', cbox(0.01, 0.024, 0.16, 0, 0), { x: 0.274, y: HEAD_Y + 0.186, z: zc + 0.02 });
    P(h, 'gunmetal', cyl(0.13, 0.13, 0.03, 8), { x: 0, y: TRUNNION_Y, z: zIn - 0.015, rx: Math.PI / 2 });
    P(h, 'bronze', cbox(0.12, 0.09, 0.05, 0, 0), { x: 0.12, y: HEAD_Y + 0.07, z: zIn - 0.02 });
  });
  P(b, 'gunmetal', cyl(R_TABLE + 0.01, R_TABLE + 0.01, 0.03, 24, true), { y: HEAD_Y - 0.03 });
  // rear housing shell, roof plate and hatch
  P(b, 'gunmetal', cbox(0.08, 0.54, 0.46, 0, 0), { x: -0.65, y: HEAD_Y });
  P(b, 'ceramic', profile([[-0.77, HEAD_Y + 0.06], [-0.69, HEAD_Y + 0.06], [-0.69, ROOF_Y], [-0.76, ROOF_Y - 0.09]], 0.44, 0));
  P(b, 'ceramic', profile([[-0.69, ROOF_Y], [-0.2, ROOF_Y], [-0.2, ROOF_Y + 0.055], [-0.67, ROOF_Y + 0.055]], 0.44, 0));
  P(b, 'gunmetal', cbox(0.24, 0.025, 0.24, 0, 0), { x: -0.45, y: ROOF_Y + 0.055 });
  for (const z of [-0.13, 0.13]) P(b, 'bronze', cbox(0.08, 0.035, 0.035, 0, 0), { x: -0.45, y: ROOF_Y + 0.055, z });
  // structure under the gun
  P(b, 'gunmetal', cbox(0.32, 0.12, 0.47, 0, 0), { x: 0.14, y: HEAD_Y });
  P(b, 'gunmetal', profile([[0.0, HEAD_Y + 0.12], [0.3, HEAD_Y + 0.12], [0.22, HEAD_Y + 0.17], [0.02, HEAD_Y + 0.17]], 0.3, 0));
  for (const z of [-0.155, 0.155]) P(b, 'bronze', cbox(0.1, 0.08, 0.07, 0, 0), { x: 0.26, y: HEAD_Y + 0.1, z });
  return b;
}

function cradle(): TB {
  const b = new TB();
  b.mirrorZ((h) => {
    P(h, 'bronze', cyl(0.205, 0.205, 0.065, 16), { z: 0.155, rx: Math.PI / 2 });
    P(h, 'gunmetal', cyl(0.11, 0.11, 0.075, 12), { z: 0.15, rx: Math.PI / 2 });
  });
  P(b, 'gunmetal', cbox(0.34, 0.24, 0.3, 0, 0), { x: 0.02, y: -0.12 });
  P(b, 'bronze', cbox(0.14, 0.05, 0.31, 0, 0), { x: -0.08, y: 0.1 });
  P(b, 'bronze', tubeX(0.122, 0.05, 16), { x: 0.15 });
  P(b, 'gunmetal', tubeX(0.106, 0.32, 16), { x: 0.2 });
  P(b, 'gunmetal', tubeX(0.09, 0.06, 16), { x: 0.52 });
  P(b, 'bronze', tubeX(0.032, 0.42, 8), { x: 0.06, y: -0.105 });
  P(b, 'gunmetal', tubeX(0.038, 0.04, 8), { x: 0.46, y: -0.105 });
  P(b, 'gunmetal', cbox(0.05, 0.05, 0.06, 0, 0), { x: 0.47, y: -0.14 });
  return b;
}

function barrel(): TB {
  const b = new TB();
  P(b, 'gunmetal', cbox(0.2, 0.17, 0.17, 0, 0), { x: -0.12, y: -0.085 });
  P(b, 'bronze', cbox(0.05, 0.18, 0.18, 0, 0), { x: -0.03, y: -0.09 });
  P(b, 'dark', cbox(0.08, 0.06, 0.01, 0, 0), { x: -0.13, y: -0.02, z: 0.083 });
  P(b, 'gunmetal', tubeX(0.064, 0.6, 12), { x: -0.02 });
  P(b, 'ceramic', tubeX(0.064, 0.56, 16, 0.058), { x: 0.56 });
  P(b, 'gunmetal', tubeX(0.072, 0.04, 16), { x: 0.58 });
  for (const s of [-1, 1]) P(b, 'dark', cbox(0.3, 0.018, 0.012, 0, 0), { x: 0.87, y: -0.009, z: s * 0.056 });
  P(b, 'dark', cbox(0.22, 0.008, 0.014, 0, 0), { x: 0.87, y: 0.057 });
  P(b, 'gunmetal', tubeX(0.084, 0.06, 16), { x: 1.1 });
  // solid brake with a dark band where the five ports are, and the bore at the muzzle face
  P(b, 'gunmetal', tubeX(BRAKE_R, MUZZLE_X - BRAKE_X, 16), { x: BRAKE_X });
  for (const s of [-1, 1]) P(b, 'dark', cbox(0.22, 0.09, 0.012, 0, 0), { x: BRAKE_X + 0.05 + 0.114, y: -0.045, z: s * (BRAKE_R - 0.003) });
  P(b, 'dark', cyl(BORE_R, BORE_R, 0.002, 12), { x: MUZZLE_X + 0.001, rz: -Math.PI / 2 });
  return b;
}

/** The middle level as one builder per moving part (same parts and pivots as W20's full level). */
export function buildMiddle(): { base: TB; pinion: TB; ring: TB; head: TB; cradle: TB; barrel: TB } {
  return { base: base(), pinion: pinion(), ring: ring(), head: head(), cradle: cradle(), barrel: barrel() };
}
