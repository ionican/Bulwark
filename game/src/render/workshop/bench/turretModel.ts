// Ported from look/src/bench/turretModel.ts for W24 run 2a (game/src/render/workshop/README: copies, adapted only where noted).
// W20 gun turret, full detail, modelled on look/reference/02-gun-turret.png. Code-built: every
// piece below is a chamfered extrusion, lathe band, toothed ring or annular sector from geo.ts /
// kit.ts; surfaces come from surface.ts. Turret space: +Y up, origin at the ground centre, barrel
// along +X at yaw 0, 1 unit = 1 tile = 2 m. Footprint 2 × 2 tiles.
//
// Parts and how each one moves:
//   base    static: stepped octagonal plinth — gunmetal footing with four bolted feet, eight
//           ivory armour segments (two panels per side) with gunmetal pilasters at the corners,
//           ivory upper deck, gunmetal bearing seat, four bronze brackets with gunmetal latches,
//           pinion housing, cyan indicator light.
//   pinion  spins about its own vertical axis, geared to the slewing ring (56 : 12).
//   ring    yaw: toothed slewing ring over a bronze bearing band, bolt circle on top.
//   head    yaw: two plated cheek blocks (ivory plates over a gunmetal core, seams open to the
//           core), rear housing, roof hatch, bronze hinges and clamps, cyan slits.
//   cradle  pitch about the trunnion axis: bronze trunnion rings with gunmetal hubs, cradle
//           block, ribbed recoil housing, bronze recuperator.
//   barrel  recoil along −X inside the cradle: breech block with ejection port, ivory sleeve with
//           dark slots, slotted gunmetal muzzle brake with an open bore.

import { BufferGeometry, Matrix4, type Material } from 'three';
import { cbox, cyl, prism, profile, tubeX } from '../models/kit.ts';
// Adapted: W20's gun spec (bench/brain.ts) is not ported; the two dimensions the model uses.
const GUN = { trunnionHeight: 0.95, barrelLength: 1.493 } as const;
import { TB, addLathe, boltMatrix, clipLeft, inset, latheBands, plate, ringProfile, sectorX, toothedRing, wedge, type BoltSpec, type Pt } from './geo.ts';
import type { TurretMats } from './surface.ts';

export interface BuiltPart {
  name: string;
  geometry: BufferGeometry;
  material: Material[];
  bolts: BoltSpec[];
}

export interface TurretModel {
  base: BuiltPart;
  pinion: BuiltPart;
  ring: BuiltPart;
  head: BuiltPart;
  cradle: BuiltPart;
  barrel: BuiltPart;
  /** Pinion axis position (turret space) and gear ratio (pinion turns per ring turn). */
  pinionAt: [number, number, number];
  pinionRatio: number;
  /** Trunnion (pitch axis) height, turret space. */
  trunnionY: number;
  /** In cradle space (origin on the trunnion, +X along the bore) at rest. */
  muzzle: [number, number, number];
  /** Port centres along the brake (cradle-space x), for side flashes. */
  brakePorts: number[];
  brakeRadius: number;
  /** Ejection port (barrel space) and its outward direction. */
  ejectPort: [number, number, number];
  /** Height of the top of the turret (construction animation). */
  top: number;
}

const OCT = Math.PI / 8;
/** World angle a ↔ direction (cos a, 0, −sin a); a Tf with ry = a turns local +X onto it. */
function polar(a: number, r: number, lateral = 0, y = 0) {
  return { x: Math.cos(a) * r + Math.sin(a) * lateral, y, z: -Math.sin(a) * r + Math.cos(a) * lateral, ry: a };
}
function polarPos(a: number, r: number, lateral: number, y: number): [number, number, number] {
  const p = polar(a, r, lateral, y);
  return [p.x, p.y, p.z];
}

const RING_TEETH = 44;
const PINION_TEETH = 12;

function finishPart(name: string, b: TB, mats: TurretMats): BuiltPart {
  const { geometry, material } = b.build(mats);
  return { name, geometry, material, bolts: b.bolts };
}

