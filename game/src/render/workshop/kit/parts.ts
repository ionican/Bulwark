// Ported from look/src/kit/parts.ts for W24 run 2a (game/src/render/workshop/README: copies, adapted only where noted).
// W22 parts kit: interchangeable turret parts, each at full, middle and simple detail, all in the
// shared turret materials (ivory ceramic, gunmetal, bronze, dark, cyan glow). W20's own parts (the
// octagonal base with its pinion, the toothed slewing ring, the cheek-armour head, the cradle and
// long barrel) are taken as they are: full from W20's model, middle from W21's middle builder,
// simple from W20's simple level, so W20's kind is drawn from the same geometry as W21.
//
// Frames (tiles; turret space +Y up, barrel along +X at yaw 0):
//   base    authored at the ground; `top` = height of the seat the ring stands on.
//   ring    authored with its foot at y = `anchor`, `height` tall; at middle and simple detail its
//           geometry is rotationally symmetric, so it is drawn without turning (static).
//   head    authored with its foot at y = `anchor`; `trunnion` = height of the pitch axis in the
//           same frame. Turns with the yaw.
//   weapon  cradle space: origin on the trunnion, +X along the bore. `mount` pitches; `gun` also
//           recoils (along −X), spins (about +X) or stays fixed to the mount.

import { inset, type Pt } from '../bench/geo.ts';
import { PB, polar, polarPos, ring, type Lv } from './builder.ts';

export type BaseId = 'octagon' | 'bunker' | 'drum' | 'pylon';
export type RingId = 'toothed' | 'collar' | 'turntable';
export type HeadId = 'cheek' | 'dome' | 'box' | 'yoke' | 'deck' | 'emitter' | 'mast';
export type WeaponId = 'long' | 'twin' | 'howitzer' | 'rotary' | 'missiles' | 'beam' | 'flak';
export type GunMotion = 'recoil' | 'spin' | 'none';
export type Build = (p: PB) => void;

export interface BaseSpec {
  id: BaseId;
  name: string;
  top: number;
  /** W20's base: built from W20's model rather than `build`. */
  w20?: boolean;
  build?: Build;
}
export interface RingSpec {
  id: RingId;
  name: string;
  anchor: number;
  height: number;
  w20?: boolean;
  build?: Build;
}
export interface HeadSpec {
  id: HeadId;
  name: string;
  anchor: number;
  trunnion: number;
  w20?: boolean;
  build?: Build;
}
export interface WeaponSpec {
  id: WeaponId;
  name: string;
  motion: GunMotion;
  /** Recoil travel as a multiple of W20's (0.16 tiles). */
  recoilScale: number;
  /** Muzzle, cradle space at rest (effects start here). */
  muzzle: [number, number, number];
  w20?: boolean;
  mount?: Build;
  gun?: Build;
}

const PI = Math.PI;
const OCT = PI / 8;

// ---- bases --------------------------------------------------------------------------------------

/** Square bunker: gunmetal footing, sloped ivory armour (two panels a side), corner towers. */
function bunker(p: PB): void {
  const FOOT = 0.08;
  const AH = 0.34;
  const R = 0.85;
  p.box('gunmetal', 1.92, FOOT, 1.92, {}, { c: 0.02 });
  for (let k = 0; k < 4; k++) for (const l of [-0.45, -0.15, 0.15, 0.45]) p.bolt('gunmetal', polarPos((k * PI) / 2, 0.93, l, FOOT), 0.014);
  p.box('gunmetal', 1.24, AH - 0.02, 1.24, { y: FOOT }, { c: 0.01, imp: 'minor' });
  const pr: Pt[] = [
    [0.5, 0],
    [R, 0],
    [R, 0.11],
    [R - 0.03, 0.14],
    [0.62, AH],
    [0.5, AH],
  ];
  for (let k = 0; k < 4; k++) {
    const a = (k * PI) / 2;
    if (p.full) for (const s of [-1, 1]) p.prof('ceramic', pr, 0.52, { ...polar(a, 0, s * 0.27), y: FOOT }, { c: 0.014 });
    else p.prof('ceramic', pr, 1.08, { ...polar(a, 0), y: FOOT });
    // vent slots on the faces (the rear face has the hatch instead)
    if (k === 2) {
      p.box('bronze', 0.02, 0.075, 0.34, { ...polar(a, R + 0.008), y: FOOT + 0.02 }, { c: 0.005, imp: 'minor' });
      p.box('dark', 0.01, 0.012, 0.2, { ...polar(a, R + 0.019), y: FOOT + 0.05 }, { imp: 'fine', c: 0.002 });
    } else for (const l of [-0.3, 0, 0.3]) p.box('dark', 0.01, 0.05, 0.14, { ...polar(a, R + 0.002, l), y: FOOT + 0.03 }, { imp: 'minor', c: 0.002 });
  }
  // corner towers with bronze caps and a dark channel on each outer face
  for (const [sx, sz] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const) {
    const x = sx * 0.71;
    const z = sz * 0.71;
    p.box('gunmetal', 0.36, AH + 0.06, 0.36, { x, y: FOOT, z }, { c: 0.014 });
    p.box('bronze', 0.3, 0.04, 0.3, { x, y: FOOT + AH + 0.06, z }, { c: 0.008, imp: 'minor' });
    p.box('dark', 0.01, AH - 0.06, 0.07, { x: x + sx * 0.181, y: FOOT + 0.04, z }, { imp: 'fine', c: 0.002 });
    p.box('dark', 0.07, AH - 0.06, 0.01, { x, y: FOOT + 0.04, z: z + sz * 0.181 }, { imp: 'fine', c: 0.002 });
    p.bolt('bronze', [x, FOOT + AH + 0.1, z], 0.032, [0, 1, 0], 0.3);
  }
  // deck, bearing seat, deck bolts
  const DECK = FOOT + AH;
  p.box('ceramic', 1.1, 0.05, 1.1, { y: DECK }, { c: 0.012 });
  p.cylY('gunmetal', 0.5, 0.5, 0.03, { y: DECK + 0.05 }, { seg: 48 });
  for (let k = 0; k < 4; k++) p.bolt('bronze', polarPos(PI / 4 + (k * PI) / 2, 0.66, 0, DECK + 0.05), 0.02);
  // cyan indicator on the front right face
  p.box('gunmetal', 0.014, 0.06, 0.06, { ...polar(0, R + 0.001, -0.42), y: FOOT + 0.05 }, { imp: 'minor', c: 0.004 });
  p.box('glow', 0.008, 0.032, 0.032, { ...polar(0, R + 0.012, -0.42), y: FOOT + 0.064 }, { imp: 'minor', c: 0.002 });
}

