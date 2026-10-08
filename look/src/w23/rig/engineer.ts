// W23 engineers: suited human crew, 1.8 m (0.9 tiles) tall, built in code from shared parts in the
// shared material set: ivory armour plates over a gunmetal work suit, bronze buckles and fittings,
// a cyan visor or lamp. Variants mix helmet (3), backpack (2) and handheld tool (3).
//
// The rig has 16 segments: pelvis, torso, head (helmet), backpack, upper arm / forearm / hand ×2,
// thigh / shin / boot ×2, plus the tool (in the right hand) and the carried box. The legs come
// from Biped (planted feet + two-bone IK); the upper body is forward kinematics with joint angles
// from the current action, eased towards each action's pose:
//   idle    breathing, a slow look round
//   walk    arms swing against the legs, shoulders counter-rotate, slight forward lean
//   run     faster gait (Biped run blend), bent arms pumping, more lean
//   build   right arm aims the tool at the build point, left arm raised; the tool tip feeds the beam
//   carry   both forearms level holding the salvage box in front of the chest
//   drop    kneel, reach down, set the temporary-turret pod on the ground, stand up (1.8 s)
//
// Segment frames: +X forward, +Y up, +Z right (the body's right). Limbs hang along −Y from their
// joint. Part geometry is authored in these frames.

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { PB } from '../../kit/builder.ts';
import type { Pt } from '../../bench/geo.ts';
import { Biped, boneMatrix, forwardOf, type Ground } from './biped.ts';
import { ENGINEER_LEGS, ENGINEER_RUN, ENGINEER_WALK } from './specs.ts';

