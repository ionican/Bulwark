// The gun turret's fire control for the W20 bench: target choice, lead, traverse and elevation
// drive, firing, idle scan and manual aim. Pure and deterministic (no three.js, no DOM, no
// random numbers) so the unit tests can run the same code headless.
//
// Each tick:
//   1. keep the current target while it is alive and in range, else take the nearest in range;
//   2. solve the shot: with lead, where the target will be when the shell arrives (constant
//      velocity, ballistic arc); without lead, where it is now;
//   3. drive both axes towards the solution (aim.ts: rate- and acceleration-limited, with the
//      solution's own angular rate as feed-forward);
//   4. fire when both axes are within FIRE_TOLERANCE of the solution and the gun has cycled.
//      The shell leaves along the barrel's actual direction, not the solution's, so a miss is a
//      real miss.
// With no target in range for IDLE_DELAY seconds the turret sweeps slowly about the heading it
// stopped at.

import { DEG, ELEVATION, GRAVITY, SHELL_SPEED, TRAVERSE, axisError, barrelDir, solveIntercept, stepAxis, wrapPi, type AxisState, type FireSolution, type Vec3 } from './aim.ts';

export interface BrainTarget {
  id: number;
  /** Aim point (centre of the target), tiles. */
  pos: Vec3;
  /** Velocity, tiles/s. */
  vel: Vec3;
  alive: boolean;
  /** Hit radius, tiles. */
  radius: number;
}

export interface ShotOut {
  /** Muzzle position and shell velocity at the moment of firing. */
  from: Vec3;
  vel: Vec3;
  targetId: number | null;
  /** Predicted flight time to the aim point (0 when fired without a solution). */
  time: number;
}

export type BrainMode = 'idle' | 'scan' | 'track' | 'manual';

export interface GunSpec {
  /** Horizontal engagement range, tiles. */
  range: number;
  /** Seconds between shots (0.5 s = 120 rounds/min). */
  interval: number;
  /** Trunnion height above the turret's ground origin, tiles. */
  trunnionHeight: number;
  /** Trunnion to muzzle, tiles. */
  barrelLength: number;
  speed: number;
  gravity: number;
}

export const GUN: GunSpec = { range: 24, interval: 0.5, trunnionHeight: 0.9, barrelLength: 1.62, speed: SHELL_SPEED, gravity: GRAVITY };

export const FIRE_TOLERANCE = 0.6 * DEG;
export const IDLE_DELAY = 1.2;
/** Idle sweep: ±50° about the last heading at a peak of 12°/s, barrel at +4°. */
export const SCAN_AMPLITUDE = 50 * DEG;
export const SCAN_OMEGA = (12 * DEG) / SCAN_AMPLITUDE;
export const SCAN_PITCH = 4 * DEG;

export class TurretBrain {
  readonly spec: GunSpec;
  readonly pos: Vec3;
  yaw: AxisState = { angle: 0, rate: 0 };
  pitch: AxisState = { angle: 0, rate: 0 };
  mode: BrainMode = 'idle';
  lead = true;
  /** Manual aim: the turret follows this ground point instead of choosing targets. */
  manual = false;
  manualPoint: Vec3 | null = null;
  /** Fire as fast as the gun cycles while held (manual) / one shot on the next ready tick. */
  trigger = false;
  fireOnce = false;
  /** False while the turret is being built: axes hold, nothing fires. */
  enabled = true;
  target: BrainTarget | null = null;
  solution: FireSolution | null = null;
  shots = 0;
  cooldown = 0;
  idleFor = 0;
  /** Desired yaw and pitch this tick (for the readout and tests). */
  wantYaw = 0;
  wantPitch = 0;
  private scanHome = 0;
  private scanPhase = 0;
  private prevWant: { id: number; yaw: number; pitch: number } | null = null;

  constructor(pos: Vec3, spec: GunSpec = GUN) {
    this.pos = [pos[0], pos[1], pos[2]];
    this.spec = spec;
  }

  get trunnion(): Vec3 {
    return [this.pos[0], this.pos[1] + this.spec.trunnionHeight, this.pos[2]];
  }

  muzzle(): Vec3 {
    const o = this.trunnion;
    const d = barrelDir(this.yaw.angle, this.pitch.angle);
    const L = this.spec.barrelLength;
    return [o[0] + d[0] * L, o[1] + d[1] * L, o[2] + d[2] * L];
  }

  inRange(t: BrainTarget): boolean {
    return Math.hypot(t.pos[0] - this.pos[0], t.pos[2] - this.pos[2]) <= this.spec.range;
  }