// ---- base -------------------------------------------------------------------------------------
const PLINTH_H = 0.075;
const ARMOUR_H = 0.3;
const R_FACE = 0.86; // apothem of the armour faces
const DECK_Y = PLINTH_H + ARMOUR_H;
const DECK_H = 0.04;
const SEAT_Y = DECK_Y + DECK_H; // 0.445
const SEAT_H = 0.03;
const RING_Y = SEAT_Y + SEAT_H; // 0.475: the yawing ring starts here
// slewing ring radii: bronze bearing band, toothed ring (teeth tips), turntable
const R_BAND = 0.5;
const R_GEAR = 0.535;
const R_TABLE = 0.46;
const HEAD_Y = RING_Y + 0.135; // 0.61: cheeks stand on the turntable

function base(mats: TurretMats): { part: BuiltPart; pinionAt: [number, number, number] } {
  const b = new TB();
  // gunmetal footing: octagon plinth with a rivet line on the top edge
  b.add('gunmetal', prism(8, 1.0, PLINTH_H, 0.018));
  for (let i = 0; i < 8; i++) {
    const f = i * (Math.PI / 4);
    for (const l of [-0.22, 0, 0.22]) b.bolt('gunmetal', polarPos(f, 0.89, l, PLINTH_H), 0.014);
  }
  // four bolted feet at alternate corners: stepped gunmetal slab and bracket, two bronze bolts
  for (let k = 0; k < 4; k++) {
    const a = OCT + k * (Math.PI / 2);
    b.add('gunmetal', cbox(0.42, 0.095, 0.48, 0.02, 0.085), polar(a, 0.95));
    b.add('gunmetal', cbox(0.18, 0.055, 0.26, 0.012, 0.03), { ...polar(a, 1.04), y: 0.095 });
    for (const l of [-0.155, 0.155]) {
      b.add('bronze', cyl(0.062, 0.062, 0.014, 14), { ...polar(a, 1.02, l), y: 0.095 });
      b.bolt('bronze', polarPos(a, 1.02, l, 0.109), 0.042, [0, 1, 0], k + l);
    }
  }
  // gunmetal core behind the armour (shows through the seams and at the corners)
  b.add('gunmetal', prism(8, (R_FACE - 0.035) / Math.cos(OCT), ARMOUR_H * 0.62, 0.01), { y: PLINTH_H });
  // eight sides, two ivory panels each: radial profile (vertical face, chamfer, top sloping up
  // towards the ring), turned into a wedge so the ends lie on radii and the panels tile the octagon
  const rIn = 0.55;
  const half = R_FACE * Math.tan(OCT); // half side length at the face
  const gap = 0.006;
  const pil = 0.06; // half width kept clear for the pilaster at each corner
  const panelW = half - pil - gap;
  for (let i = 0; i < 8; i++) {
    const f = i * (Math.PI / 4);
    for (const s of [-1, 1]) {
      const g = profile(
        [
          [rIn, 0],
          [R_FACE, 0],
          [R_FACE, ARMOUR_H * 0.64],
          [R_FACE - 0.05, ARMOUR_H * 0.76],
          [rIn + 0.03, ARMOUR_H],
          [rIn, ARMOUR_H],
        ],
        panelW,
        0.014,
      );
      g.translate(0, 0, s * (gap + panelW / 2));
      wedge(g, R_FACE);
      g.userData.chamfered = true;
      b.add('ceramic', g, { y: PLINTH_H, ry: f });
    }
  }
  // gunmetal pilasters at the eight corners: back block, two posts and a dark channel, cap
  const rV = R_FACE / Math.cos(OCT);
  for (let i = 0; i < 8; i++) {
    const v = OCT + i * (Math.PI / 4);
    const h = ARMOUR_H * 0.64;
    b.add('gunmetal', cbox(0.1, h, 0.15, 0.012), { ...polar(v, rV - 0.045), y: PLINTH_H });
    for (const l of [-0.048, 0.048]) b.add('gunmetal', cbox(0.04, h + 0.01, 0.034, 0.008), { ...polar(v, rV + 0.012, l), y: PLINTH_H });
    b.add('dark', cbox(0.01, h - 0.03, 0.062, 0.002), { ...polar(v, rV + 0.004), y: PLINTH_H + 0.015 });
    b.add('gunmetal', cbox(0.13, 0.03, 0.17, 0.01), { ...polar(v, rV - 0.035), y: PLINTH_H + h + 0.005 });
    b.bolt('bronze', polarPos(v, rV + 0.033, 0, PLINTH_H + h * 0.82), 0.016, polarDir(v), 0.3);
  }
  // cyan indicator light on one panel, in a gunmetal bezel
  {
    const f = -Math.PI / 4;
    b.add('gunmetal', cbox(0.014, 0.06, 0.06, 0.004), { ...polar(f, R_FACE + 0.001, 0.25), y: PLINTH_H + 0.095 });
    b.add('glow', cbox(0.008, 0.032, 0.032, 0.002), { ...polar(f, R_FACE + 0.012, 0.25), y: PLINTH_H + 0.109 });
  }
  // upper deck and bearing seat
  b.add('ceramic', prism(8, 0.6, DECK_H, 0.012), { y: DECK_Y });
  b.add('gunmetal', cyl(R_BAND - 0.01, R_BAND - 0.01, SEAT_H, 48), { y: SEAT_Y });
  // four bronze brackets hugging the ring, gunmetal latches with a dark slot, two bolts each
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
    b.add('bronze', plate(pr, 0.18, 0.01), { ...polar(a, 0), y: SEAT_Y - 0.002 });
    b.add('gunmetal', cbox(0.06, 0.13, 0.1, 0.01), { ...polar(a, R_GEAR + 0.045), y: SEAT_Y + 0.07 });
    b.add('dark', cbox(0.004, 0.022, 0.05, 0.001), { ...polar(a, R_GEAR + 0.076), y: SEAT_Y + 0.15 });
    for (const l of [-0.058, 0.058]) b.bolt('bronze', polarPos(a, R_GEAR + 0.12, l, SEAT_Y + 0.033), 0.022, [0, 1, 0], 0.4);
  }
  // pinion housing at the rear left: gunmetal box over the pinion, bronze cap
  const pa = (Math.PI * 3) / 4 + OCT;
  const pinionR = R_GEAR + 0.075 - 0.03;
  b.add('gunmetal', cbox(0.2, 0.05, 0.24, 0.012), { ...polar(pa, pinionR + 0.02), y: SEAT_Y - 0.002 });
  b.add('gunmetal', cbox(0.2, 0.06, 0.24, 0.012), { ...polar(pa, pinionR + 0.02), y: RING_Y + 0.085 });
  b.add('gunmetal', cbox(0.05, 0.14, 0.2, 0.01), { ...polar(pa, pinionR + 0.11), y: SEAT_Y + 0.03 });
  b.add('bronze', cyl(0.05, 0.055, 0.035, 16), { ...polar(pa, pinionR), y: RING_Y + 0.145 });
  for (const l of [-0.08, 0.08]) b.bolt('bronze', polarPos(pa, pinionR + 0.07, l, RING_Y + 0.145), 0.016);
  return { part: finishPart('base', b, mats), pinionAt: polarPos(pa, pinionR, 0, RING_Y + 0.03) };
}