/** Low round drum: footing ring, six ivory shell panels, bronze buttresses, low deck. */
function drum(p: PB): void {
  p.lathe('gunmetal', ring(0.3, 0.98, 0.065, 0.015), {}, { seg: 64, wear: [1, 3], imp: 'minor' });
  p.cylY('gunmetal', 0.98, 0.98, 0.065, {}, { seg: 40, imp: 'simple' });
  for (let k = 0; k < 24; k++) p.bolt('gunmetal', polarPos((k * PI) / 12 + 0.13, 0.94, 0, 0.065), 0.014);
  p.cylY('gunmetal', 0.84, 0.84, 0.17, { y: 0.065 }, { seg: 48, imp: 'minor' });
  const shell: Pt[] = [
    [0.9, 0.065],
    [0.9, 0.13],
    [0.875, 0.155],
    [0.64, 0.235],
    [0.56, 0.235],
  ];
  if (p.full) for (let k = 0; k < 6; k++) p.lathe('ceramic', shell, {}, { seg: 12, phi: [(k * PI) / 3 + 0.035, PI / 3 - 0.07], wear: [1] });
  else p.lathe('ceramic', shell, {}, { seg: 56, imp: 'minor' });
  p.cylY('ceramic', 0.6, 0.9, 0.17, { y: 0.065 }, { seg: 40, imp: 'simple' });
  // buttresses between the panels
  for (let k = 0; k < 6; k++) {
    const a = (k * PI) / 3;
    p.plate(
      'bronze',
      [
        [0.86, 0.065],
        [1.0, 0.065],
        [1.0, 0.1],
        [0.89, 0.2],
        [0.86, 0.2],
      ],
      0.07,
      polar(a, 0),
      { c: 0.008, imp: 'minor' },
    );
    p.bolt('bronze', polarPos(a, 0.97, 0, 0.1), 0.016, [Math.cos(a) * 0.5, 0.86, -Math.sin(a) * 0.5]);
  }
  // deck with a bronze rim
  p.cylY('gunmetal', 0.6, 0.62, 0.025, { y: 0.235 }, { seg: 48 });
  p.lathe('bronze', ring(0.6, 0.665, 0.03, 0.008), { y: 0.232 }, { seg: 48, wear: [1, 3], imp: 'minor' });
  for (let k = 0; k < 12; k++) p.bolt('bronze', polarPos((k * PI) / 6 + 0.26, 0.632, 0, 0.262), 0.014);
  // three cyan lights on the shell
  for (let k = 0; k < 3; k++) {
    const a = (k * 2 * PI) / 3 + PI / 6;
    p.box('gunmetal', 0.03, 0.05, 0.13, { ...polar(a, 0.9), y: 0.075 }, { imp: 'minor', c: 0.004 });
    p.box('glow', 0.012, 0.024, 0.1, { ...polar(a, 0.912), y: 0.088 }, { imp: 'minor', c: 0.002 });
  }
}

/** Tall pylon: four splayed legs with cross bracing, ivory column, octagonal platform. */
function pylon(p: PB): void {
  const yFoot = 0.08;
  const yTop = 0.96;
  const rFoot = 0.9;
  const rTop = 0.36;
  const legAt = (a: number, y: number) => polarPos(a, rFoot + ((rTop - rFoot) * (y - yFoot)) / (yTop - yFoot), 0, y);
  const lerp = (u: [number, number, number], v: [number, number, number], t: number): [number, number, number] => [u[0] + (v[0] - u[0]) * t, u[1] + (v[1] - u[1]) * t, u[2] + (v[2] - u[2]) * t];
  for (let k = 0; k < 4; k++) {
    const a = PI / 4 + (k * PI) / 2;
    p.box('gunmetal', 0.36, yFoot, 0.36, { ...polar(a, rFoot) }, { c: 0.015 });
    for (const [r, l] of [
      [0.12, 0.12],
      [0.12, -0.12],
      [-0.12, 0.12],
      [-0.12, -0.12],
    ] as const)
      p.bolt('bronze', polarPos(a, rFoot + r, l, yFoot), 0.022, [0, 1, 0], k);
    const f = legAt(a, yFoot);
    const t = legAt(a, yTop);
    p.beam('gunmetal', f, t, 0.13, 0.13, { c: 0.012, spin: a });
    p.beam('bronze', lerp(f, t, 0.42), lerp(f, t, 0.5), 0.165, 0.165, { c: 0.01, spin: a, imp: 'minor' });
    // X-braces to the next leg
    const b = a + PI / 2;
    p.beam('gunmetal', legAt(a, 0.22), legAt(b, 0.66), 0.035, 0.035, { imp: 'minor', c: 0.004 });
    p.beam('gunmetal', legAt(b, 0.22), legAt(a, 0.66), 0.035, 0.035, { imp: 'minor', c: 0.004 });
  }
  // ladder up one leg (bronze rungs)
  {
    const a = (5 * PI) / 4;
    for (let y = 0.2; y < 0.9; y += 0.085) {
      const c = legAt(a, y);
      const s = polarPos(a, 0, 0.07, 0);
      p.beam('bronze', [c[0] - s[0] + 0.05 * Math.cos(a), c[1], c[2] - s[2] - 0.05 * Math.sin(a)], [c[0] + s[0] + 0.05 * Math.cos(a), c[1], c[2] + s[2] - 0.05 * Math.sin(a)], 0.016, 0.016, { imp: 'fine', c: 0.002 });
    }
  }
  // column with bronze bands
  p.lathe('gunmetal', ring(0.18, 0.34, 0.06, 0.012), { y: 0 }, { seg: 40, wear: [1, 3], imp: 'minor' });
  p.cylY('ceramic', 0.22, 0.26, 0.86, { y: 0.06 }, { seg: 32 });
  for (const y of [0.3, 0.62]) p.lathe('bronze', ring(0.2, 0.285, 0.05, 0.008), { y }, { seg: 36, wear: [1, 3], imp: 'minor' });
  // platform and bearing seat
  p.prism('gunmetal', 8, 0.58, 0.06, { y: 0.94 }, { c: 0.01, imp: 'minor' });
  p.prism('ceramic', 8, 0.66, 0.08, { y: 1.0 }, { c: 0.014 });
  p.cylY('gunmetal', 0.5, 0.5, 0.04, { y: 1.08 }, { seg: 48 });
  for (let k = 0; k < 8; k++) p.bolt('bronze', polarPos((k * PI) / 4, 0.56, 0, 1.08), 0.016);
  // beacons at four platform corners
  for (let k = 0; k < 4; k++) {
    const a = PI / 4 + (k * PI) / 2;
    p.box('gunmetal', 0.07, 0.05, 0.07, { ...polar(a, 0.56), y: 1.08 }, { imp: 'minor', c: 0.008 });
    p.box('glow', 0.045, 0.03, 0.045, { ...polar(a, 0.56), y: 1.13 }, { imp: 'minor', c: 0.004 });
  }
}