export const ENG_SEGS = ['pelvis', 'torso', 'head', 'pack', 'uarmL', 'farmL', 'handL', 'uarmR', 'farmR', 'handR', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR', 'tool', 'box'] as const;
export type EngSeg = (typeof ENG_SEGS)[number];
export const SEG = Object.fromEntries(ENG_SEGS.map((s, i) => [s, i])) as Record<EngSeg, number>;

export type EngAction = 'idle' | 'walk' | 'run' | 'build' | 'carry' | 'drop';
export const ENG_ACTIONS: EngAction[] = ['idle', 'walk', 'run', 'build', 'carry', 'drop'];

export interface EngVariant {
  helmet: 0 | 1 | 2;
  pack: 0 | 1;
  tool: 0 | 1 | 2;
}
export const VARIANTS: EngVariant[] = [
  { helmet: 0, pack: 0, tool: 0 },
  { helmet: 1, pack: 1, tool: 1 },
  { helmet: 2, pack: 0, tool: 2 },
  { helmet: 1, pack: 0, tool: 0 },
  { helmet: 0, pack: 1, tool: 2 },
  { helmet: 2, pack: 1, tool: 1 },
];
export const HELMET_NAMES = ['full-visor helmet', 'headlamp helmet', 'slit-visor hard hat'];
export const PACK_NAMES = ['canister pack', 'tank-and-mast pack'];
export const TOOL_NAMES = ['nano-welder', 'multi-tool', 'scanner'];

// body dimensions (tiles)
const WAIST = 0.04;
const TORSO = 0.29;
const SHOULDER_Y = 0.25;
const SHOULDER_Z = 0.112;
const UARM = 0.145;
const FARM = 0.13;
/** Tool tip in the right hand's frame, per tool. */
export const TOOL_TIP: Array<[number, number, number]> = [
  [0.012, -0.18, 0],
  [0.01, -0.157, 0],
  [0.04, -0.09, 0],
];

interface Pose {
  /** Shoulder pitch (forward +), abduction (out +), elbow bend (+), per arm L, R. */
  sp: [number, number];
  sa: [number, number];
  el: [number, number];
  lean: number;
  twist: number;
  nod: number;
  look: number;
  crouch: number;
}

const zero = (): Pose => ({ sp: [0, 0], sa: [0.08, 0.08], el: [0.25, 0.25], lean: 0, twist: 0, nod: 0, look: 0, crouch: 0 });

const _m = new Matrix4();
const _m2 = new Matrix4();
const _q = new Quaternion();
const _v = new Vector3();
const _w = new Vector3();
const _f = new Vector3();
const Y = new Vector3(0, 1, 0);

export class EngineerRig {
  readonly legs = new Biped(ENGINEER_LEGS);
  action: EngAction = 'idle';
  variant: EngVariant;
  /** World point the build beam / build pose aims at. */
  readonly aim = new Vector3();
  /** Seconds into the current action. */
  t = 0;
  /** Drop gesture: the pod is on the ground (set at the placing moment). */
  podDown = false;
  readonly podAt = new Vector3();
  podYaw = 0;
  readonly mats: Matrix4[] = ENG_SEGS.map(() => new Matrix4());
  /** World position of the tool tip (beam origin), updated by pose(). */
  readonly tip = new Vector3();
  private p: Pose = zero();
  private clock = Math.random() * 10;

  constructor(variant: EngVariant = VARIANTS[0]!) {
    this.variant = variant;
  }

  get pos(): Vector3 {
    return this.legs.pos;
  }

  get yaw(): number {
    return this.legs.yaw;
  }

  place(x: number, z: number, yaw: number, ground: Ground): void {
    this.legs.place(x, z, yaw, ground);
  }

  setAction(a: EngAction): void {
    if (a === this.action) return;
    this.action = a;
    this.t = 0;
    if (a === 'drop') this.podDown = false;
  }

  /** Target pose for the current action and gait phase. */
  private target(): Pose {
    const p = zero();
    const ph = this.legs.phase * Math.PI * 2;
    const moving = this.legs.speed > 0.05;
    const t = this.clock;
    // breathing and a slow look round
    p.nod = 0.03 * Math.sin(t * 1.7);
    p.look = moving ? 0 : 0.35 * Math.sin(t * 0.37);
    if (moving || this.action === 'walk' || this.action === 'run') {
      const run = this.legs.run;
      const amp = 0.42 + 0.35 * run;
      // left arm swings with the right leg (foot 1 leads at phase 0.5)
      p.sp = [amp * Math.sin(ph), -amp * Math.sin(ph)];
      p.el = [0.3 + 0.9 * run + 0.15 * Math.max(0, Math.sin(ph)), 0.3 + 0.9 * run + 0.15 * Math.max(0, -Math.sin(ph))];
      p.twist = 0.08 * Math.sin(ph);
      p.lean = 0.06 + 0.16 * run;
    }
    switch (this.action) {
      case 'build': {
        // aim the right arm (and the tool) at the build point; left arm raised in support
        const fwd = forwardOf(this.legs.yaw, _f);
        _v.subVectors(this.aim, this.legs.pos);
        const dy = this.aim.y - (this.legs.pelvisY + WAIST + SHOULDER_Y);
        const dh = Math.max(0.05, _v.x * fwd.x + _v.z * fwd.z);
        const pitch = Math.PI / 2 + Math.atan2(dy, dh);
        p.sp = [1.25 + 0.06 * Math.sin(t * 3.1), Math.min(2.6, Math.max(0.5, pitch)) + 0.04 * Math.sin(t * 7)];
        p.sa = [0.25, 0.05];
        p.el = [1.2, 0.18];
        p.lean = 0.08;
        p.look = 0;
        p.nod = -Math.atan2(dy, dh) * 0.5;
        break;
      }
      case 'carry':
        p.sp = [0.62, 0.62];
        p.sa = [0.12, 0.12];
        p.el = [1.25, 1.25];
        p.lean = moving ? 0.02 : 0;
        break;
      case 'drop': {
        // kneel and reach down (0–0.9 s), place (0.9 s), stand (0.9–1.8 s)
        const k = this.t < 0.9 ? smooth(this.t / 0.9) : 1 - smooth((this.t - 0.9) / 0.9);
        p.crouch = 0.17 * k;
        p.lean = 0.75 * k;
        p.sp = [0.4 + 0.9 * k, 0.4 + 0.9 * k];
        p.el = [0.3 + 0.2 * k, 0.3 + 0.2 * k];
        p.sa = [0.15, 0.15];
        p.nod = 0.35 * k;
        break;
      }
      default:
        break;
    }
    return p;
  }

  /**
   * Moves to (x, z) facing yaw (the caller integrates its path) and poses the body. `run` blends
   * walk to run. Writes every segment matrix.
   */
  update(dt: number, x: number, z: number, yaw: number, ground: Ground): void {
    this.t += dt;
    this.clock += dt;
    const run = this.action === 'run' ? 1 : 0;
    const tp = this.target();
    this.legs.crouch = tp.crouch;
    this.legs.update(dt, x, z, yaw, ground, run);
    // ease the upper body towards the target pose
    const k = Math.min(1, dt * (this.action === 'walk' || this.action === 'run' ? 14 : 7));
    const P = this.p;
    for (const key of ['sp', 'sa', 'el'] as const) for (let i = 0; i < 2; i++) P[key][i]! += (tp[key][i]! - P[key][i]!) * k;
    for (const key of ['lean', 'twist', 'nod', 'look', 'crouch'] as const) P[key] += (tp[key] - P[key]) * k;
    if (this.action === 'drop' && !this.podDown && this.t >= 0.9) {
      this.podDown = true;
      forwardOf(this.legs.yaw, _f);
      this.podAt.set(this.legs.pos.x + _f.x * 0.3, 0, this.legs.pos.z + _f.z * 0.3);
      this.podAt.y = ground(this.podAt.x, this.podAt.z);
      this.podYaw = this.legs.yaw;
    }
    if (this.action === 'drop' && this.t > 1.8) this.setAction('idle');
    this.pose();
  }

  /** Segment matrices from the legs and the eased upper-body pose. */
  private pose(): void {
    const L = this.legs;
    const P = this.p;
    const M = this.mats;
    const fwd = forwardOf(L.yaw, _f);
    // pelvis: centred between the hip joints, turned to the body yaw
    _q.setFromAxisAngle(Y, L.yaw);
    M[SEG.pelvis]!.compose(_v.set(L.pos.x, L.pelvisY, L.pos.z), _q, _w.set(1, 1, 1));
    // torso: waist, twist, lean forward (about the body's right axis, +Z)
    M[SEG.torso]!.copy(M[SEG.pelvis]!).multiply(_m.makeTranslation(0, WAIST, 0)).multiply(_m2.makeRotationY(P.twist)).multiply(_m.makeRotationZ(-P.lean));
    M[SEG.head]!.copy(M[SEG.torso]!).multiply(_m.makeTranslation(0, TORSO, 0)).multiply(_m2.makeRotationY(P.look - P.twist)).multiply(_m.makeRotationZ(-P.nod));
    M[SEG.pack]!.copy(M[SEG.torso]!);
    // arms: shoulder pitch (Rz, forward +), abduction (Rx, out to the arm's side), elbow (Rz)
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1;
      const ua = M[i === 0 ? SEG.uarmL : SEG.uarmR]!;
      ua.copy(M[SEG.torso]!).multiply(_m.makeTranslation(0, SHOULDER_Y, s * SHOULDER_Z)).multiply(_m2.makeRotationZ(P.sp[i]!)).multiply(_m.makeRotationX(-s * P.sa[i]!));
      const fa = M[i === 0 ? SEG.farmL : SEG.farmR]!;
      fa.copy(ua).multiply(_m.makeTranslation(0, -UARM, 0)).multiply(_m2.makeRotationZ(P.el[i]!));
      M[i === 0 ? SEG.handL : SEG.handR]!.copy(fa).multiply(_m.makeTranslation(0, -FARM, 0));
    }
    M[SEG.tool]!.copy(M[SEG.handR]!);
    const tt = TOOL_TIP[this.variant.tool]!;
    this.tip.set(tt[0], tt[1], tt[2]).applyMatrix4(M[SEG.tool]!);
    // the carried box sits between the hands, in front of the chest
    M[SEG.box]!.copy(M[SEG.torso]!).multiply(_m.makeTranslation(0.17, 0.1, 0));
    // legs from the IK solution
    for (let i = 0; i < 2; i++) {
      boneMatrix(M[i === 0 ? SEG.thighL : SEG.thighR]!, L.hips[i]!, L.knees[i]!, fwd);
      boneMatrix(M[i === 0 ? SEG.shinL : SEG.shinR]!, L.knees[i]!, L.ankles[i]!, fwd);
      const ft = L.feet[i]!;
      // boot: at the ankle, flat, turned to the foot's own heading (fixed while planted); toes
      // dip a little through the swing
      _q.setFromAxisAngle(Y, ft.yaw);
      M[i === 0 ? SEG.footL : SEG.footR]!.compose(L.ankles[i]!, _q, _w.set(1, 1, 1)).multiply(_m.makeRotationZ(ft.stance ? 0 : -0.35 * Math.sin(Math.PI * ft.swing)));
    }
  }

  /** Speed for an action (tiles/s). */
  static speedOf(a: EngAction): number {
    return a === 'run' ? ENGINEER_RUN : ENGINEER_WALK;
  }
}