function polarDir(a: number): [number, number, number] {
  return [Math.cos(a), 0, -Math.sin(a)];
}

function pinion(mats: TurretMats): BuiltPart {
  const b = new TB();
  b.add('bronze', toothedRing(0.012, 0.075, PINION_TEETH, 0.06, 0.022, 0.004, 16));
  b.add('gunmetal', cyl(0.03, 0.03, 0.115, 12), { y: -0.01 });
  return finishPart('pinion', b, mats);
}

// ---- slewing ring (yaw) -----------------------------------------------------------------------
function ring(mats: TurretMats): BuiltPart {
  const b = new TB();
  // bronze bearing band with a groove, gunmetal race under it
  addLathe(b, 'bronze', ringProfile(0.38, R_BAND, 0.05, 0.008).slice(1, 5), 56, { y: RING_Y }, { wearBands: [0, 2] });
  b.add('dark', cyl(R_BAND + 0.003, R_BAND + 0.003, 0.006, 56, true), { y: RING_Y + 0.022 });
  // toothed slewing ring
  b.add('gunmetal', toothedRing(0.34, R_GEAR, RING_TEETH, 0.07, 0.04, 0.006, 24), { y: RING_Y + 0.05 });
  // turntable seat and the bolt circle that shows the ring turning
  addLathe(b, 'gunmetal', ringProfile(0.25, R_TABLE, 0.02, 0.006).slice(2, 6), 48, { y: RING_Y + 0.12 }, { wearBands: [1] });
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    b.bolt('bronze', polarPos(a, R_TABLE + 0.024, 0, RING_Y + 0.12), 0.017, [0, 1, 0], a);
  }
  // dark well inside the ring (looking down past the gun)
  b.add('dark', cyl(0.34, 0.34, 0.01, 32), { y: RING_Y + 0.02 });
  return finishPart('ring', b, mats);
}