// ---- rings --------------------------------------------------------------------------------------

/** Armoured collar: bronze band, ivory cone, gunmetal lip (lugs at full detail show it turning). */
function collar(p: PB): void {
  p.lathe('bronze', ring(0.38, 0.63, 0.05, 0.01), {}, { seg: 56, wear: [1, 3], imp: 'minor' });
  p.lathe(
    'ceramic',
    [
      [0.6, 0.05],
      [0.6, 0.08],
      [0.575, 0.105],
      [0.47, 0.172],
      [0.4, 0.172],
    ],
    {},
    { seg: 56, wear: [1], imp: 'minor' },
  );
  p.lathe('gunmetal', ring(0.34, 0.48, 0.03, 0.006), { y: 0.17 }, { seg: 48, wear: [1, 3], imp: 'minor' });
  p.cylY('ceramic', 0.48, 0.63, 0.2, {}, { seg: 40, imp: 'simple' });
  for (let k = 0; k < 16; k++) p.bolt('bronze', polarPos((k * PI) / 8, 0.615, 0, 0.05), 0.013);
  for (let k = 0; k < 4; k++) p.box('gunmetal', 0.12, 0.05, 0.08, { ...polar((k * PI) / 2 + PI / 4, 0.5), y: 0.125, rz: -0.55 }, { imp: 'fine', c: 0.008 });
}

/** Wide flat turntable: bronze disc, gunmetal top plate; spokes and a bolt circle at full detail. */
function turntable(p: PB): void {
  p.lathe('bronze', ring(0.3, 0.74, 0.05, 0.01), {}, { seg: 64, wear: [1, 3], imp: 'minor' });
  p.lathe('gunmetal', ring(0.26, 0.68, 0.04, 0.008), { y: 0.05 }, { seg: 56, wear: [1, 3], imp: 'minor' });
  p.cylY('bronze', 0.68, 0.74, 0.09, {}, { seg: 40, imp: 'simple' });
  p.cylY('dark', 0.745, 0.745, 0.008, { y: 0.022 }, { seg: 64, open: true, imp: 'fine' });
  for (let k = 0; k < 8; k++) p.box('gunmetal', 0.22, 0.014, 0.05, { ...polar((k * PI) / 4 + PI / 8, 0.56), y: 0.09 }, { imp: 'fine', c: 0.004 });
  for (let k = 0; k < 20; k++) p.bolt('bronze', polarPos((k * PI) / 10, 0.71, 0, 0.05), 0.014, [0, 1, 0], k);
}

// ---- heads (foot at y = 0) ------------------------------------------------------------------------

/** Points of a quarter-ellipse dome (radius a, height h above y0) from angle t0 to t1. */
function domePts(a: number, h: number, y0: number, t0: number, t1: number, n: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    out.push([Math.max(0, a * Math.cos(t)), y0 + h * Math.sin(t)]);
  }
  return out;
}

/** Rounded dome: skirt, ivory dome in two bands with a bronze band, front mantlet with gun slot. */
function dome(p: PB): void {
  p.lathe('gunmetal', ring(0.2, 0.54, 0.06, 0.012), {}, { seg: 56, wear: [1, 3], imp: 'minor' });
  p.cylY('gunmetal', 0.54, 0.54, 0.06, {}, { seg: 40, imp: 'simple' });
  for (let k = 0; k < 16; k++) p.bolt('bronze', polarPos((k * PI) / 8 + 0.1, 0.52, 0, 0.06), 0.013);
  const n = p.lv === 0 ? 6 : 3;
  if (p.lv === 2) p.lathe('ceramic', domePts(0.5, 0.56, 0.06, 0, PI / 2, 3), {}, { seg: 40, smooth: true });
  else {
    p.lathe('ceramic', domePts(0.5, 0.56, 0.06, 0, 0.38, Math.max(2, n - 3)), {}, { seg: 56, smooth: true });
    p.lathe('ceramic', domePts(0.5, 0.56, 0.06, 0.44, PI / 2, n + 2), {}, { seg: 56, smooth: true });
    p.lathe('bronze', ring(0.4, 0.478, 0.045, 0.008), { y: 0.255 }, { seg: 56, wear: [1, 3] });
  }
  // mantlet and the gun slot
  p.box('gunmetal', 0.16, 0.42, 0.46, { x: 0.44, y: 0.12 }, { c: 0.016 });
  p.box('dark', 0.02, 0.36, 0.13, { x: 0.52, y: 0.15 }, { c: 0.003, imp: 'minor' });
  for (const y of [0.16, 0.48]) for (const z of [-0.19, 0.19]) p.bolt('bronze', [0.522, y, z], 0.016, [1, 0, 0]);
  p.mirrorZ((h) => {
    h.box('bronze', 0.12, 0.34, 0.03, { x: 0.44, y: 0.16, z: 0.245 }, { imp: 'minor', c: 0.006 });
    // cyan slit on each side in a gunmetal bezel
    h.box('gunmetal', 0.26, 0.06, 0.03, { x: -0.06, y: 0.17, z: 0.47 }, { imp: 'minor', c: 0.006 });
    h.box('glow', 0.22, 0.026, 0.02, { x: -0.06, y: 0.187, z: 0.482 }, { imp: 'minor', c: 0.002 });
  });
  // roof hatch, hinge, periscope
  p.cylY('gunmetal', 0.15, 0.16, 0.035, { x: -0.12, y: 0.585 }, { seg: 32, imp: 'minor' });
  for (let k = 0; k < 6; k++) p.bolt('bronze', [-0.12 + Math.cos((k * PI) / 3) * 0.12, 0.62, Math.sin((k * PI) / 3) * 0.12], 0.012);
  p.box('bronze', 0.06, 0.03, 0.12, { x: -0.28, y: 0.575 }, { imp: 'fine', c: 0.006 });
  p.box('gunmetal', 0.1, 0.11, 0.13, { x: 0.12, y: 0.54 }, { imp: 'minor', c: 0.01 });
  p.box('dark', 0.01, 0.03, 0.09, { x: 0.171, y: 0.6 }, { imp: 'fine', c: 0.002 });
  // rear stowage box
  p.box('bronze', 0.14, 0.18, 0.4, { x: -0.5, y: 0.08 }, { c: 0.012, imp: 'minor' });
  for (const z of [-0.12, 0.12]) p.box('gunmetal', 0.15, 0.02, 0.03, { x: -0.5, y: 0.2, z }, { imp: 'fine', c: 0.004 });
}