  private solve(p: Vec3, v: Vec3): FireSolution | null {
    return solveIntercept(this.trunnion, p, v, this.spec.speed, this.spec.gravity, this.spec.barrelLength);
  }

  private pickTarget(targets: readonly BrainTarget[]): void {
    const cur = this.target;
    if (cur && cur.alive && this.inRange(cur)) {
      const still = targets.find((t) => t.id === cur.id);
      if (still) {
        this.target = still;
        return;
      }
    }
    this.target = null;
    let best = Infinity;
    for (const t of targets) {
      if (!t.alive || !this.inRange(t)) continue;
      const d = Math.hypot(t.pos[0] - this.pos[0], t.pos[2] - this.pos[2]);
      if (d < best) {
        best = d;
        this.target = t;
      }
    }
  }

  /** Advances fire control by dt; returns the shots fired this tick (0 or 1). */
  update(dt: number, targets: readonly BrainTarget[]): ShotOut[] {
    const out: ShotOut[] = [];
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (!this.enabled || dt <= 0) return out;

    let wantYaw = this.yaw.angle;
    let wantPitch = this.pitch.angle;
    let ffYaw = 0;
    let ffPitch = 0;
    let aligned = false;
    let targetId: number | null = null;
    let key = -1;

    if (this.manual) {
      this.mode = 'manual';
      this.target = null;
      this.idleFor = 0;
      if (this.manualPoint) {
        const s = this.solve(this.manualPoint, [0, 0, 0]);
        this.solution = s;
        if (s) {
          wantYaw = s.yaw;
          wantPitch = s.pitch;
        } else {
          const o = this.trunnion;
          wantYaw = Math.atan2(-(this.manualPoint[2] - o[2]), this.manualPoint[0] - o[0]);
          wantPitch = ELEVATION.max!;
        }
      }
    } else {
      this.pickTarget(targets);
      const t = this.target;
      if (t) {
        this.mode = 'track';
        this.idleFor = 0;
        targetId = t.id;
        key = t.id;
        this.solution = this.solve(t.pos, this.lead ? t.vel : [0, 0, 0]);
        if (this.solution) {
          wantYaw = this.solution.yaw;
          wantPitch = this.solution.pitch;
          // a solution outside the elevation limits is followed as far as the limit, never fired at
          aligned = this.solution.pitch >= ELEVATION.min! && this.solution.pitch <= ELEVATION.max!;
        }
      } else {
        this.solution = null;
        this.idleFor += dt;
        if (this.idleFor >= IDLE_DELAY) {
          if (this.mode !== 'scan') {
            this.mode = 'scan';
            this.scanHome = this.yaw.angle;
            this.scanPhase = 0;
          }
          this.scanPhase += SCAN_OMEGA * dt;
          wantYaw = wrapPi(this.scanHome + SCAN_AMPLITUDE * Math.sin(this.scanPhase));
          wantPitch = SCAN_PITCH;
          ffYaw = SCAN_AMPLITUDE * SCAN_OMEGA * Math.cos(this.scanPhase);
          key = -2;
        } else this.mode = 'idle';
      }
    }

    // feed-forward from the change in the wanted angles while following the same thing
    if (key >= 0 && this.prevWant && this.prevWant.id === key) {
      ffYaw = wrapPi(wantYaw - this.prevWant.yaw) / dt;
      ffPitch = (wantPitch - this.prevWant.pitch) / dt;
    }
    this.prevWant = { id: key, yaw: wantYaw, pitch: wantPitch };
    this.wantYaw = wantYaw;
    this.wantPitch = wantPitch;

    stepAxis(this.yaw, wantYaw, ffYaw, dt, TRAVERSE);
    stepAxis(this.pitch, wantPitch, ffPitch, dt, ELEVATION);

    const ready = this.cooldown <= 0;
    let fire = false;
    if (this.manual) fire = ready && (this.trigger || this.fireOnce);
    else if (this.fireOnce) fire = ready;
    else if (aligned && ready) {
      fire = Math.abs(axisError(this.yaw, wantYaw, TRAVERSE)) < FIRE_TOLERANCE && Math.abs(axisError(this.pitch, wantPitch, ELEVATION)) < FIRE_TOLERANCE;
    }
    if (fire) {
      this.fireOnce = false;
      this.cooldown = this.spec.interval;
      this.shots++;
      const d = barrelDir(this.yaw.angle, this.pitch.angle);
      const s = this.spec.speed;
      out.push({ from: this.muzzle(), vel: [d[0] * s, d[1] * s, d[2] * s], targetId, time: this.solution?.time ?? 0 });
    }
    return out;
  }
}
