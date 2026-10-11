// W23 commander: a two-legged armoured command mech in the manner of Supreme Commander's armoured
// command unit, about 7 m (3.45 tiles) tall, in the shared material set at the turret's detail
// standard: chamfered ivory armour with edge wear over a gunmetal frame, bronze actuators and
// bolts, cyan light only in slits, the visor and the reactor.
//
// Segments (frames +X forward, +Y up, +Z right; limbs hang along −Y from their joint):
//   pelvis   hip block, hip joints 0.42 tiles either side, at Biped's pelvis height
//   torso    on a yaw bearing 0.22 above the pelvis: turns independently of the legs (torsoYaw)
//   head     sensor head with a visor slit, on the torso
//   pack     reactor backpack: twin cores with cyan rings, vents, aerials
//   uarm ×2  shoulder actuator and upper arm (0.62); the arms hang from shoulders 0.8 out
//   farmL    build arm: forearm with the nano-beam projector (beam origin at its emitter)
//   farmR    weapon arm: forearm gun housing; barrelR recoils along it, muzzle flash at its end
//   thigh, shin, foot ×2   from Biped (planted feet, two-bone IK onto the terrain)
//
// Actions: idle (breathing sway, slow head scan), walk (torso bob and sway, arms swing a little),
// turn on the spot (the gait steps the feet round), build (torso turns to the site, left arm aims
// the projector), fire (torso turns to the target, right arm aims, 0.6 s between shots, recoil).

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { PB } from '../../kit/builder.ts';
import type { Pt } from '../../bench/geo.ts';
import { Biped, boneMatrix, forwardOf, type Ground } from './biped.ts';
import { COMMANDER_LEGS } from './specs.ts';