/** Wide flat box head: sloped glacis, wide mantlet with two gun ports, side skirts, roof hatches. */
function boxHead(p: PB): void {
  p.box('gunmetal', 1.12, 0.06, 1.02, { x: -0.1 }, { c: 0.012 });
  const hull: Pt[] = [
    [-0.66, 0.06],
    [0.36, 0.06],
    [0.52, 0.18],
    [0.42, 0.44],
    [-0.5, 0.47],
    [-0.68, 0.32],
  ];
  p.prof('ceramic', hull, 1.1, {}, { c: 0.018 });
  p.mirrorZ((h) => {
    h.plate(
      'gunmetal',
      [
        [-0.62, 0.07],
        [0.34, 0.07],
        [0.46, 0.17],
        [-0.6, 0.3],
      ],
      0.04,
      { z: 0.57 },
      { c: 0.008, imp: 'minor' },
    );
    for (const x of [-0.45, -0.15, 0.15]) h.bolt('bronze', [x, 0.16, 0.592], 0.014, [0, 0, 1]);
    h.box('dark', 0.02, 0.2, 0.1, { x: 0.545, y: 0.16, z: 0.13 }, { imp: 'minor', c: 0.003 });
    h.cylY('gunmetal', 0.12, 0.13, 0.03, { x: -0.22, y: 0.455, z: 0.25 }, { seg: 28, imp: 'minor' });
    h.box('bronze', 0.05, 0.03, 0.08, { x: -0.36, y: 0.47, z: 0.25 }, { imp: 'fine', c: 0.005 });
    h.box('glow', 0.06, 0.022, 0.16, { x: 0.4, y: 0.44, z: 0.36 }, { imp: 'minor', c: 0.003 });
  });
  p.box('gunmetal', 0.14, 0.32, 0.58, { x: 0.47, y: 0.1 }, { c: 0.016 });
  for (const z of [-0.24, 0, 0.24]) p.bolt('bronze', [0.542, 0.37, z], 0.014, [1, 0, 0]);
  p.box('bronze', 0.12, 0.16, 0.82, { x: -0.73, y: 0.12 }, { c: 0.012, imp: 'minor' });
  for (const z of [-0.3, 0, 0.3]) p.box('gunmetal', 0.13, 0.17, 0.02, { x: -0.73, y: 0.115, z }, { imp: 'fine', c: 0.004 });
  p.cylY('gunmetal', 0.012, 0.014, 0.55, { x: -0.5, y: 0.46, z: 0.4 }, { seg: 6, imp: 'fine' });
}

/** Missile yoke: base plate, low housing, two tall ivory arms with bronze trunnion hubs. */
function yoke(p: PB): void {
  p.box('gunmetal', 0.94, 0.08, 0.94, {}, { c: 0.014 });
  for (const [x, z] of [
    [0.4, 0.4],
    [0.4, -0.4],
    [-0.4, 0.4],
    [-0.4, -0.4],
  ] as const)
    p.bolt('bronze', [x, 0.08, z], 0.02);
  p.prof(
    'ceramic',
    [
      [-0.46, 0.08],
      [0.32, 0.08],
      [0.4, 0.17],
      [-0.42, 0.24],
    ],
    0.74,
    {},
    { c: 0.014 },
  );
  const arm: Pt[] = [
    [-0.3, 0.08],
    [0.22, 0.08],
    [0.26, 0.48],
    [0.14, 0.74],
    [-0.14, 0.76],
    [-0.32, 0.5],
  ];
  p.mirrorZ((h) => {
    h.plate('ceramic', arm, 0.08, { z: 0.43 }, { c: 0.014 });
    h.plate('gunmetal', inset(arm, 0.06), 0.03, { z: 0.48 }, { c: 0.006, imp: 'minor' });
    h.cylZ('bronze', 0.11, 0.06, 0, 0.5, 0.505, { seg: 32 });
    h.cylZ('gunmetal', 0.06, 0.04, 0, 0.5, 0.55, { seg: 20, imp: 'minor' });
    for (let k = 0; k < 6; k++) h.bolt('dark', [Math.cos((k * PI) / 3) * 0.085, 0.5 + Math.sin((k * PI) / 3) * 0.085, 0.535], 0.011, [0, 0, 1]);
    h.tube('bronze', 0.018, 0.52, { x: -0.3, y: 0.3, z: 0.49, rz: 0.55 }, { seg: 8, imp: 'fine' });
    h.box('gunmetal', 0.05, 0.14, 0.02, { x: 0.17, y: 0.26, z: 0.475 }, { imp: 'minor', c: 0.004 });
    h.box('glow', 0.022, 0.1, 0.012, { x: 0.17, y: 0.28, z: 0.486 }, { imp: 'minor', c: 0.002 });
  });
  // rear sensor box
  p.box('gunmetal', 0.22, 0.26, 0.42, { x: -0.44, y: 0.24 }, { c: 0.012, imp: 'minor' });
  p.box('glow', 0.1, 0.012, 0.16, { x: -0.44, y: 0.5 }, { imp: 'minor', c: 0.002 });
}