// ---- head (yaw) -------------------------------------------------------------------------------
/** Cheek outline, side view (x forward, y up), counter-clockwise, turret-space heights. */
const CH = 0.68; // cheek height
const CHEEK: Pt[] = [
  [-0.66, HEAD_Y],
  [0.17, HEAD_Y],
  [0.27, HEAD_Y + 0.1],
  [0.27, HEAD_Y + 0.33],
  [0.10, HEAD_Y + 0.62],
  [-0.43, HEAD_Y + CH],
  [-0.66, HEAD_Y + 0.56],
  [-0.74, HEAD_Y + 0.31],
  [-0.73, HEAD_Y + 0.1],
];
const CHEEK_IN = 0.235; // inner face z
const CHEEK_OUT = 0.575; // outer face z (side plates)
const ROOF_Y = HEAD_Y + 0.6;

/** Point at fraction u along cheek edge i (CHEEK[i] → CHEEK[i+1]) and the edge's angle. */
function onEdge(i: number, u: number): { x: number; y: number; ang: number } {
  const a = CHEEK[i]!;
  const c = CHEEK[(i + 1) % CHEEK.length]!;
  return { x: a[0] + (c[0] - a[0]) * u, y: a[1] + (c[1] - a[1]) * u, ang: Math.atan2(c[1] - a[1], c[0] - a[0]) };
}

