// Turret aiming maths for the W20 bench. Pure functions and plain objects only (no three.js, no
// DOM), so the unit tests in look/test/ run them headless under node:test.
//
// Conventions (same as the look app): +Y up, 1 unit = 1 tile = 2 m. Yaw turns the barrel's +X
// about +Y, so a yaw of θ points the barrel along (cos θ, 0, −sin θ). Pitch raises the barrel
// above the horizontal.
//
// Each axis is driven by a rate-limited, acceleration-limited controller: the commanded rate is
// the fastest rate from which the axis can still stop on the target at the stated acceleration
// (√(2·a·|error|)), capped at the maximum turn rate, plus a feed-forward of the target's own
// angular rate when tracking. The rate then changes by at most a·dt per tick. The result eases in
// and out and never exceeds the turn-rate or angle limits on any tick.

export const DEG = Math.PI / 180;

export interface AxisSpec {
  /** Maximum turn rate, rad/s. */
  maxRate: number;
  /** Angular acceleration and deceleration, rad/s². */
  accel: number;
  /** Angle limits, rad (omit for a continuous axis). */
  min?: number;
  max?: number;
  /** Continuous axis: errors wrap to ±π so it takes the short way round. */
  wrap: boolean;
}

export interface AxisState {
  angle: number;
  rate: number;
}

/** Traverse: 60°/s, 240°/s² (0.25 s to full rate), continuous. */
export const TRAVERSE: AxisSpec = { maxRate: 60 * DEG, accel: 240 * DEG, wrap: true };
/** Elevation: 30°/s, 120°/s², −5° to +45°. */
export const ELEVATION: AxisSpec = { maxRate: 30 * DEG, accel: 120 * DEG, min: -5 * DEG, max: 45 * DEG, wrap: false };

/** Shell muzzle speed (tiles/s; 50 tiles/s = 100 m/s) and gravity (9.81 m/s² = 4.905 tiles/s²). */
export const SHELL_SPEED = 50;
export const GRAVITY = 4.905;