/** Flat artillery deck: wide octagonal deck, split gun shield, trunnion posts, ammunition rack. */
function deck(p: PB): void {
  p.prism('gunmetal', 8, 0.8, 0.05, {}, { c: 0.01 });
  p.prism('ceramic', 8, 0.9, 0.08, { y: 0.05 }, { c: 0.016 });
  for (let k = 0; k < 8; k++) p.bolt('bronze', polarPos((k * PI) / 4 + OCT, 0.76, 0, 0.13), 0.016);
  for (const x of [-0.3, 0.05]) p.box('dark', 0.008, 0.004, 1.2, { x, y: 0.13 }, { imp: 'fine', c: 0 });
  p.mirrorZ((h) => {
    h.prof(
      'ceramic',
      [
        [0.34, 0.13],
        [0.58, 0.13],
        [0.5, 0.62],
        [0.4, 0.62],
      ],
      0.26,
      { z: 0.34 },
      { c: 0.014 },
    );
    h.box('gunmetal', 0.13, 0.03, 0.28, { x: 0.45, y: 0.62, z: 0.34 }, { imp: 'minor', c: 0.006 });
    for (const y of [0.22, 0.42]) h.bolt('bronze', [0.56 - (y - 0.13) * 0.16, y, 0.4], 0.015, [1, 0.16, 0]);
    h.box('gunmetal', 0.2, 0.3, 0.07, { x: 0, y: 0.13, z: 0.3 }, { c: 0.01 });
    h.cylZ('bronze', 0.08, 0.05, 0, 0.4, 0.345, { seg: 24, imp: 'minor' });
    h.box('glow', 0.012, 0.025, 0.2, { ...polar(-PI / 4, 0.834), y: 0.08 }, { imp: 'minor', c: 0.002 });
  });
  for (const z of [-0.3, -0.1, 0.1, 0.3]) {
    p.box('bronze', 0.16, 0.18, 0.16, { x: -0.6, y: 0.13, z }, { c: 0.01, imp: 'minor' });
    for (const dz of [-0.04, 0.04]) p.cylY('dark', 0.03, 0.03, 0.01, { x: -0.6, y: 0.31, z: z + dz }, { seg: 10, imp: 'fine' });
  }
  for (let k = 0; k <= 4; k++) p.cylY('bronze', 0.012, 0.012, 0.25, { ...polar(PI / 2 + (k * PI) / 4, 0.8), y: 0.13 }, { seg: 6, imp: 'fine' });
}

/** Beam emitter housing: tall gunmetal core, panelled ivory shell, bronze coils, fins, spike. */
function emitter(p: PB): void {
  p.cylY('gunmetal', 0.3, 0.3, 0.92, {}, { seg: 40, imp: 'minor' });
  for (const [y0, h] of [
    [0.04, 0.24],
    [0.56, 0.3],
  ] as const) {
    if (p.full) for (let k = 0; k < 6; k++) p.lathe('ceramic', ring(0.3, 0.37, h, 0.012), { y: y0 }, { seg: 10, phi: [(k * PI) / 3 + 0.03, PI / 3 - 0.06], wear: [1, 3] });
    else p.lathe('ceramic', ring(0.3, 0.37, h, 0.012), { y: y0 }, { seg: 48, imp: 'minor' });
  }
  for (const y of [0.29, 0.49]) p.lathe('bronze', ring(0.32, 0.41, 0.06, 0.012), { y }, { seg: 48, wear: [1, 3], imp: 'minor' });
  for (const y of [0.17, 0.72]) p.cylY('glow', 0.374, 0.374, 0.02, { y }, { seg: 40, imp: 'minor', open: true });
  p.cylY('ceramic', 0.37, 0.37, 0.9, {}, { seg: 40, imp: 'simple' });
  // front collar with the gun slot
  p.box('gunmetal', 0.14, 0.4, 0.3, { x: 0.37, y: 0.22 }, { c: 0.014 });
  p.box('dark', 0.02, 0.32, 0.1, { x: 0.44, y: 0.26 }, { imp: 'minor', c: 0.003 });
  // top cap and spike
  p.lathe(
    'bronze',
    [
      [0.37, 0.86],
      [0.37, 0.9],
      [0.3, 0.98],
      [0.12, 1.02],
      [0, 1.02],
    ],
    {},
    { seg: 48, wear: [1] },
  );
  p.cylY('gunmetal', 0.025, 0.035, 0.22, { y: 1.02 }, { seg: 12, imp: 'minor' });
  p.cylY('glow', 0.04, 0.04, 0.04, { y: 1.24 }, { seg: 12, imp: 'minor' });
  // radiator fins round the back
  for (let k = 0; k < 7; k++) p.box('gunmetal', 0.13, 0.46, 0.025, { ...polar(PI * 0.62 + (k * PI * 0.76) / 6, 0.39), y: 0.06 }, { imp: 'minor', c: 0.004 });
  for (let k = 0; k < 12; k++) p.bolt('bronze', polarPos((k * PI) / 6, 0.39, 0, 0.35), 0.012, polarPosDir((k * PI) / 6));
}

function polarPosDir(a: number): [number, number, number] {
  return [Math.cos(a), 0, -Math.sin(a)];
}