function head(mats: TurretMats): BuiltPart {
  const b = new TB();
  b.mirrorZ((h) => {
    const zIn = CHEEK_IN;
    const zOut = CHEEK_OUT - 0.04;
    const w = zOut - zIn;
    const zc = (zIn + zOut) / 2;
    // gunmetal core, inset so the plates sit proud of it
    h.add('gunmetal', plate(inset(CHEEK, 0.042), w, 0.01), { z: zc });
    // ivory edge plates round the outline (not the bottom edge), short of each corner so the seams
    // open onto the core; each sits inside the outline with its outer face on it
    for (let i = 1; i < CHEEK.length; i++) {
      const a = CHEEK[i]!;
      const c = CHEEK[(i + 1) % CHEEK.length]!;
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const e = onEdge(i, 0.5);
      const g = 0.01;
      // cbox lies on y = 0 and rises along +y; rotated by the edge angle, +y is the inward normal
      h.add('ceramic', cbox(len - 2 * g, 0.05, w + 0.03, 0.012, 0.012), { x: e.x, y: e.y, z: zc + 0.005, rz: e.ang });
    }
    // outer side armour: the outline inset past the edge plates, split by a raked seam into two
    // plates standing proud of the edge plates
    const side = inset(CHEEK, 0.058);
    const s0: Pt = [-0.2, HEAD_Y - 0.1];
    const s1: Pt = [-0.02, HEAD_Y + 0.85];
    const front = inset(clipLeft(side, s1, s0), 0.005);
    const rear = inset(clipLeft(side, s0, s1), 0.005);
    for (const p of [front, rear]) h.add('ceramic', plate(p, 0.05, 0.014), { z: CHEEK_OUT - 0.025 });
    // a small inset access panel on the rear plate
    h.add('ceramic', plate([[-0.62, HEAD_Y + 0.15], [-0.4, HEAD_Y + 0.15], [-0.4, HEAD_Y + 0.32], [-0.62, HEAD_Y + 0.32]], 0.012, 0.004), { z: CHEEK_OUT + 0.003 });
    // bronze hinge on the outer rear edge: leaf, two knuckles, pins, bolts
    h.add('bronze', cbox(0.11, 0.34, 0.014, 0.004), { x: -0.66, y: HEAD_Y + 0.13, z: CHEEK_OUT + 0.007 });
    for (const y of [HEAD_Y + 0.16, HEAD_Y + 0.36]) {
      h.add('bronze', cyl(0.03, 0.03, 0.1, 14), { x: -0.715, y, z: CHEEK_OUT + 0.008 });
      h.add('gunmetal', cyl(0.012, 0.012, 0.12, 8), { x: -0.715, y: y - 0.01, z: CHEEK_OUT + 0.008 });
    }
    h.bolt('bronze', [-0.63, HEAD_Y + 0.2, CHEEK_OUT + 0.014], 0.014, [0, 0, 1]);
    h.bolt('bronze', [-0.63, HEAD_Y + 0.42, CHEEK_OUT + 0.014], 0.014, [0, 0, 1]);
    // bronze latch on the front of the side armour with a dark slot
    h.add('bronze', cbox(0.09, 0.15, 0.03, 0.008), { x: 0.13, y: HEAD_Y + 0.13, z: CHEEK_OUT - 0.004 });
    h.add('dark', cbox(0.03, 0.09, 0.006, 0.002), { x: 0.13, y: HEAD_Y + 0.16, z: CHEEK_OUT + 0.012 });
    // bronze clamp over the top front edge
    {
      const e = onEdge(4, 0.35);
      h.add('bronze', cbox(0.13, 0.065, 0.11, 0.01), { x: e.x, y: e.y - 0.035, z: zOut - 0.03, rz: e.ang });
      h.add('dark', cbox(0.05, 0.07, 0.03, 0.003), { x: e.x, y: e.y - 0.034, z: zOut - 0.03, rz: e.ang });
    }
    // cyan slit on the cheek's front face in a gunmetal bezel
    h.add('gunmetal', cbox(0.02, 0.055, 0.21, 0.006), { x: 0.265, y: HEAD_Y + 0.17, z: zc + 0.02 });
    h.add('glow', cbox(0.01, 0.024, 0.16, 0.003), { x: 0.274, y: HEAD_Y + 0.186, z: zc + 0.02 });
    // inner face: bearing boss for the trunnion and a bronze fitting below it
    h.add('gunmetal', cyl(0.13, 0.13, 0.03, 28), { x: 0, y: GUN.trunnionHeight, z: zIn - 0.015, rx: Math.PI / 2 });
    h.add('bronze', cbox(0.12, 0.09, 0.05, 0.01), { x: 0.12, y: HEAD_Y + 0.07, z: zIn - 0.02 });
    h.bolt('dark', [0.12, HEAD_Y + 0.12, zIn - 0.045], 0.012, [0, 0, -1]);
  });
  // turntable under the cheeks
  addLathe(b, 'gunmetal', ringProfile(0.25, R_TABLE + 0.01, 0.03, 0.008), 48, { y: HEAD_Y - 0.03 }, { wearBands: [1, 3] });
  // rear housing bridging the cheeks: a shell (gunmetal back wall, ivory rear and roof plates,
  // roof hatch) left open in front so the breech has room to recoil at full elevation
  b.add('gunmetal', cbox(0.08, 0.54, 0.46, 0.01), { x: -0.65, y: HEAD_Y });
  b.add('ceramic', profile([[-0.77, HEAD_Y + 0.06], [-0.69, HEAD_Y + 0.06], [-0.69, ROOF_Y], [-0.76, ROOF_Y - 0.09]], 0.44, 0.012));
  b.add('ceramic', profile([[-0.69, ROOF_Y], [-0.2, ROOF_Y], [-0.2, ROOF_Y + 0.055], [-0.67, ROOF_Y + 0.055]], 0.44, 0.012));
  b.add('gunmetal', cbox(0.24, 0.025, 0.24, 0.006), { x: -0.45, y: ROOF_Y + 0.055 });
  for (let i = 0; i < 5; i++) b.add('dark', cbox(0.18, 0.004, 0.012, 0.001), { x: -0.45, y: ROOF_Y + 0.08, z: -0.08 + i * 0.04 });
  for (const z of [-0.13, 0.13]) b.add('bronze', cbox(0.08, 0.035, 0.035, 0.006), { x: -0.45, y: ROOF_Y + 0.055, z });
  for (const x of [-0.62, -0.27]) for (const z of [-0.17, 0.17]) b.bolt('bronze', [x, ROOF_Y + 0.055, z], 0.015);
  // gunmetal structure under the gun, bronze fittings either side
  b.add('gunmetal', cbox(0.32, 0.12, 0.47, 0.012), { x: 0.14, y: HEAD_Y });
  b.add('gunmetal', profile([[0.0, HEAD_Y + 0.12], [0.3, HEAD_Y + 0.12], [0.22, HEAD_Y + 0.17], [0.02, HEAD_Y + 0.17]], 0.3, 0.008));
  for (const z of [-0.155, 0.155]) {
    b.add('bronze', cbox(0.1, 0.08, 0.07, 0.01), { x: 0.26, y: HEAD_Y + 0.1, z });
    b.bolt('dark', [0.31, HEAD_Y + 0.14, z], 0.012, [1, 0, 0]);
  }
  return finishPart('head', b, mats);
}