function smooth(u: number): number {
  const v = Math.max(0, Math.min(1, u));
  return v * v * (3 - 2 * v);
}

// ---- parts -------------------------------------------------------------------------------------------

/** Tapered capsule along −Y from the joint (y = 0) to y = −len: radius r0 at the top, r1 at the bottom. */
function limb(p: PB, key: 'gunmetal' | 'ceramic' | 'dark' | 'bronze', len: number, r0: number, r1: number, seg = 12): void {
  const pts: Pt[] = [];
  const n = p.full ? 4 : 2;
  // bottom cap, side, top cap (smooth normals)
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * (Math.PI / 2);
    pts.push([r1 * Math.sin(a), -len + r1 * (1 - Math.cos(a))]);
  }
  for (let k = n; k >= 0; k--) {
    const a = (k / n) * (Math.PI / 2);
    pts.push([r0 * Math.sin(a), -r0 * (1 - Math.cos(a))]);
  }
  p.lathe(key, pts, {}, { seg, smooth: true });
}

function dome(p: PB, key: 'ceramic' | 'gunmetal' | 'glow' | 'dark' | 'bronze', r: number, y0: number, opts: { phi?: [number, number]; squash?: number; cap?: number; from?: number; seg?: number; imp?: 'major' | 'minor' | 'fine' } = {}): void {
  // sphere zone from polar angle `from` (0 = top) down to `cap`
  const pts: Pt[] = [];
  const cap = opts.cap ?? Math.PI / 2;
  const from = opts.from ?? 0;
  const n = p.full ? 7 : 4;
  for (let k = n; k >= 0; k--) {
    const a = from + (k / n) * (cap - from);
    pts.push([r * Math.sin(a), y0 + r * Math.cos(a) * (opts.squash ?? 1)]);
  }
  p.lathe(key, pts, {}, { seg: opts.seg ?? 16, smooth: true, phi: opts.phi, imp: opts.imp });
}