export const CMD_SEGS = ['pelvis', 'torso', 'head', 'pack', 'uarmL', 'farmL', 'uarmR', 'farmR', 'barrelR', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'] as const;
export type CmdSeg = (typeof CMD_SEGS)[number];
export const CSEG = Object.fromEntries(CMD_SEGS.map((s, i) => [s, i])) as Record<CmdSeg, number>;
export const CMD_PARTS: Record<CmdSeg, string> = {
  pelvis: 'cmd/pelvis',
  torso: 'cmd/torso',
  head: 'cmd/head',
  pack: 'cmd/pack',
  uarmL: 'cmd/uarm',
  farmL: 'cmd/projector',
  uarmR: 'cmd/uarm',
  farmR: 'cmd/gunarm',
  barrelR: 'cmd/barrel',
  thighL: 'cmd/thigh',
  shinL: 'cmd/shin',
  footL: 'cmd/foot',
  thighR: 'cmd/thigh',
  shinR: 'cmd/shin',
  footR: 'cmd/foot',
};

export type CmdAction = 'idle' | 'walk' | 'turn' | 'build' | 'fire';
export const CMD_ACTIONS: CmdAction[] = ['idle', 'walk', 'turn', 'build', 'fire'];

const TORSO_Y = 0.22;
const SHOULDER_Y = 0.86;
const SHOULDER_Z = 0.8;
const UARM = 0.62;
const FARM = 0.62;
/** Beam emitter (projector) and muzzle in their segment frames. */
export const EMITTER: [number, number, number] = [0.06, -0.86, 0];
export const MUZZLE: [number, number, number] = [0, -1.02, 0];
export const FIRE_INTERVAL = 0.6;
const RECOIL = 0.14;

const _m = new Matrix4();
const _m2 = new Matrix4();
const _q = new Quaternion();
const _v = new Vector3();
const _w = new Vector3();
const _f = new Vector3();
const _inv = new Matrix4();
const Y = new Vector3(0, 1, 0);
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class CommanderRig {
  readonly legs = new Biped(COMMANDER_LEGS);
  action: CmdAction = 'idle';
  /** Torso yaw relative to the legs (rad). */
  torsoYaw = 0;
  /** World point the build arm or the gun aims at. */
  readonly aim = new Vector3();
  readonly mats: Matrix4[] = CMD_SEGS.map(() => new Matrix4());
  readonly emitter = new Vector3();
  readonly muzzle = new Vector3();
  /** Unit vector along the barrel (world). */
  readonly muzzleDir = new Vector3();
  /** Set for one update when a shot is fired. */
  fired = false;
  private cool = 0.3;
  private recoil = 0;
  private clock = 0;
  // eased joint angles: shoulder pitch / abduction, elbow, per arm (L, R)
  private sp = [0.1, 0.1];
  private sa = [0.14, -0.14];
  private el = [0.35, 0.35];
  private bob = 0;

  get pos(): Vector3 {
    return this.legs.pos;
  }

  place(x: number, z: number, yaw: number, ground: Ground): void {
    this.legs.place(x, z, yaw, ground);
  }

  setAction(a: CmdAction): void {
    this.action = a;
  }

  /** Arm angles (pitch about Z, abduction about X) pointing from a shoulder at `target`. */
  private aimArm(side: number, torso: Matrix4, target: Vector3): [number, number] {
    _inv.copy(torso).invert();
    const t = _v.copy(target).applyMatrix4(_inv);
    t.y -= SHOULDER_Y;
    t.z -= side * SHOULDER_Z;
    const len = t.length() || 1;
    const b = -Math.asin(Math.max(-1, Math.min(1, t.z / len)));
    const a = Math.atan2(t.x, -t.y);
    return [a, b];
  }

  update(dt: number, x: number, z: number, yaw: number, ground: Ground): void {
    this.clock += dt;
    this.fired = false;
    this.legs.update(dt, x, z, yaw, ground, 0);
    const L = this.legs;
    const moving = L.speed > 0.05;
    // torso yaw: towards the aim point when building or firing, back to the legs otherwise
    let wantYaw = 0;
    if (this.action === 'build' || this.action === 'fire') wantYaw = wrapPi(Math.atan2(-(this.aim.z - L.pos.z), this.aim.x - L.pos.x) - L.yaw);
    wantYaw = Math.max(-1.6, Math.min(1.6, wantYaw));
    const maxTurn = 1.4 * dt;
    this.torsoYaw += Math.max(-maxTurn, Math.min(maxTurn, wantYaw - this.torsoYaw));
    // gait-driven torso bob and sway, breathing at rest
    const ph = L.phase * Math.PI * 2;
    const bobT = moving ? 0.035 * Math.cos(ph * 2) : 0.012 * Math.sin(this.clock * 1.3);
    this.bob += (bobT - this.bob) * Math.min(1, dt * 8);
    const sway = moving ? 0.035 * Math.sin(ph) : 0;
    const M = this.mats;
    _q.setFromAxisAngle(Y, L.yaw);
    M[CSEG.pelvis]!.compose(_w.set(L.pos.x, L.pelvisY, L.pos.z), _q, _f.set(1, 1, 1)).multiply(_m.makeRotationX(sway * 0.5));
    M[CSEG.torso]!.copy(M[CSEG.pelvis]!).multiply(_m.makeTranslation(0, TORSO_Y + this.bob, 0)).multiply(_m2.makeRotationY(this.torsoYaw)).multiply(_m.makeRotationX(-sway)).multiply(_m2.makeRotationZ(moving ? -0.05 : 0));
    // head scans slowly at rest, looks at the aim point otherwise
    const look = this.action === 'idle' ? 0.45 * Math.sin(this.clock * 0.4) : 0;
    M[CSEG.head]!.copy(M[CSEG.torso]!).multiply(_m.makeTranslation(0.12, 1.04, 0)).multiply(_m2.makeRotationY(look));
    M[CSEG.pack]!.copy(M[CSEG.torso]!);

    // arm targets: shoulder pitch (Rz, forward +), Rx angle (−0.14 / +0.14 holds each arm a
    // little out from the body), elbow (Rz)
    const tsp = [0.12, 0.12];
    const tsa = [0.14, -0.14];
    const tel = [0.4, 0.4];
    if (moving) {
      const s = 0.18 * Math.sin(ph);
      tsp[0] = 0.12 + s;
      tsp[1] = 0.12 - s;
    }
    if (this.action === 'build') {
      const [a, b] = this.aimArm(-1, M[CSEG.torso]!, this.aim);
      tel[0] = 0.25;
      tsp[0] = a - 0.25;
      tsa[0] = b;
      tsp[1] = 0.35;
      tel[1] = 0.6;
    } else if (this.action === 'fire') {
      const [a, b] = this.aimArm(1, M[CSEG.torso]!, this.aim);
      tel[1] = 0.12;
      tsp[1] = a - 0.12;
      tsa[1] = b;
      tsp[0] = 0.3;
      tel[0] = 0.7;
    } else if (this.action === 'idle') {
      const br = 0.03 * Math.sin(this.clock * 1.3);
      tsp[0] = 0.1 + br;
      tsp[1] = 0.1 + br;
    }
    const k = Math.min(1, dt * 5);
    for (let i = 0; i < 2; i++) {
      this.sp[i]! += (tsp[i]! - this.sp[i]!) * k;
      this.sa[i]! += (tsa[i]! - this.sa[i]!) * k;
      this.el[i]! += (tel[i]! - this.el[i]!) * k;
    }
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1;
      const ua = M[i === 0 ? CSEG.uarmL : CSEG.uarmR]!;
      ua.copy(M[CSEG.torso]!).multiply(_m.makeTranslation(0, SHOULDER_Y, s * SHOULDER_Z)).multiply(_m2.makeRotationZ(this.sp[i]!)).multiply(_m.makeRotationX(this.sa[i]!));
      M[i === 0 ? CSEG.farmL : CSEG.farmR]!.copy(ua).multiply(_m.makeTranslation(0, -UARM, 0)).multiply(_m2.makeRotationZ(this.el[i]!));
    }
    // gun: cycle and recoil
    this.cool -= dt;
    if (this.action === 'fire' && this.cool <= 0 && Math.abs(wantYaw - this.torsoYaw) < 0.08) {
      this.cool = FIRE_INTERVAL;
      this.recoil = 1;
      this.fired = true;
    }
    this.recoil = Math.max(0, this.recoil - dt * 4);
    const r = this.recoil > 0.75 ? (1 - this.recoil) * 4 : this.recoil / 0.75;
    M[CSEG.barrelR]!.copy(M[CSEG.farmR]!).multiply(_m.makeTranslation(0, RECOIL * r, 0));
    this.emitter.set(...EMITTER).applyMatrix4(M[CSEG.farmL]!);
    this.muzzle.set(...MUZZLE).applyMatrix4(M[CSEG.barrelR]!);
    this.muzzleDir.set(0, -1, 0).transformDirection(M[CSEG.barrelR]!);

    // legs
    const fwd = forwardOf(L.yaw, _f);
    for (let i = 0; i < 2; i++) {
      boneMatrix(M[i === 0 ? CSEG.thighL : CSEG.thighR]!, L.hips[i]!, L.knees[i]!, fwd);
      boneMatrix(M[i === 0 ? CSEG.shinL : CSEG.shinR]!, L.knees[i]!, L.ankles[i]!, fwd);
      const ft = L.feet[i]!;
      _q.setFromAxisAngle(Y, ft.yaw);
      M[i === 0 ? CSEG.footL : CSEG.footR]!.compose(L.ankles[i]!, _q, _w.set(1, 1, 1)).multiply(_m.makeRotationZ(ft.stance ? 0 : -0.25 * Math.sin(Math.PI * ft.swing)));
    }
  }
}