export function wrapPi(a: number): number {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

export function clampToSpec(angle: number, spec: AxisSpec): number {
  if (spec.min !== undefined && angle < spec.min) return spec.min;
  if (spec.max !== undefined && angle > spec.max) return spec.max;
  return angle;
}

/** Signed error from the axis angle to the target, short way round on a continuous axis. */
export function axisError(s: AxisState, target: number, spec: AxisSpec): number {
  return spec.wrap ? wrapPi(target - s.angle) : clampToSpec(target, spec) - s.angle;
}

/**
 * Advances one axis by dt towards `target`. `targetRate` is the target's own angular rate
 * (feed-forward when tracking a moving target; 0 for a fixed aim point). Mutates and returns `s`.
 */
export function stepAxis(s: AxisState, target: number, targetRate: number, dt: number, spec: AxisSpec): AxisState {
  if (dt <= 0) return s;
  const err = axisError(s, target, spec);
  const ff = Math.max(-spec.maxRate, Math.min(spec.maxRate, targetRate));
  // fastest closing rate from which the axis can still stop at the target, and no faster than
  // what would cover the remaining error within this tick
  const closing = Math.min(spec.maxRate, Math.sqrt(2 * spec.accel * Math.abs(err)), Math.abs(err) / dt);
  let want = ff + Math.sign(err) * closing;
  want = Math.max(-spec.maxRate, Math.min(spec.maxRate, want));
  const dv = spec.accel * dt;
  let rate = s.rate + Math.max(-dv, Math.min(dv, want - s.rate));
  rate = Math.max(-spec.maxRate, Math.min(spec.maxRate, rate));
  let step = rate * dt;
  // landing: if this step would pass a fixed target, stop on it instead of overshooting
  if (Math.abs(ff) < 1e-9 && err !== 0 && Math.sign(step) === Math.sign(err) && Math.abs(step) >= Math.abs(err)) {
    step = err;
    rate = 0;
  }
  let angle = s.angle + step;
  if (spec.wrap) angle = wrapPi(angle);
  else {
    const c = clampToSpec(angle, spec);
    if (c !== angle) {
      angle = c;
      rate = 0;
    }
  }
  s.angle = angle;
  s.rate = rate;
  return s;
}

/** Lower bound on the time an axis needs to turn through `err` from rest and stop (s). */
export function minTurnTime(err: number, spec: AxisSpec): number {
  const e = Math.abs(err);
  const tRamp = spec.maxRate / spec.accel;
  const eRamp = spec.maxRate * tRamp; // covered while accelerating and decelerating
  if (e <= eRamp) return 2 * Math.sqrt(e / spec.accel);
  return 2 * tRamp + (e - eRamp) / spec.maxRate;
}

export type Vec3 = [number, number, number];

/** Barrel direction for a yaw and pitch. */
export function barrelDir(yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  return [c * Math.cos(yaw), Math.sin(pitch), -c * Math.sin(yaw)];
}

/** Yaw that points the barrel at a horizontal offset (dx, dz). */
export function yawTo(dx: number, dz: number): number {
  return Math.atan2(-dz, dx);
}

export interface FireSolution {
  yaw: number;
  pitch: number;
  /** Flight time from the muzzle, s. */
  time: number;
  /** Where the shell meets the target (the led aim point when leading). */
  point: Vec3;
}

/**
 * Low-arc ballistic solution from the trunnion `origin` for a shell leaving the muzzle (barrel
 * length `len` ahead of the trunnion) at `speed` under `g`, to hit a target at `p` moving at
 * constant velocity `v` (pass v = 0 for no lead). Fixed-point iteration on flight time and
 * pitch; returns null when the point is out of ballistic reach.
 */
export function solveIntercept(origin: Vec3, p: Vec3, v: Vec3, speed: number, g: number, len: number, iterations = 12): FireSolution | null {
  let t = Math.hypot(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]) / speed;
  let pitch = 0;
  let aim: Vec3 = [p[0], p[1], p[2]];
  for (let k = 0; k < iterations; k++) {
    aim = [p[0] + v[0] * t, p[1] + v[1] * t, p[2] + v[2] * t];
    const dx = aim[0] - origin[0];
    const dz = aim[2] - origin[2];
    // the shell starts at the muzzle, `len` along the barrel from the trunnion
    const d = Math.hypot(dx, dz) - len * Math.cos(pitch);
    const dy = aim[1] - origin[1] - len * Math.sin(pitch);
    if (d <= 0.01) return null;
    const s2 = speed * speed;
    const disc = s2 * s2 - g * (g * d * d + 2 * dy * s2);
    if (disc < 0) return null;
    pitch = Math.atan2(s2 - Math.sqrt(disc), g * d);
    t = d / (speed * Math.cos(pitch));
  }
  return { yaw: yawTo(aim[0] - origin[0], aim[2] - origin[2]), pitch, time: t, point: aim };
}

/** One explicit step of a shell under gravity (semi-implicit Euler). Mutates pos and vel. */
export function stepShell(pos: Vec3, vel: Vec3, dt: number, g: number): void {
  vel[1] -= g * dt;
  pos[0] += vel[0] * dt;
  pos[1] += vel[1] * dt;
  pos[2] += vel[2] * dt;
}

/**
 * Exact shell position at time t after leaving `p0` with velocity `v0` (used by the runtime and
 * the tests, so both see the same trajectory regardless of frame rate).
 */
export function shellAt(p0: Vec3, v0: Vec3, t: number, g: number, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = p0[0] + v0[0] * t;
  out[1] = p0[1] + v0[1] * t - 0.5 * g * t * t;
  out[2] = p0[2] + v0[2] * t;
  return out;
}

/** Closest distance between segment a→b and point c. */
export function segPointDist(a: Vec3, b: Vec3, c: Vec3): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz;
  let u = l2 > 0 ? ((c[0] - a[0]) * abx + (c[1] - a[1]) * aby + (c[2] - a[2]) * abz) / l2 : 0;
  u = Math.max(0, Math.min(1, u));
  return Math.hypot(a[0] + abx * u - c[0], a[1] + aby * u - c[1], a[2] + abz * u - c[2]);
}