/** Sensor mast head: compact sloped body, mantlet, tall mast with radar panel and dish. */
function mastHead(p: PB): void {
  p.box('gunmetal', 0.92, 0.05, 0.78, { x: -0.06 }, { c: 0.012 });
  for (const x of [-0.42, 0.3]) for (const z of [-0.34, 0.34]) p.bolt('bronze', [x, 0.05, z], 0.016);
  p.prof(
    'ceramic',
    [
      [-0.5, 0.05],
      [0.3, 0.05],
      [0.42, 0.16],
      [0.34, 0.4],
      [-0.46, 0.42],
    ],
    0.72,
    {},
    { c: 0.016 },
  );
  p.box('gunmetal', 0.12, 0.28, 0.46, { x: 0.42, y: 0.12 }, { c: 0.014 });
  p.box('dark', 0.02, 0.2, 0.12, { x: 0.485, y: 0.16 }, { imp: 'minor', c: 0.003 });
  p.mirrorZ((h) => h.box('glow', 0.012, 0.03, 0.1, { x: 0.375, y: 0.3, z: 0.24, rz: 0.32 }, { imp: 'minor', c: 0.002 }));
  // mast
  p.cylY('gunmetal', 0.04, 0.055, 1.25, { x: -0.36, y: 0.41 }, { seg: 20 });
  for (const y of [0.62, 0.92, 1.18]) p.cylY('bronze', 0.068, 0.068, 0.04, { x: -0.36, y }, { seg: 20, imp: 'minor' });
  p.box('ceramic', 0.06, 0.24, 0.66, { x: -0.36, y: 1.36 }, { c: 0.01 });
  p.box('dark', 0.01, 0.18, 0.58, { x: -0.325, y: 1.39 }, { imp: 'minor', c: 0.002 });
  // side arm with a dish, beacon, whip aerial
  p.beam('gunmetal', [-0.36, 1.0, 0], [-0.36, 1.0, 0.34], 0.035, 0.035, { imp: 'minor', c: 0.004 });
  const dish: Pt[] = [
    [0, 0],
    [0.08, 0.02],
    [0.14, 0.06],
    [0.15, 0.068],
  ];
  p.lathe('bronze', dish, { x: -0.33, y: 1.0, z: 0.38 }, { axis: 'x', smooth: true, seg: 24, imp: 'minor' });
  p.lathe('gunmetal', [...dish].reverse(), { x: -0.334, y: 1.0, z: 0.38 }, { axis: 'x', smooth: true, seg: 24, imp: 'minor' });
  p.cylY('glow', 0.03, 0.03, 0.04, { x: -0.36, y: 1.66 }, { seg: 12, imp: 'minor' });
  p.cylY('gunmetal', 0.008, 0.008, 0.45, { x: -0.12, y: 0.41, z: -0.25 }, { seg: 6, imp: 'fine' });
}

// ---- weapons (cradle space) ----------------------------------------------------------------------

function twinMount(p: PB): void {
  p.box('gunmetal', 0.34, 0.26, 0.42, { y: -0.16 }, { c: 0.014 });
  p.cylZ('bronze', 0.075, 0.6, 0, 0, 0, { seg: 28 });
  p.mirrorZ((h) => {
    h.tube('gunmetal', 0.072, 0.4, { x: 0.12, z: 0.13 }, { seg: 28 });
    h.lathe('bronze', ring(0.05, 0.086, 0.05, 0.008), { x: 0.5, z: 0.13 }, { axis: 'x', seg: 28, wear: [1, 3], imp: 'minor' });
    for (let k = 0; k < 4; k++) h.bolt('dark', [0.0 + Math.cos((k * PI) / 2) * 0.05, Math.sin((k * PI) / 2) * 0.05, 0.3], 0.01, [0, 0, 1]);
  });
  p.box('gunmetal', 0.16, 0.06, 0.06, { x: -0.02, y: 0.1, z: 0.26 }, { imp: 'minor', c: 0.006 });
  p.box('glow', 0.012, 0.03, 0.04, { x: 0.065, y: 0.115, z: 0.26 }, { imp: 'minor', c: 0.002 });
}

function twinGun(p: PB): void {
  p.mirrorZ((h) => {
    h.box('gunmetal', 0.24, 0.13, 0.12, { x: -0.18, y: -0.065, z: 0.13 }, { c: 0.012 });
    h.box('dark', 0.07, 0.04, 0.01, { x: -0.2, y: -0.01, z: 0.191 }, { imp: 'fine', c: 0.002 });
    h.tube('ceramic', 0.052, 0.82, { x: 0.18, z: 0.13 }, { seg: 32, r2: 0.046 });
    h.lathe('bronze', ring(0.046, 0.06, 0.03, 0.005), { x: 0.62, z: 0.13 }, { axis: 'x', seg: 28, wear: [1, 3], imp: 'minor' });
    h.box('dark', 0.26, 0.012, 0.012, { x: 0.82, y: 0.04, z: 0.13 }, { imp: 'fine', c: 0.002 });
    h.lathe('gunmetal', ring(0.03, 0.064, 0.14, 0.01), { x: 1.0, z: 0.13 }, { axis: 'x', seg: 32, wear: [1, 3] });
    h.cylY('dark', 0.03, 0.03, 0.002, { x: 1.141, z: 0.13, rz: -PI / 2 }, { seg: 16, imp: 'minor' });
  });
}

function howitzerMount(p: PB): void {
  p.box('gunmetal', 0.44, 0.3, 0.44, { x: -0.02, y: -0.2 }, { c: 0.016 });
  p.cylZ('bronze', 0.12, 0.56, 0, 0, 0, { seg: 32 });
  p.cylZ('gunmetal', 0.07, 0.62, 0, 0, 0, { seg: 20, imp: 'minor' });
  p.tube('gunmetal', 0.17, 0.34, { x: 0.1 }, { seg: 36 });
  p.lathe('bronze', ring(0.15, 0.19, 0.05, 0.008), { x: 0.4 }, { axis: 'x', seg: 36, wear: [1, 3], imp: 'minor' });
  p.mirrorZ((h) => {
    h.tube('bronze', 0.045, 0.5, { x: -0.1, y: 0.2, z: 0.1 }, { seg: 16 });
    h.tube('gunmetal', 0.055, 0.05, { x: 0.4, y: 0.2, z: 0.1 }, { seg: 16, imp: 'minor' });
    h.box('gunmetal', 0.06, 0.08, 0.05, { x: -0.1, y: 0.12, z: 0.1 }, { imp: 'minor', c: 0.006 });
  });
}

function howitzerGun(p: PB): void {
  p.box('gunmetal', 0.3, 0.3, 0.3, { x: -0.3, y: -0.15 }, { c: 0.02 });
  for (const y of [-0.08, 0.08]) for (const z of [-0.08, 0.08]) p.bolt('bronze', [-0.452, y, z], 0.016, [-1, 0, 0]);
  p.box('bronze', 0.06, 0.32, 0.32, { x: -0.13, y: -0.16 }, { c: 0.012, imp: 'minor' });
  p.tube('ceramic', 0.135, 0.72, { x: 0.04 }, { seg: 40, r2: 0.115 });
  p.lathe('gunmetal', ring(0.11, 0.135, 0.04, 0.006), { x: 0.5 }, { axis: 'x', seg: 40, wear: [1, 3], imp: 'minor' });
  p.lathe(
    'gunmetal',
    [
      [0.09, 0],
      [0.12, 0],
      [0.165, 0.05],
      [0.172, 0.15],
      [0.15, 0.19],
      [0.09, 0.19],
    ],
    { x: 0.76 },
    { axis: 'x', seg: 40, wear: [1, 4] },
  );
  p.cylY('dark', 0.09, 0.09, 0.002, { x: 0.951, rz: -PI / 2 }, { seg: 20, imp: 'minor' });
}