export function engineerBuilders(): Map<string, (p: PB) => void> {
  const m = new Map<string, (p: PB) => void>();
  // pelvis: rounded hips of the suit, a belt with pouches and a bronze buckle (the tool harness)
  m.set('eng/pelvis', (p) => {
    p.lathe('gunmetal', [[0, -0.075], [0.07, -0.075], [0.09, -0.04], [0.088, 0.02], [0.078, 0.045], [0, 0.045]], { sx: 0.68 }, { seg: 16, smooth: true });
    p.lathe('dark', [[0.088, 0.0], [0.094, 0.0], [0.094, 0.026], [0.086, 0.026], [0.088, 0]], { sx: 0.7 }, { seg: 16, imp: 'minor' });
    p.box('bronze', 0.012, 0.024, 0.032, { x: 0.064, y: 0.002 }, { c: 0.003, imp: 'minor' });
    for (const s of [-1, 1]) {
      p.box('gunmetal', 0.045, 0.048, 0.03, { x: 0.026, y: -0.04, z: s * 0.088 }, { c: 0.008, imp: 'minor' });
      p.box('gunmetal', 0.04, 0.044, 0.028, { x: -0.03, y: -0.038, z: s * 0.084 }, { c: 0.007, imp: 'fine' });
    }
    p.box('bronze', 0.025, 0.065, 0.022, { x: -0.06, y: -0.05, z: 0.06 }, { c: 0.004, imp: 'fine' });
  });
  // torso: rounded gunmetal suit, ivory chest and back armour, bronze harness, collar ring
  m.set('eng/torso', (p) => {
    const body: Pt[] = [[0, 0], [0.078, 0], [0.084, 0.06], [0.097, 0.15], [0.104, 0.22], [0.098, 0.262], [0.07, 0.285], [0.042, TORSO], [0, TORSO]];
    p.lathe('gunmetal', body, { sx: 0.64 }, { seg: 18, smooth: true });
    // armour: front and back sectors of a slightly larger shell
    const shell: Pt[] = [[0.094, 0.1], [0.104, 0.15], [0.111, 0.22], [0.105, 0.258], [0.08, 0.28]];
    p.lathe('ceramic', shell, { sx: 0.66 }, { seg: 10, phi: [Math.PI / 2 - 0.95, 1.9], wear: [0, 3] });
    p.lathe('ceramic', shell, { sx: 0.66 }, { seg: 10, phi: [-Math.PI / 2 - 0.85, 1.7], wear: [0, 3], imp: 'minor' });
    // harness straps over the shoulders and across the chest
    for (const s of [-1, 1]) {
      p.beam('bronze', [0.072, 0.1, s * 0.05], [0.066, 0.25, s * 0.055], 0.008, 0.017, { imp: 'minor', c: 0.002 });
      p.box('bronze', 0.012, 0.018, 0.026, { x: 0.074, y: 0.14, z: s * 0.05 }, { imp: 'fine', c: 0.003 });
    }
    p.box('dark', 0.012, 0.016, 0.11, { x: 0.068, y: 0.1 }, { imp: 'fine', c: 0.002 });
    p.box('glow', 0.006, 0.012, 0.022, { x: 0.073, y: 0.205, z: -0.035 }, { imp: 'minor', c: 0.001 });
    p.cylY('gunmetal', 0.045, 0.05, 0.03, { y: TORSO - 0.022 }, { seg: 14, imp: 'minor' });
    // shoulder joints the arms hang from
    for (const s of [-1, 1]) p.lathe('gunmetal', [[0, -0.035], [0.034, -0.03], [0.04, 0], [0.034, 0.03], [0, 0.035]], { y: SHOULDER_Y, z: s * SHOULDER_Z }, { axis: 'z', seg: 12, smooth: true });
  });
  // helmets (head frame: origin at the neck base)
  const neck = (p: PB) => p.cylY('gunmetal', 0.026, 0.03, 0.03, {}, { seg: 12, imp: 'minor' });
  m.set('eng/helmet0', (p) => {
    neck(p);
    dome(p, 'ceramic', 0.068, 0.072, { cap: Math.PI * 0.95, seg: 18 });
    // full-face visor: a band round the front at eye level
    dome(p, 'glow', 0.0696, 0.072, { phi: [Math.PI / 2 - 0.9, 1.8], from: Math.PI * 0.4, cap: Math.PI * 0.64, seg: 10, imp: 'major' });
    for (const s of [-1, 1]) p.cylZ('bronze', 0.018, 0.012, 0, 0.07, s * 0.063, { seg: 10, imp: 'minor' });
    p.box('gunmetal', 0.03, 0.012, 0.11, { x: -0.04, y: 0.12 }, { imp: 'fine', c: 0.004 });
  });
  m.set('eng/helmet1', (p) => {
    neck(p);
    dome(p, 'ceramic', 0.066, 0.072, { cap: Math.PI * 0.95, seg: 18 });
    dome(p, 'glow', 0.0675, 0.072, { phi: [Math.PI / 2 - 0.6, 1.2], from: Math.PI * 0.45, cap: Math.PI * 0.58, seg: 8 });
    // headlamp on the brow and a whip aerial on the left
    p.tube('bronze', 0.016, 0.03, { x: 0.042, y: 0.12 }, { seg: 10 });
    p.tube('glow', 0.012, 0.006, { x: 0.071, y: 0.12 }, { seg: 10 });
    p.cylY('gunmetal', 0.003, 0.004, 0.11, { y: 0.1, z: -0.05 }, { seg: 5, imp: 'minor' });
    p.cylY('glow', 0.006, 0.006, 0.01, { y: 0.21, z: -0.05 }, { seg: 6, imp: 'fine' });
  });
  m.set('eng/helmet2', (p) => {
    neck(p);
    p.frustum('ceramic', 0.115, 0.1, 0.115, 0.82, { y: 0.03 }, { c: 0.014 });
    p.box('gunmetal', 0.15, 0.012, 0.135, { x: 0.006, y: 0.122 }, { c: 0.004 });
    p.box('ceramic', 0.06, 0.03, 0.04, { x: -0.01, y: 0.13 }, { c: 0.008, imp: 'minor' });
    p.box('glow', 0.006, 0.016, 0.085, { x: 0.058, y: 0.075 }, { c: 0.002 });
  });
  // backpacks (torso frame)
  m.set('eng/pack0', (p) => {
    p.box('gunmetal', 0.07, 0.16, 0.12, { x: -0.1, y: 0.08 }, { c: 0.012 });
    p.box('ceramic', 0.02, 0.13, 0.1, { x: -0.14, y: 0.095 }, { c: 0.008 });
    for (const s of [-1, 1]) {
      p.cylY('bronze', 0.019, 0.019, 0.13, { x: -0.1, y: 0.07, z: s * 0.074 }, { seg: 10 });
      p.cylY('gunmetal', 0.014, 0.019, 0.015, { x: -0.1, y: 0.2, z: s * 0.074 }, { seg: 10, imp: 'minor' });
    }
    p.box('glow', 0.012, 0.012, 0.03, { x: -0.1, y: 0.24 }, { c: 0.002, imp: 'minor' });
  });
  m.set('eng/pack1', (p) => {
    for (const s of [-1, 1]) p.beam('gunmetal', [-0.09, 0.03, s * 0.055], [-0.09, 0.27, s * 0.055], 0.014, 0.014, { c: 0.003 });
    p.beam('gunmetal', [-0.09, 0.05, -0.06], [-0.09, 0.05, 0.06], 0.014, 0.014, { c: 0.003, imp: 'minor' });
    p.lathe('ceramic', [[0, 0], [0.04, 0.005], [0.045, 0.03], [0.045, 0.15], [0.04, 0.175], [0, 0.18]], { x: -0.115, y: 0.05 }, { seg: 14, smooth: true });
    p.cylY('bronze', 0.047, 0.047, 0.02, { x: -0.115, y: 0.12 }, { seg: 14, imp: 'minor' });
    p.cylY('gunmetal', 0.004, 0.005, 0.2, { x: -0.1, y: 0.25, z: 0.05 }, { seg: 5, imp: 'minor' });
    p.cylY('glow', 0.008, 0.008, 0.012, { x: -0.1, y: 0.45, z: 0.05 }, { seg: 6, imp: 'minor' });
  });
  // arms (symmetric about their own axis: one part for left and right)
  m.set('eng/uarm', (p) => {
    limb(p, 'gunmetal', UARM, 0.037, 0.032);
    dome(p, 'ceramic', 0.052, -0.016, { cap: Math.PI * 0.45, squash: 0.8, seg: 12 });
  });
  m.set('eng/farm', (p) => {
    limb(p, 'gunmetal', FARM, 0.032, 0.027, 12);
    p.cylY('ceramic', 0.036, 0.031, 0.075, { y: -0.118 }, { seg: 12 });
    p.cylY('bronze', 0.034, 0.034, 0.01, { y: -0.124 }, { seg: 12, imp: 'minor' });
  });
  m.set('eng/hand', (p) => {
    p.box('dark', 0.042, 0.056, 0.038, { y: -0.056 }, { c: 0.01 });
    p.box('dark', 0.016, 0.028, 0.014, { x: 0.022, y: -0.034, z: 0.014 }, { c: 0.003, imp: 'minor' });
  });
  m.set('eng/thigh', (p) => {
    limb(p, 'gunmetal', 0.215, 0.052, 0.042, 14);
    p.prof('ceramic', [[0.03, -0.04], [0.052, -0.052], [0.054, -0.16], [0.04, -0.185], [0.03, -0.185]], 0.07, {}, { c: 0.008 });
  });
  m.set('eng/shin', (p) => {
    limb(p, 'gunmetal', 0.215, 0.041, 0.034, 14);
    dome(p, 'ceramic', 0.04, -0.01, { cap: Math.PI * 0.6, seg: 10, phi: [Math.PI / 2 - 0.9, 1.8] });
    p.prof('ceramic', [[0.02, -0.03], [0.046, -0.04], [0.046, -0.15], [0.036, -0.19], [0.02, -0.19]], 0.064, {}, { c: 0.008 });
    p.cylY('bronze', 0.038, 0.038, 0.012, { y: -0.205 }, { seg: 12, imp: 'minor' });
  });
  // boot (ankle frame: sole at y = −0.045)
  m.set('eng/boot', (p) => {
    p.box('gunmetal', 0.135, 0.058, 0.07, { x: 0.024, y: -0.045 }, { c: 0.014 });
    p.box('dark', 0.142, 0.015, 0.074, { x: 0.024, y: -0.045 }, { c: 0.003, imp: 'minor' });
    p.box('ceramic', 0.046, 0.032, 0.072, { x: 0.07, y: -0.03 }, { c: 0.01, imp: 'minor' });
  });
  // tools, held in the right fist and pointing along the forearm (−Y of the hand frame)
  m.set('eng/tool0', (p) => {
    p.box('bronze', 0.024, 0.05, 0.024, { x: 0.004, y: -0.07 }, { c: 0.004 });
    p.box('gunmetal', 0.034, 0.08, 0.03, { x: 0.012, y: -0.15 }, { c: 0.006 });
    p.cylY('gunmetal', 0.011, 0.013, 0.02, { x: 0.012, y: -0.17 }, { seg: 10 });
    p.cylY('glow', 0.009, 0.009, 0.01, { x: 0.012, y: -0.18 }, { seg: 10 });
  });
  m.set('eng/tool1', (p) => {
    p.box('gunmetal', 0.018, 0.09, 0.02, { x: 0.006, y: -0.13 }, { c: 0.004 });
    p.box('bronze', 0.04, 0.03, 0.03, { x: 0.01, y: -0.15 }, { c: 0.006 });
    p.box('glow', 0.02, 0.008, 0.02, { x: 0.01, y: -0.157 }, { c: 0.002, imp: 'minor' });
  });
  m.set('eng/tool2', (p) => {
    p.box('gunmetal', 0.012, 0.075, 0.06, { x: 0.03, y: -0.125 }, { c: 0.004 });
    p.box('glow', 0.004, 0.055, 0.045, { x: 0.038, y: -0.12 }, { c: 0.001 });
    p.box('bronze', 0.02, 0.016, 0.04, { x: 0.03, y: -0.13 }, { c: 0.003, imp: 'minor' });
  });
  // carried salvage: a gunmetal crate with ivory panels and alien scrap on top
  m.set('eng/box', (p) => {
    p.box('gunmetal', 0.11, 0.1, 0.13, { y: -0.05 }, { c: 0.01 });
    for (const s of [-1, 1]) p.box('ceramic', 0.09, 0.07, 0.006, { y: -0.035, z: s * 0.066 }, { c: 0.002, imp: 'minor' });
    p.box('dark', 0.05, 0.03, 0.06, { x: -0.01, y: 0.05, z: 0.02, ry: 0.5 }, { c: 0.008 });
    p.prism('dark', 5, 0.03, 0.04, { x: 0.025, y: 0.05, z: -0.03 }, { c: 0.006, imp: 'minor' });
  });
  // dropped temporary turret pod: tripod, small head, short barrel, cyan eye
  m.set('eng/pod', (p) => {
    for (let k = 0; k < 3; k++) {
      const a = (k * Math.PI * 2) / 3 + 0.5;
      p.beam('gunmetal', [Math.cos(a) * 0.15, 0, -Math.sin(a) * 0.15], [0, 0.16, 0], 0.022, 0.022, { c: 0.004 });
    }
    p.cylY('bronze', 0.05, 0.06, 0.04, { y: 0.15 }, { seg: 14 });
    p.box('ceramic', 0.14, 0.08, 0.11, { y: 0.19 }, { c: 0.012 });
    p.tube('gunmetal', 0.016, 0.14, { x: 0.06, y: 0.235 }, { seg: 10 });
    p.box('glow', 0.006, 0.014, 0.05, { x: 0.071, y: 0.21 }, { c: 0.002, imp: 'minor' });
  });
  return m;
}

/** Part id drawn on each segment for a variant (null = nothing). */
export function segmentParts(v: EngVariant, carrying: boolean): Array<string | null> {
  return ENG_SEGS.map((s) => {
    switch (s) {
      case 'pelvis':
        return 'eng/pelvis';
      case 'torso':
        return 'eng/torso';
      case 'head':
        return `eng/helmet${v.helmet}`;
      case 'pack':
        return `eng/pack${v.pack}`;
      case 'uarmL':
      case 'uarmR':
        return 'eng/uarm';
      case 'farmL':
      case 'farmR':
        return 'eng/farm';
      case 'handL':
      case 'handR':
        return 'eng/hand';
      case 'thighL':
      case 'thighR':
        return 'eng/thigh';
      case 'shinL':
      case 'shinR':
        return 'eng/shin';
      case 'footL':
      case 'footR':
        return 'eng/boot';
      case 'tool':
        return carrying ? null : `eng/tool${v.tool}`;
      case 'box':
        return carrying ? 'eng/box' : null;
    }
  });
}