// ---- parts -------------------------------------------------------------------------------------------

const ring = (r0: number, r1: number, len: number, c: number): Pt[] => [
  [r0, 0],
  [r1 - c, 0],
  [r1, c],
  [r1, len - c],
  [r1 - c, len],
  [r0, len],
  [r0, 0],
];

/** Actuator drum along z (a joint housing), centred on (x, y), width w. */
function drum(p: PB, x: number, y: number, r: number, w: number, key: 'bronze' | 'gunmetal' = 'bronze'): void {
  p.lathe(key, ring(0, r, w, Math.min(0.02, r * 0.2)), { x, y, z: -w / 2 }, { axis: 'z', seg: 24, wear: [1, 3] });
  p.lathe('gunmetal', ring(0, r * 0.55, w + 0.04, 0.008), { x, y, z: -w / 2 - 0.02 }, { axis: 'z', seg: 16, imp: 'minor' });
}

export function commanderBuilders(): Map<string, (p: PB) => void> {
  const m = new Map<string, (p: PB) => void>();
  // pelvis: armoured hip block with the hip actuators and a groin plate
  m.set('cmd/pelvis', (p) => {
    p.box('gunmetal', 0.62, 0.34, 0.66, { y: -0.18 }, { c: 0.03 });
    p.frustum('ceramic', 0.5, 0.22, 0.5, 0.75, { x: 0.08, y: -0.36 }, { c: 0.02 });
    p.prof('ceramic', [[0.2, -0.2], [0.36, -0.14], [0.36, 0.12], [0.24, 0.18], [0.2, 0.18]], 0.5, {}, { c: 0.02 });
    for (const s of [-1, 1]) {
      drum(p, 0, 0, 0.17, 0.2, 'bronze');
      p.box('gunmetal', 0.3, 0.3, 0.12, { y: -0.15, z: s * 0.36 }, { c: 0.02 });
      for (const y of [-0.08, 0.08]) p.bolt('bronze', [0.2, y, s * 0.2], 0.02, [1, 0, 0]);
    }
    // the yaw bearing the torso turns on
    p.lathe('bronze', ring(0.2, 0.34, 0.06, 0.012), { y: 0.16 }, { seg: 40, wear: [1, 3] });
    p.cylY('gunmetal', 0.3, 0.3, 0.05, { y: 0.17 }, { seg: 32, imp: 'minor' });
  });
  // torso: armoured chest (wider at the shoulders), side armour, cockpit hatch, cyan slits
  m.set('cmd/torso', (p) => {
    p.lathe('bronze', ring(0.14, 0.32, 0.08, 0.014), {}, { seg: 40, wear: [1, 3] });
    // waist core and chest
    p.frustum('gunmetal', 0.58, 0.3, 0.7, 1.3, { y: 0.04 }, { c: 0.03 });
    p.prof('ceramic', [[-0.42, 0.3], [0.36, 0.3], [0.46, 0.42], [0.48, 0.82], [0.4, 0.98], [-0.3, 1.02], [-0.44, 0.92]], 1.26, {}, { c: 0.035 });
    // chest plate (raised, split by a seam), with a hatch frame and two slits
    p.mirrorZ((q) => {
      q.prof('ceramic', [[0.44, 0.38], [0.53, 0.44], [0.55, 0.8], [0.47, 0.92], [0.44, 0.92]], 0.5, { z: 0.28 }, { c: 0.02 });
      q.box('glow', 0.012, 0.03, 0.18, { x: 0.552, y: 0.68, z: 0.3 }, { imp: 'minor', c: 0.003 });
      q.box('bronze', 0.05, 0.05, 0.08, { x: 0.47, y: 0.33, z: 0.4 }, { c: 0.01, imp: 'minor' });
      // shoulder mounts and pauldrons (big ivory shoulder plates)
      q.box('gunmetal', 0.42, 0.3, 0.22, { y: 0.66, z: 0.66 }, { c: 0.025 });
      q.prof('ceramic', [[-0.3, 0.8], [0.3, 0.8], [0.36, 0.92], [0.24, 1.08], [-0.24, 1.08], [-0.36, 0.92]], 0.34, { z: 0.78, rx: -0.12 }, { c: 0.025 });
      q.box('bronze', 0.5, 0.04, 0.36, { y: 0.79, z: 0.78 }, { c: 0.01, imp: 'minor' });
      for (const x of [-0.18, 0, 0.18]) q.bolt('bronze', [x, 1.08, 0.78], 0.022);
      // side armour
      q.prof('ceramic', [[-0.36, 0.34], [0.3, 0.34], [0.36, 0.44], [0.3, 0.72], [-0.36, 0.72]], 0.06, { z: 0.64 }, { c: 0.015, imp: 'minor' });
    });
    p.box('dark', 0.012, 0.36, 0.012, { x: 0.555, y: 0.42 }, { imp: 'fine', c: 0 });
    // collar
    p.box('gunmetal', 0.5, 0.08, 0.6, { x: 0.05, y: 0.98 }, { c: 0.02, imp: 'minor' });
    for (const z of [-0.2, 0.2]) p.bolt('bronze', [0.44, 0.88, z], 0.02, [1, 0, 0]);
  });
  // head: sensor block with a wide visor slit, cheek armour, aerial
  m.set('cmd/head', (p) => {
    p.cylY('gunmetal', 0.16, 0.18, 0.08, {}, { seg: 24 });
    p.prof('ceramic', [[-0.22, 0.06], [0.2, 0.06], [0.3, 0.14], [0.28, 0.26], [0.16, 0.34], [-0.2, 0.34], [-0.24, 0.26]], 0.42, {}, { c: 0.025 });
    p.box('dark', 0.04, 0.07, 0.34, { x: 0.27, y: 0.17 }, { c: 0.01 });
    p.box('glow', 0.02, 0.03, 0.3, { x: 0.29, y: 0.19 }, { c: 0.004 });
    p.mirrorZ((q) => {
      q.box('gunmetal', 0.2, 0.18, 0.05, { x: 0.02, y: 0.1, z: 0.23 }, { c: 0.012, imp: 'minor' });
      q.cylZ('bronze', 0.05, 0.03, 0.06, 0.2, 0.26, { seg: 16, imp: 'minor' });
    });
    p.cylY('gunmetal', 0.012, 0.016, 0.34, { x: -0.14, y: 0.34, z: -0.12 }, { seg: 8, imp: 'minor' });
    p.cylY('glow', 0.02, 0.02, 0.025, { x: -0.14, y: 0.68, z: -0.12 }, { seg: 8, imp: 'fine' });
  });
  // reactor backpack: twin cores with cyan rings, vent fins, bronze manifold
  m.set('cmd/pack', (p) => {
    p.box('gunmetal', 0.3, 0.7, 0.86, { x: -0.56, y: 0.3 }, { c: 0.03 });
    p.mirrorZ((q) => {
      q.cylY('ceramic', 0.17, 0.19, 0.62, { x: -0.76, y: 0.28, z: 0.24 }, { seg: 28 });
      for (const y of [0.42, 0.62]) q.lathe('glow', ring(0.17, 0.196, 0.035, 0.004), { x: -0.76, y, z: 0.24 }, { seg: 28 });
      q.cylY('gunmetal', 0.12, 0.17, 0.08, { x: -0.76, y: 0.9, z: 0.24 }, { seg: 20 });
      q.cylY('dark', 0.08, 0.08, 0.02, { x: -0.76, y: 0.97, z: 0.24 }, { seg: 16, imp: 'minor' });
      q.cylY('bronze', 0.2, 0.2, 0.05, { x: -0.76, y: 0.24, z: 0.24 }, { seg: 28, imp: 'minor' });
    });
    for (let k = 0; k < 5; k++) p.box('gunmetal', 0.16, 0.02, 0.5, { x: -0.68, y: 0.12 + k * 0.05 }, { c: 0.004, imp: 'fine' });
    p.box('bronze', 0.08, 0.1, 0.3, { x: -0.86, y: 0.75 }, { c: 0.012, imp: 'minor' });
    p.cylY('gunmetal', 0.012, 0.014, 0.5, { x: -0.62, y: 1.0, z: 0.36 }, { seg: 6, imp: 'minor' });
  });
  // upper arm: shoulder actuator, armoured upper arm, elbow drum (symmetric in z)
  m.set('cmd/uarm', (p) => {
    drum(p, 0, 0, 0.16, 0.26);
    p.box('gunmetal', 0.24, UARM - 0.12, 0.22, { y: -UARM + 0.08 }, { c: 0.025 });
    p.prof('ceramic', [[0.1, -0.08], [0.16, -0.12], [0.17, -0.42], [0.12, -0.5], [0.1, -0.5]], 0.26, {}, { c: 0.018 });
    p.box('bronze', 0.26, 0.05, 0.24, { y: -0.2 }, { c: 0.008, imp: 'minor' });
    drum(p, 0, -UARM, 0.12, 0.24, 'gunmetal');
  });
  // build arm forearm with the nano-beam projector: emitter dish and cyan core
  m.set('cmd/projector', (p) => {
    p.box('gunmetal', 0.2, FARM - 0.1, 0.2, { y: -FARM + 0.02 }, { c: 0.022 });
    p.prof('ceramic', [[0.08, -0.06], [0.14, -0.1], [0.14, -0.48], [0.1, -0.54], [0.08, -0.54]], 0.22, {}, { c: 0.015 });
    p.lathe('bronze', [[0.06, 0], [0.13, 0], [0.16, 0.06], [0.16, 0.1], [0.12, 0.12], [0.06, 0.12]], { y: -FARM - 0.12 }, { seg: 24, wear: [1, 3] });
    p.lathe('gunmetal', [[0.0, 0], [0.1, 0.0], [0.14, -0.08], [0.12, -0.1], [0.0, -0.06]], { y: -FARM - 0.12 }, { seg: 24, imp: 'minor' });
    p.cylY('glow', 0.05, 0.035, 0.05, { y: -FARM - 0.24 }, { seg: 16 });
    for (const a of [0, 2.1, 4.2]) p.beam('bronze', [Math.cos(a) * 0.12, -FARM - 0.16, Math.sin(a) * 0.12], [Math.cos(a) * 0.04, -FARM - 0.24, Math.sin(a) * 0.04], 0.02, 0.02, { imp: 'minor', c: 0.004 });
  });
  // weapon arm forearm: gun housing with the barrel shroud (the barrel itself recoils)
  m.set('cmd/gunarm', (p) => {
    p.box('gunmetal', 0.26, FARM, 0.24, { y: -FARM - 0.02 }, { c: 0.025 });
    p.prof('ceramic', [[0.12, -0.04], [0.18, -0.08], [0.18, -0.5], [0.13, -0.58], [0.12, -0.58]], 0.26, {}, { c: 0.016 });
    p.box('bronze', 0.06, 0.18, 0.1, { x: -0.15, y: -0.38 }, { c: 0.01, imp: 'minor' });
    p.box('glow', 0.01, 0.12, 0.03, { x: 0.183, y: -0.4 }, { imp: 'minor', c: 0.002 });
    p.cylY('bronze', 0.11, 0.11, 0.06, { y: -FARM - 0.08 }, { seg: 20 });
  });
  m.set('cmd/barrel', (p) => {
    p.cylY('gunmetal', 0.06, 0.07, 0.36, { y: -FARM - 0.44 }, { seg: 20 });
    p.cylY('bronze', 0.085, 0.085, 0.08, { y: -FARM - 0.46 }, { seg: 20 });
    p.cylY('dark', 0.035, 0.035, 0.02, { y: -FARM - 0.465 }, { seg: 12, imp: 'minor' });
    for (let k = 0; k < 4; k++) p.box('dark', 0.012, 0.05, 0.03, { x: Math.cos((k * Math.PI) / 2) * 0.083, z: Math.sin((k * Math.PI) / 2) * 0.083, y: -FARM - 0.44 }, { imp: 'fine', c: 0 });
  });
  // legs: armoured thigh with a knee drum; shin with a big ivory greave; heavy foot with toes
  m.set('cmd/thigh', (p) => {
    drum(p, 0, 0, 0.19, 0.28);
    p.box('gunmetal', 0.26, 0.85 - 0.2, 0.24, { y: -0.85 + 0.1 }, { c: 0.025 });
    p.prof('ceramic', [[0.1, -0.12], [0.2, -0.18], [0.21, -0.6], [0.14, -0.72], [0.1, -0.72]], 0.3, {}, { c: 0.02 });
    p.mirrorZ((q) => q.box('ceramic', 0.3, 0.42, 0.04, { y: -0.6, z: 0.14 }, { c: 0.012, imp: 'minor' }));
    p.box('bronze', 0.08, 0.36, 0.06, { x: -0.16, y: -0.62 }, { c: 0.01, imp: 'minor' });
    drum(p, 0, -0.85, 0.15, 0.26, 'gunmetal');
  });
  m.set('cmd/shin', (p) => {
    p.box('gunmetal', 0.22, 0.85 - 0.16, 0.22, { y: -0.85 + 0.06 }, { c: 0.022 });
    p.prof('ceramic', [[0.08, 0.02], [0.22, -0.06], [0.24, -0.5], [0.16, -0.7], [0.08, -0.7]], 0.32, {}, { c: 0.022 });
    p.box('glow', 0.012, 0.16, 0.03, { x: 0.237, y: -0.42 }, { imp: 'minor', c: 0.003 });
    // piston at the back of the calf
    p.beam('bronze', [-0.15, -0.12, 0], [-0.15, -0.62, 0], 0.07, 0.07, { c: 0.01 });
    p.beam('gunmetal', [-0.15, -0.5, 0], [-0.12, -0.78, 0], 0.045, 0.045, { c: 0.006, imp: 'minor' });
    drum(p, 0, -0.85, 0.12, 0.24, 'bronze');
  });
  m.set('cmd/foot', (p) => {
    const sole = -0.17;
    p.box('gunmetal', 0.78, 0.12, 0.46, { x: 0.1, y: sole }, { c: 0.03 });
    p.prof('ceramic', [[-0.2, sole + 0.1], [0.32, sole + 0.1], [0.52, sole + 0.04], [0.52, sole + 0.13], [0.22, sole + 0.2], [-0.2, sole + 0.2]], 0.42, {}, { c: 0.02 });
    p.box('dark', 0.8, 0.03, 0.48, { x: 0.1, y: sole }, { c: 0.006, imp: 'minor' });
    for (const z of [-0.14, 0.14]) p.box('bronze', 0.16, 0.08, 0.12, { x: 0.46, y: sole, z }, { c: 0.012, imp: 'minor' });
    p.box('gunmetal', 0.22, 0.12, 0.3, { x: -0.22, y: sole }, { c: 0.02, imp: 'minor' });
    p.cylY('bronze', 0.12, 0.14, 0.1, { y: sole + 0.15 }, { seg: 20 });
  });
  return m;
}