function rotaryMount(p: PB): void {
  p.lathe(
    'gunmetal',
    [
      [0, 0],
      [0.15, 0],
      [0.175, 0.025],
      [0.175, 0.38],
      [0.15, 0.42],
      [0, 0.42],
    ],
    { x: -0.2 },
    { axis: 'x', seg: 40, wear: [1, 3] },
  );
  p.lathe('bronze', ring(0.08, 0.15, 0.05, 0.008), { x: 0.22 }, { axis: 'x', seg: 36, wear: [1, 3], imp: 'minor' });
  p.cylZ('gunmetal', 0.08, 0.48, 0, 0, 0, { seg: 24 });
  p.box('bronze', 0.26, 0.12, 0.2, { x: -0.06, y: -0.28 }, { c: 0.012, imp: 'minor' });
  // ammunition feed chute curling back from the drum
  p.box('gunmetal', 0.1, 0.1, 0.14, { x: 0.02, y: -0.05, z: 0.2 }, { imp: 'minor', c: 0.008 });
  p.box('gunmetal', 0.32, 0.1, 0.1, { x: -0.18, y: -0.05, z: 0.3 }, { imp: 'minor', c: 0.008 });
  p.box('glow', 0.03, 0.03, 0.03, { x: 0.05, y: 0.168 }, { imp: 'minor', c: 0.004 });
  for (let k = 0; k < 8; k++) p.bolt('bronze', [-0.2, Math.cos((k * PI) / 4) * 0.13, Math.sin((k * PI) / 4) * 0.13], 0.011, [-1, 0, 0]);
}

function rotaryGun(p: PB): void {
  p.tube('gunmetal', 0.03, 1.0, { x: 0.2 }, { seg: 12, imp: 'minor' });
  for (let k = 0; k < 6; k++) {
    const y = Math.cos((k * PI) / 3) * 0.075;
    const z = Math.sin((k * PI) / 3) * 0.075;
    p.tube('gunmetal', 0.027, 1.0, { x: 0.2, y, z }, { seg: 16, imp: 'minor' });
    p.cylY('dark', 0.018, 0.018, 0.002, { x: 1.201, y, z, rz: -PI / 2 }, { seg: 10, imp: 'fine' });
  }
  p.tube('gunmetal', 0.1, 1.0, { x: 0.2 }, { seg: 40, imp: 'simple' });
  for (const x of [0.45, 0.95]) p.tube('ceramic', 0.12, 0.05, { x }, { seg: 32 });
  p.lathe('bronze', ring(0.09, 0.112, 0.04, 0.006), { x: 1.12 }, { axis: 'x', seg: 32, wear: [1, 3], imp: 'minor' });
}

function missileMount(p: PB): void {
  p.box('ceramic', 0.72, 0.5, 0.6, { x: 0.12, y: -0.25 }, { c: 0.024 });
  p.box('gunmetal', 0.04, 0.48, 0.58, { x: 0.49, y: -0.24 }, { c: 0.008 });
  for (const y of [-0.12, 0.12])
    for (const z of [-0.18, 0, 0.18]) {
      p.cylY('dark', 0.072, 0.072, 0.012, { x: 0.505, y, z, rz: -PI / 2 }, { seg: 20, imp: 'minor' });
      p.tube('bronze', 0.055, 0.1, { x: 0.5, y, z }, { seg: 16, r2: 0.012, imp: 'minor' });
    }
  p.cylZ('bronze', 0.09, 0.74, 0, 0, 0, { seg: 28 });
  p.mirrorZ((h) => {
    h.box('gunmetal', 0.5, 0.06, 0.02, { x: 0.1, y: -0.05, z: 0.305 }, { imp: 'minor', c: 0.004 });
    h.box('glow', 0.12, 0.02, 0.012, { x: -0.1, y: 0.13, z: 0.305 }, { imp: 'minor', c: 0.002 });
    for (const x of [-0.16, 0.36]) for (const y of [-0.2, 0.18]) h.bolt('bronze', [x, y, 0.301], 0.012, [0, 0, 1]);
  });
  p.box('gunmetal', 0.12, 0.3, 0.4, { x: -0.28, y: -0.15 }, { imp: 'minor', c: 0.01 });
  for (const z of [-0.1, 0.1]) p.box('dark', 0.5, 0.006, 0.012, { x: 0.12, y: 0.25, z }, { imp: 'fine', c: 0 });
}

function beamMount(p: PB): void {
  p.box('gunmetal', 0.26, 0.24, 0.38, { x: -0.06, y: -0.12 }, { c: 0.014 });
  p.cylZ('bronze', 0.08, 0.5, 0, 0, 0, { seg: 24 });
  p.tube('gunmetal', 0.12, 0.92, { x: -0.22 }, { seg: 36, r2: 0.085 });
  const rAt = (x: number) => 0.12 - ((x + 0.22) / 0.92) * 0.035;
  for (const x of [0.12, 0.27, 0.42, 0.57]) p.lathe('bronze', ring(rAt(x) - 0.01, rAt(x) + 0.045, 0.06, 0.01), { x }, { axis: 'x', seg: 36, wear: [1, 3], imp: 'minor' });
  for (const x of [0.2, 0.35, 0.5]) p.tube('glow', rAt(x) + 0.01, 0.03, { x }, { seg: 28, imp: 'minor' });
}

