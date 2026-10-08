// W23 biped legs: a gait that plants each foot on the ground and two-bone IK that bends the leg to
// reach it. Shared by the engineers (1.8 m) and the commander mech (about 7 m). No rendering here.
//
// How the feet stay planted:
//   1. The gait advances by distance walked, not by time: phase += distance / stride (plus
//      |turn| × turnR, so turning on the spot also steps). Each foot is in stance for the first
//      `duty` of its cycle, the two feet half a cycle apart.
//   2. At touchdown the foot's ground point and heading are stored in world space. For the whole
//      stance the foot is drawn at that stored point, whatever the body does.
//   3. A swinging foot travels from its lift-off point to a target re-aimed every frame: the
//      neutral foot position under the moving hip, plus half the stance travel (duty × stride / 2)
//      along the walking direction, so it lands as far ahead of the hip as it will end behind it.
//      At the end of the swing it is exactly on the target, which becomes the plant point (no pop).
//   4. The pelvis is lowered whenever a planted foot would otherwise be out of reach:
//      hipY ≤ ankleY + √((0.995 · (thigh + shin))² − horizontal²). With the target always
//      inside reach, the two-bone solution puts the ankle exactly on it, so a planted foot does not
//      slide (test/w23-gait.test.ts measures the drawn ankle through a stance).
//   5. When the body stops, a foot in mid-swing finishes its step at `settle` tiles/s towards the
//      neutral position, then both feet stay planted.

import { Matrix4, Vector3 } from 'three';

export interface LegSpec {
  /** Hip joint to knee, knee to ankle (tiles). */
  thigh: number;
  shin: number;
  /** Ankle joint above the sole. */
  ankle: number;
  /** Hip joints either side of the pelvis centre. */
  hipOut: number;
  /** Pelvis (hip joint) height standing, tiles above the ground. */
  hipY: number;
  /** Feet either side of the body line when standing (≥ hipOut for a stable stance). */
  footOut: number;
}

export interface GaitSpec {
  /** Cycle length (two steps), tiles. */
  stride: number;
  /** Fraction of the cycle a foot is on the ground. */
  duty: number;
  /** Swing height of the foot, tiles. */
  lift: number;
}

export interface BipedSpec {
  leg: LegSpec;
  walk: GaitSpec;
  run: GaitSpec;
  /** Foot radius for turning on the spot (tiles of gait progress per radian turned). */
  turnR: number;
  /** Speed at which a step is finished after the body stops, tiles/s. */
  settle: number;
}

export interface Foot {
  /** Sole centre on the ground (world). */
  pos: Vector3;
  yaw: number;
  stance: boolean;
  plant: Vector3;
  plantYaw: number;
  from: Vector3;
  fromYaw: number;
  /** 0 … 1 through the swing (0 in stance). */
  swing: number;
}

export type Ground = (x: number, z: number) => number;

const _d = new Vector3();
const _p = new Vector3();
const _t = new Vector3();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();

/**
 * Two-bone IK: knee and ankle for a hip, a target, bone lengths and a pole (the direction the
 * knee points). The ankle lands on the target when it is within reach; otherwise the leg points
 * at it, fully stretched (or fully folded).
 */
export function solveTwoBone(hip: Vector3, target: Vector3, l1: number, l2: number, pole: Vector3, knee: Vector3, ankle: Vector3): boolean {
  _d.subVectors(target, hip);
  let dist = _d.length();
  const reach = l1 + l2;
  const minR = Math.abs(l1 - l2) + 1e-4;
  let ok = true;
  if (dist > reach * 0.9999) {
    dist = reach * 0.9999;
    ok = false;
  } else if (dist < minR) {
    dist = minR;
    ok = false;
  }
  if (_d.lengthSq() < 1e-12) _d.set(0, -1, 0);
  _d.normalize();
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const r = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  // pole made perpendicular to the hip–ankle line
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_p.lengthSq() < 1e-10) _p.set(1, 0, 0).addScaledVector(_d, -_d.x);
  _p.normalize();
  ankle.copy(hip).addScaledVector(_d, dist);
  knee.copy(hip).addScaledVector(_d, a).addScaledVector(_p, r);
  return ok;
}

/**
 * Matrix of a bone modelled from its joint along −Y, with +X facing `forward`: origin at `from`,
 * +Y pointing from `to` back to `from`.
 */