// ---- cradle (pitch) ---------------------------------------------------------------------------
function cradle(mats: TurretMats): BuiltPart {
  const b = new TB();
  b.mirrorZ((h) => {
    // bronze trunnion ring (axis z) with a gunmetal hub, pin and hub bolts
    addLathe(h, 'bronze', ringProfile(0.11, 0.205, 0.065, 0.012).slice(0, 5), 40, { z: 0.155 }, { axis: 'z', wearBands: [1, 3] });
    h.add('gunmetal', cyl(0.11, 0.11, 0.075, 32), { z: 0.15, rx: Math.PI / 2 });
    h.add('gunmetal', cyl(0.045, 0.05, 0.03, 16), { z: 0.225, rx: Math.PI / 2 });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      h.bolt('dark', [Math.cos(a) * 0.08, Math.sin(a) * 0.08, 0.225], 0.012, [0, 0, 1], a);
    }
  });
  // cradle block between the rings
  b.add('gunmetal', cbox(0.34, 0.24, 0.3, 0.015), { x: 0.02, y: -0.12 });
  b.add('bronze', cbox(0.14, 0.05, 0.31, 0.01), { x: -0.08, y: 0.1 });
  // recoil housing: bronze collar, ribbed gunmetal sleeve, front bushing
  addLathe(b, 'bronze', ringProfile(0.07, 0.122, 0.05, 0.008), 40, { x: 0.15 }, { axis: 'x', wearBands: [1, 3] });
  b.add('gunmetal', tubeX(0.104, 0.32, 40), { x: 0.2 });
  for (const x of [0.24, 0.35, 0.46]) addLathe(b, 'gunmetal', ringProfile(0.1, 0.113, 0.026, 0.005).slice(0, 6), 32, { x }, { axis: 'x', wearBands: [1, 3] });
  addLathe(b, 'gunmetal', ringProfile(0.072, 0.09, 0.06, 0.008), 32, { x: 0.52 }, { axis: 'x', wearBands: [1, 3] });
  // recuperator under the housing
  b.add('bronze', tubeX(0.032, 0.42, 16), { x: 0.06, y: -0.105 });
  b.add('gunmetal', tubeX(0.038, 0.04, 16), { x: 0.46, y: -0.105 });
  b.add('gunmetal', cbox(0.05, 0.05, 0.06, 0.008), { x: 0.47, y: -0.14 });
  return finishPart('cradle', b, mats);
}

// ---- barrel (recoil) --------------------------------------------------------------------------
const BRAKE_X = 1.16;
const PORT_W = 0.028;
const BAR_W = 0.022;
const BRAKE_R = 0.106;
const BORE_R = 0.052;

