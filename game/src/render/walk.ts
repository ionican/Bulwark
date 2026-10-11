// Walking from snapshots (W24 run 2a, Richard's feedback; brought forward from run 2b).
//
// The simulation sends positions only. Per unit and alien slot the renderer keeps the position it
// drew last frame, a heading and (aliens) a gait phase, all derived here:
//   distance  the change of the interpolated position since the last frame; the gait advances by it,
//             so game speed 1–3× scales the gait naturally and a paused game (no movement) freezes it
//   heading   turns towards the direction of movement, smoothed (a share min(1, 10 · dt) of the
//             remaining turn per frame); unchanged while standing
//   phase     aliens: W21's gait phase, advanced by distance × the kind's rate (W21: the rusher's legs
//             5.5 rad per tile); the other kinds' wheels, drill and hover bob are driven by it too
//   seed      from the id (W21 drew it at random; here it is fixed per id)
// Reset (`step` returns reset): a discontinuity the interpolator found between snapshots (W25c,
// interp.ts: a jump of more than 2 tiles, a new id, the tick going backwards, a world replaced on
// load or rewind; that row is not interpolated, so the entity is already at its destination), once
// per snapshot that cut it; and, as before, an id seen for the first time in its slot, a jump of more
// than 2 tiles between frames, or every slot when the snapshot tick goes backwards. A reset places
// the entity afresh: the rigs plant both feet under it, the phase goes back to the seed's, so no leg
// is stretched and no foot slides.
// The W23 rigs (workshop/w23/rig) keep each unit's legs and planted feet; this module only feeds them.

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Motion } from './workshop/models/types.ts';

/** Gait phase per tile walked, radians, by alien kind (rusher, hunter, breaker, saboteur). */
export const ALIEN_PHASE_PER_TILE = [5.5, 2.5, 3.9, 3.0] as const;
/** A move between two frames longer than this is a jump, not a step. */
export const RESET_JUMP = 2;
const NONE = 0xffffffff;

export const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

export interface Step {
  reset: boolean;
  /** Distance moved since the last frame (0 on a reset). */
  dist: number;
}

export class Tracks {
  readonly id: Uint32Array;
  readonly x: Float32Array;
  readonly z: Float32Array;
  readonly heading: Float32Array;
  readonly phase: Float32Array;
  readonly seed: Float32Array;
  /** The interpolator's cut number last acted on per slot (W25c). */
  private readonly cutSeen: Uint32Array;
  private lastTick = -1;
  private readonly out: Step = { reset: false, dist: 0 };

  constructor(cap: number) {
    this.id = new Uint32Array(cap).fill(NONE);
    this.x = new Float32Array(cap);
    this.z = new Float32Array(cap);
    this.heading = new Float32Array(cap);
    this.phase = new Float32Array(cap);
    this.seed = new Float32Array(cap);
    this.cutSeen = new Uint32Array(cap);
  }

  /** Call once per frame with the snapshot tick: a tick going backwards resets every slot. */
  tick(t: number): void {
    if (t < this.lastTick) this.id.fill(NONE);
    this.lastTick = t;
  }

  /**
   * Advances slot `s` (entity `id`) to (x, z). `facing` is the heading used on a reset (from the
   * snapshot's facing vector); `rate` the phase per tile; `dt` the frame's seconds (0 when paused);
   * `cut` the row's interp.ts cut number (0 = none): a new one resets the slot once.
   */
  step(s: number, id: number, x: number, z: number, facing: number, dt: number, rate = 0, cut = 0): Step {
    const o = this.out;
    const dx = x - this.x[s]!;
    const dz = z - this.z[s]!;
    const dist = Math.hypot(dx, dz);
    const newCut = cut !== 0 && cut !== this.cutSeen[s];
    if (newCut) this.cutSeen[s] = cut;
    if (this.id[s] !== id || dist > RESET_JUMP || newCut) {
      const fresh = this.id[s] !== id;
      this.id[s] = id;
      this.x[s] = x;
      this.z[s] = z;
      this.heading[s] = facing;
      if (fresh) this.seed[s] = ((Math.imul(id + 1, 2654435761) >>> 0) % 10007) / 10007;
      this.phase[s] = this.seed[s]! * Math.PI * 2;
      o.reset = true;
      o.dist = 0;
      return o;
    }
    this.x[s] = x;
    this.z[s] = z;
    if (dist > 1e-5) {
      const target = Math.atan2(-dz, dx);
      this.heading[s] = this.heading[s]! + wrapPi(target - this.heading[s]!) * Math.min(1, dt * 10);
    }
    this.phase[s] = this.phase[s]! + dist * rate;
    o.reset = false;
    o.dist = dist;
    return o;
  }
}

const AX = { x: new Vector3(1, 0, 0), y: new Vector3(0, 1, 0), z: new Vector3(0, 0, 1) };
const _q = new Quaternion();

/**
 * A W17 part's motion at gait phase `phase` (W17's scene/modelLayer.ts motionMatrix, with W21's time
 * terms replaced by the distance-driven phase): gait legs swing and lift with the phase as in W21;
 * spinning parts turn one radian per radian of phase in their own direction; bobbing parts bob once
 * per 2π of phase. Aim, elevation and recoil are run 2b (turrets) and stay at rest.
 */
export function motionAt(motion: Motion, phase: number, seed: number, out: Matrix4): Matrix4 {
  switch (motion.kind) {
    case 'gait': {
      const a = phase + motion.phase;
      out.makeRotationZ(motion.swing * Math.sin(a));
      out.setPosition(0, motion.lift * Math.max(0, Math.cos(a)), 0);
      return out;
    }
    case 'spin':
      return out.makeRotationFromQuaternion(_q.setFromAxisAngle(AX[motion.axis], Math.sign(motion.speed) * phase + seed * 6.283));
    case 'bob':
      return out.makeTranslation(0, motion.amp * Math.sin(phase + seed * 6.283), 0);
    default:
      return out.identity();
  }
}