export function boneMatrix(out: Matrix4, from: Vector3, to: Vector3, forward: Vector3): Matrix4 {
  _y.subVectors(from, to);
  const len = _y.length();
  if (len < 1e-9) _y.set(0, 1, 0);
  else _y.divideScalar(len);
  _x.copy(forward).addScaledVector(_y, -forward.dot(_y));
  if (_x.lengthSq() < 1e-10) _x.set(1, 0, 0).addScaledVector(_y, -_y.x);
  _x.normalize();
  _z.crossVectors(_x, _y);
  out.makeBasis(_x, _y, _z);
  out.setPosition(from);
  return out;
}

/** Body forward (+X of the body turned by yaw about +Y; yaw 0 faces +x, positive turns towards −z). */
export function forwardOf(yaw: number, out = new Vector3()): Vector3 {
  return out.set(Math.cos(yaw), 0, -Math.sin(yaw));
}
/** Body right (+Z of the body). */
export function rightOf(yaw: number, out = new Vector3()): Vector3 {
  return out.set(Math.sin(yaw), 0, Math.cos(yaw));
}

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (u: number) => u * u * (3 - 2 * u);

export class Biped {
  readonly pos = new Vector3();
  yaw = 0;
  /** Gait phase (cycles). */
  phase = 0;
  run = 0;
  /** Extra crouch (tiles the pelvis drops), for kneeling and build poses. */
  crouch = 0;
  pelvisY = 0;
  readonly feet: [Foot, Foot];
  readonly hips = [new Vector3(), new Vector3()];
  readonly knees = [new Vector3(), new Vector3()];
  readonly ankles = [new Vector3(), new Vector3()];
  /** Horizontal speed over the last update (tiles/s). */
  speed = 0;
  /** Whether the last IK solve reached every planted foot. */
  reached = true;
  private vel = new Vector3();
  private started = false;
  private wasActive = false;

  constructor(readonly spec: BipedSpec) {
    const mk = (): Foot => ({ pos: new Vector3(), yaw: 0, stance: true, plant: new Vector3(), plantYaw: 0, from: new Vector3(), fromYaw: 0, swing: 0 });
    this.feet = [mk(), mk()];
  }

  /** Neutral sole position of foot i (0 left, 1 right) under a body at p, yaw. */
  neutral(i: number, p: Vector3, yaw: number, ground: Ground, out: Vector3): Vector3 {
    const s = i === 0 ? -1 : 1;
    rightOf(yaw, out).multiplyScalar(s * this.spec.leg.footOut).add(p);
    out.y = ground(out.x, out.z);
    return out;
  }