function beamLens(p: PB): void {
  p.lathe(
    'gunmetal',
    [
      [0.07, 0],
      [0.11, 0],
      [0.165, 0.08],
      [0.175, 0.15],
      [0.15, 0.18],
      [0.12, 0.18],
    ],
    { x: 0.68 },
    { axis: 'x', seg: 40, wear: [1, 4] },
  );
  p.cylY('glow', 0.12, 0.12, 0.012, { x: 0.83, rz: -PI / 2 }, { seg: 32 });
  for (let k = 0; k < 4; k++) {
    const a = (k * PI) / 2 + PI / 4;
    p.box('bronze', 0.16, 0.025, 0.025, { x: 0.8, y: Math.cos(a) * 0.15 - 0.0125, z: Math.sin(a) * 0.15 }, { imp: 'minor', c: 0.004 });
  }
}

function flakMount(p: PB): void {
  p.box('gunmetal', 0.36, 0.3, 0.3, { y: -0.17 }, { c: 0.014 });
  p.cylZ('gunmetal', 0.05, 0.72, 0, 0, 0, { seg: 20 });
  p.mirrorZ((h) => {
    h.cylZ('bronze', 0.13, 0.1, 0, -0.03, 0.25, { seg: 32 });
    h.cylZ('gunmetal', 0.06, 0.03, 0, -0.03, 0.315, { seg: 20, imp: 'minor' });
    for (let k = 0; k < 5; k++) h.bolt('dark', [Math.cos((k * 2 * PI) / 5) * 0.095, -0.03 + Math.sin((k * 2 * PI) / 5) * 0.095, 0.3], 0.01, [0, 0, 1]);
  });
  p.box('gunmetal', 0.04, 0.28, 0.3, { x: 0.2, y: -0.14 }, { c: 0.006, imp: 'minor' });
  p.box('gunmetal', 0.04, 0.12, 0.012, { x: -0.04, y: 0.13 }, { imp: 'minor', c: 0.003 });
  p.box('glow', 0.03, 0.03, 0.016, { x: -0.04, y: 0.25 }, { imp: 'minor', c: 0.003 });
}

function flakGun(p: PB): void {
  for (const y of [-0.075, 0.075])
    for (const z of [-0.085, 0.085]) {
      p.tube('gunmetal', 0.022, 0.92, { x: 0.18, y, z }, { seg: 14, imp: 'minor' });
      p.tube('ceramic', 0.04, 0.36, { x: 0.18, y, z }, { seg: 20, imp: 'minor' });
      p.tube('bronze', 0.03, 0.07, { x: 1.06, y, z }, { seg: 14, imp: 'minor' });
      for (const x of [0.28, 0.4]) p.tube('dark', 0.042, 0.012, { x, y, z }, { seg: 20, imp: 'fine' });
    }
  p.box('ceramic', 0.36, 0.22, 0.26, { x: 0.36, y: -0.11 }, { imp: 'simple' });
  p.box('gunmetal', 0.6, 0.1, 0.2, { x: 0.82, y: -0.05 }, { imp: 'simple' });
}

// ---- the kit ----------------------------------------------------------------------------------------

/** W20's frame: seat 0.475, ring 0.135 tall, cheeks from 0.61, trunnion 0.95. */
export const W20_FRAME = { baseTop: 0.475, ringH: 0.135, headAnchor: 0.475 + 0.135, trunnion: 0.95 };

export const BASES: BaseSpec[] = [
  { id: 'octagon', name: 'Octagonal stepped base (W20)', top: W20_FRAME.baseTop, w20: true },
  { id: 'bunker', name: 'Square bunker', top: 0.5, build: bunker },
  { id: 'drum', name: 'Low ring drum', top: 0.26, build: drum },
  { id: 'pylon', name: 'Tall pylon', top: 1.12, build: pylon },
];

export const RINGS: RingSpec[] = [
  { id: 'toothed', name: 'Toothed slewing ring (W20)', anchor: W20_FRAME.baseTop, height: W20_FRAME.ringH, w20: true },
  { id: 'collar', name: 'Armoured collar', anchor: 0, height: 0.2, build: collar },
  { id: 'turntable', name: 'Flat turntable', anchor: 0, height: 0.09, build: turntable },
];

export const HEADS: HeadSpec[] = [
  { id: 'cheek', name: 'Cheek-armour head (W20)', anchor: W20_FRAME.headAnchor, trunnion: W20_FRAME.trunnion, w20: true },
  { id: 'dome', name: 'Rounded dome', anchor: 0, trunnion: 0.34, build: dome },
  { id: 'box', name: 'Twin-gun box', anchor: 0, trunnion: 0.26, build: boxHead },
  { id: 'yoke', name: 'Missile yoke', anchor: 0, trunnion: 0.5, build: yoke },
  { id: 'deck', name: 'Artillery deck', anchor: 0, trunnion: 0.4, build: deck },
  { id: 'emitter', name: 'Beam emitter housing', anchor: 0, trunnion: 0.42, build: emitter },
  { id: 'mast', name: 'Sensor mast head', anchor: 0, trunnion: 0.28, build: mastHead },
];

export const WEAPONS: WeaponSpec[] = [
  { id: 'long', name: 'Long barrel, muzzle brake (W20)', motion: 'recoil', recoilScale: 1, muzzle: [1.493, 0, 0], w20: true },
  { id: 'twin', name: 'Twin barrels', motion: 'recoil', recoilScale: 0.8, muzzle: [1.142, 0, 0.13], mount: twinMount, gun: twinGun },
  { id: 'howitzer', name: 'Short howitzer', motion: 'recoil', recoilScale: 1.5, muzzle: [0.95, 0, 0], mount: howitzerMount, gun: howitzerGun },
  { id: 'rotary', name: 'Rotary cluster', motion: 'spin', recoilScale: 0, muzzle: [1.2, 0, 0], mount: rotaryMount, gun: rotaryGun },
  { id: 'missiles', name: 'Missile pod', motion: 'none', recoilScale: 0, muzzle: [0.6, 0, 0], mount: missileMount },
  { id: 'beam', name: 'Beam lens', motion: 'none', recoilScale: 0, muzzle: [0.85, 0, 0], mount: beamMount, gun: beamLens },
  { id: 'flak', name: 'Flak quad', motion: 'recoil', recoilScale: 0.5, muzzle: [1.13, 0.075, 0.085], mount: flakMount, gun: flakGun },
];

/** Builds one level of a part description. */
export function buildLevel(fn: Build, lv: Lv): PB {
  const p = new PB(lv);
  fn(p);
  return p;
}