function barrel(mats: TurretMats): { part: BuiltPart; muzzleX: number; ports: number[] } {
  const b = new TB();
  // breech block with an ejection port on the +z side
  b.add('gunmetal', cbox(0.2, 0.17, 0.17, 0.02), { x: -0.12, y: -0.085 });
  b.add('bronze', cbox(0.05, 0.18, 0.18, 0.012), { x: -0.03, y: -0.09 });
  b.add('dark', cbox(0.08, 0.06, 0.01, 0.002), { x: -0.13, y: -0.02, z: 0.083 });
  // inner tube (inside the recoil housing)
  b.add('gunmetal', tubeX(0.064, 0.6, 32), { x: -0.02 });
  // ivory sleeve, slightly tapered, with a gunmetal band and dark slots on both sides
  b.add('ceramic', tubeX(0.064, 0.56, 48, 0.058), { x: 0.56 });
  addLathe(b, 'gunmetal', ringProfile(0.058, 0.072, 0.04, 0.006), 40, { x: 0.58 }, { axis: 'x', wearBands: [1, 3] });
  for (const s of [-1, 1]) b.add('dark', cbox(0.3, 0.018, 0.012, 0.003), { x: 0.87, y: -0.009, z: s * 0.056 });
  b.add('dark', cbox(0.22, 0.008, 0.014, 0.002), { x: 0.87, y: 0.057 });
  addLathe(b, 'gunmetal', ringProfile(0.06, 0.084, 0.06, 0.008), 40, { x: 1.1 }, { axis: 'x', wearBands: [1, 3] });
  // muzzle brake: rear ring, five side ports between four bars, top and bottom spines, front
  // ring with the bore turned into it
  let x = BRAKE_X;
  addLathe(b, 'gunmetal', ringProfile(BORE_R, BRAKE_R, 0.05, 0.008).slice(0, 6), 40, { x }, { axis: 'x', wearBands: [1, 3] });
  x += 0.05;
  const ports: number[] = [];
  const spineStart = x;
  for (let i = 0; i < 5; i++) {
    ports.push(x + PORT_W / 2);
    x += PORT_W;
    if (i < 4) {
      addLathe(b, 'gunmetal', [[BORE_R + 0.012, 0], [BRAKE_R, 0], [BRAKE_R, BAR_W], [BORE_R + 0.012, BAR_W]], 32, { x }, { axis: 'x' });
      x += BAR_W;
    }
  }
  const spineLen = x - spineStart;
  for (const a of [0, Math.PI]) b.add('gunmetal', sectorX(BORE_R + 0.012, BRAKE_R, a - 0.62, a + 0.62, spineLen, 0.003, 8), { x: spineStart });
  // bore liner seen through the ports (sooted)
  b.add('dark', tubeX(BORE_R + 0.004, spineLen + 0.02, 24), { x: spineStart - 0.01 });
  // front ring: outer face, chamfer, muzzle face, then the bore wall running back to a dark end
  const L = 0.055;
  const front: Pt[] = [
    [BORE_R + 0.012, 0],
    [BRAKE_R, 0],
    [BRAKE_R + 0.004, 0.006],
    [BRAKE_R + 0.004, L - 0.012],
    [BRAKE_R - 0.012, L],
    [BORE_R + 0.008, L],
    [BORE_R, L - 0.008],
    [BORE_R, L - 0.6],
  ];
  addLathe(b, 'gunmetal', front.slice(0, 7), 40, { x }, { axis: 'x', wearBands: [1, 3, 5] });
  addLathe(b, 'dark', front.slice(6), 32, { x }, { axis: 'x' });
  b.add('dark', cyl(BORE_R, BORE_R, 0.002, 24), { x: x + L - 0.6, rz: -Math.PI / 2 });
  x += L;
  return { part: finishPart('barrel', b, mats), muzzleX: x, ports };
}

export function buildTurret(mats: TurretMats): TurretModel {
  const bs = base(mats);
  const br = barrel(mats);
  if (Math.abs(br.muzzleX - GUN.barrelLength) > 0.005) throw new Error(`muzzle at ${br.muzzleX.toFixed(3)} tiles, fire control assumes ${GUN.barrelLength}`);
  return {
    base: bs.part,
    pinion: pinion(mats),
    ring: ring(mats),
    head: head(mats),
    cradle: cradle(mats),
    barrel: br.part,
    pinionAt: bs.pinionAt,
    pinionRatio: RING_TEETH / PINION_TEETH,
    trunnionY: GUN.trunnionHeight,
    muzzle: [br.muzzleX, 0, 0],
    brakePorts: br.ports,
    brakeRadius: BRAKE_R,
    ejectPort: [-0.13, 0.01, 0.09],
    top: HEAD_Y + CH + 0.02,
  };
}

/** Unit bolt: hex head (circumradius 1, height 0.55) on a washer; scaled per instance. */
export function boltGeometry(): BufferGeometry {
  // hex head with a chamfered top, flat-shaded, no hidden bottom cap: 30 triangles
  const b = new TB();
  const prof: Pt[] = [
    [1, 0],
    [1, 0.42],
    [0.76, 0.56],
    [0, 0.56],
  ];
  latheBands(prof, 6).forEach(({ g }, i) => {
    const f = g.toNonIndexed();
    f.deleteAttribute('normal');
    f.rotateY(Math.PI / 6);
    b.add('bronze', f, {}, i === 1 ? 'all' : 'none');
  });
  return b.geometryOnly();
}

export function triangleCount(g: BufferGeometry): number {
  return (g.index ? g.index.count : g.getAttribute('position').count) / 3;
}

export { boltMatrix, Matrix4 };