  /** Places the body and both feet at rest (no stepping). */
  place(x: number, z: number, yaw: number, ground: Ground): void {
    this.pos.set(x, ground(x, z), z);
    this.yaw = yaw;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i]!;
      this.neutral(i, this.pos, yaw, ground, f.plant);
      f.pos.copy(f.plant);
      f.from.copy(f.plant);
      f.yaw = f.plantYaw = f.fromYaw = yaw;
      f.stance = true;
      f.swing = 0;
    }
    this.phase = 0;
    this.started = true;
    this.pelvisY = this.pos.y + this.spec.leg.hipY;
    this.solve(ground, 1);
  }

  private gait(): GaitSpec {
    const a = this.spec.walk;
    const b = this.spec.run;
    const t = this.run;
    return { stride: a.stride + (b.stride - a.stride) * t, duty: a.duty + (b.duty - a.duty) * t, lift: a.lift + (b.lift - a.lift) * t };
  }

  /**
   * Moves the body to (x, z) facing `yaw` and steps the feet. `run` 0 … 1 blends walk to run.
   */
  update(dt: number, x: number, z: number, yaw: number, ground: Ground, run = 0): void {
    if (!this.started) this.place(x, z, yaw, ground);
    this.run = run;
    const g = this.gait();
    const dx = x - this.pos.x;
    const dz = z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    const dyaw = wrapPi(yaw - this.yaw);
    this.speed = dt > 0 ? dist / dt : 0;
    if (dt > 0) this.vel.set(dx / dt, 0, dz / dt);
    this.pos.set(x, ground(x, z), z);
    this.yaw = yaw;
    const motion = dist + Math.abs(dyaw) * this.spec.turnR;
    const active = motion > 1e-6;
    const moving = dist > 1e-6;
    if (active && !this.wasActive) this.restart(g, moving ? _t.set(dx, 0, dz).normalize() : null, ground);
    this.wasActive = active;
    let progress = motion;
    const swinging = !this.feet[0].stance || !this.feet[1].stance;
    if (!active && swinging) progress = this.spec.settle * dt;
    if (progress > 0) {
      const prev = this.phase;
      this.phase += progress / g.stride;
      // a step must not be skipped in one frame: clamp to a quarter cycle
      if (this.phase - prev > 0.25) this.phase = prev + 0.25;
    }
    // swing target lead: half the stance travel along the walking direction
    const lead = moving ? (g.duty * g.stride) / 2 : 0;
    const vdir = moving ? _t.set(dx, 0, dz).normalize() : _t.set(0, 0, 0);
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i]!;
      const ph = (((this.phase + i * 0.5) % 1) + 1) % 1;
      const stance = ph < g.duty;
      if (stance && !f.stance) {
        // touchdown: the swing ended on its target; that point is now fixed in the world
        f.plant.copy(f.pos);
        f.plant.y = ground(f.plant.x, f.plant.z);
        f.plantYaw = f.yaw;
      } else if (!stance && f.stance) {
        f.from.copy(f.plant);
        f.fromYaw = f.plantYaw;
      }
      f.stance = stance;
      if (stance) {
        f.swing = 0;
        f.pos.copy(f.plant);
        f.yaw = f.plantYaw;
      } else {
        const u = (ph - g.duty) / (1 - g.duty);
        f.swing = u;
        const tgt = this.neutral(i, this.pos, yaw, ground, _p).addScaledVector(vdir, lead);
        const k = smooth(Math.min(1, u * 1.08));
        f.pos.lerpVectors(f.from, tgt, k);
        f.pos.y = ground(f.pos.x, f.pos.z) + g.lift * Math.sin(Math.PI * Math.min(1, u));
        f.yaw = f.fromYaw + wrapPi(yaw - f.fromYaw) * k;
      }
    }
    this.solve(ground, dt);
  }

  /**
   * Starting to move from rest: both feet are planted wherever the last steps left them. The foot
   * further forward along the new direction keeps its stance, with the phase set so its stance
   * ends as far behind the hip as a steady walk would; the other foot lifts at once.
   */
  private restart(g: GaitSpec, dir: Vector3 | null, ground: Ground): void {
    if (!this.feet[0].stance || !this.feet[1].stance) return;
    const off = [0, 1].map((i) => (dir ? _y.subVectors(this.feet[i]!.plant, this.neutral(i, this.pos, this.yaw, ground, _p)).dot(dir) : 0));
    const lead = off[0]! >= off[1]! ? 0 : 1;
    let ph = g.duty / 2 - off[lead]! / g.stride;
    ph = Math.max(g.duty - 0.5 + 1e-3, Math.min(g.duty - 1e-3, ph));
    this.phase = ph - lead * 0.5;
  }

  /** Pelvis height (lowered to keep planted feet in reach) and leg IK. */
  private solve(ground: Ground, dt: number): void {
    const L = this.spec.leg;
    const reach = 0.995 * (L.thigh + L.shin);
    const right = rightOf(this.yaw, _z);
    // nominal: the higher of the ground under the body and the mean plant height, plus the hip
    // height; the reach limit below then lowers it at double support, which is the walking bob
    const gAvg = (this.feet[0].plant.y + this.feet[1].plant.y) / 2;
    const base = Math.max(this.pos.y, gAvg) + L.hipY - this.crouch;
    let limit = Infinity;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i]!;
      const s = i === 0 ? -1 : 1;
      const hx = this.pos.x + right.x * s * L.hipOut;
      const hz = this.pos.z + right.z * s * L.hipOut;
      const ay = f.pos.y + L.ankle;
      const hd = Math.hypot(f.pos.x - hx, f.pos.z - hz);
      // planted feet must stay reachable; a swinging foot is allowed to tuck up
      if (f.stance) limit = Math.min(limit, ay + Math.sqrt(Math.max(0, reach * reach - hd * hd)));
    }
    const k = Math.min(1, dt * 10);
    let y = this.pelvisY + (base - this.pelvisY) * k;
    if (!Number.isFinite(y)) y = base;
    this.pelvisY = Math.min(y, limit);
    const fwd = forwardOf(this.yaw, _x);
    this.reached = true;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i]!;
      const s = i === 0 ? -1 : 1;
      const hip = this.hips[i]!.set(this.pos.x + right.x * s * L.hipOut, this.pelvisY, this.pos.z + right.z * s * L.hipOut);
      const tgt = _y.copy(f.pos);
      tgt.y += L.ankle;
      const ok = solveTwoBone(hip, tgt, L.thigh, L.shin, fwd, this.knees[i]!, this.ankles[i]!);
      if (f.stance && !ok) this.reached = false;
    }
  }
}
