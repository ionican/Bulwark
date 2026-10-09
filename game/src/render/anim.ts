// What drives each animation (W24 run 2b, PLAN "Animation input matrix"). This module is the only
// place that decides it: every input comes from the snapshot, the interpolator (interpolated
// positions), or the effect clock below. models.ts and effects.ts ask here and only draw.
//
//   Animation              Kinds                       Driven by                                      Off when
//   build beam             commander, engineer         state US_BUILDING, work − 1 = a building id    any other state, or the id is absent
//                                                      present in the snapshot
//   reclaim beam           commander, engineer         state US_RECLAIMING, work − 1 = a wreck id     as above
//                          (wreck → emitter, its own pulse shape)
//   carry pod on the back  engineer                    carry > 0, sized by load                       carry 0
//   extractor running      massExtractor, rare…        BF_COMPLETE (income extractors never get       not complete
//                                                      BF_ACTIVE)
//   generator running      generator                   BF_COMPLETE (never gets BF_ACTIVE)             not complete
//   machine working        smelter, assembler,         BF_ACTIVE and not BF_STARVED, motion rate      work not advancing, or starved
//                          shredder                    from `work` advancing between snapshots
//                                                      (BF_ACTIVE alone stays set with no energy)
//   gate doors             gate                        a player unit (interpolated) within 2 tiles    none in range: the doors drive shut;
//                                                      of the gate's tiles; W23's travel time         aliens never open them
//   turret yaw and pitch   gun, area, heavy, temp…,    target − 1 = an alien present: aim at its      no target: hold the aim 1 s, then
//                          beam                        interpolated position; pitch = the flat line   ease back to rest over 2 s
//                                                      from the trunnion to its aim height (the game's
//                                                      projectiles fly flat: no ballistic arc)
//   recoil + muzzle flash  gun, area, heavy, temp…     BF_FIRING in a snapshot whose tick is newer    —
//                                                      than the last one this turret flashed for
//   beam turret's beam     beam                        BF_FIRING and a present target, every frame    flag clear
//   shots                  P_BULLET, P_SHELL, P_HEAVY, every observed projectile row, interpolated;   the row is gone: an impact at its
//                          P_ALIEN                     first point the shooter's muzzle if present    last position
//
// Best effort, at every speed (PLAN, Codex 2b-2): a turret fires before projectiles move, so a close
// shot can be created and removed inside one tick and never appear in any snapshot; above 1× one
// snapshot covers several ticks. So every projectile row that appears in a snapshot is drawn, and a
// turret flashes at most once per snapshot — some shots, impacts and flashes are never seen.
//
// Effect clock (EffectClock): not derived from the interpolator's snapshot pair (whose alpha spans
// 100 ms at every speed). Each frame it advances by the real frame time × the runner's speed, by 0
// while paused, at most 100 ms; a world reset restarts it with a zero delta. Pause freezes every
// animation; 2×/3×/10× speed them up. The strategic-zoom icons do not animate.
//
// Resets (EffectClock, the one detector; Animator.begin reads `time.reset`): the global signal is the
// worker's world epoch (RunnerInfo.world: loads, rewinds, world replacement) or the snapshot tick
// going backwards — never the interpolator's per-row cuts. On a reset every effect state is dropped: recoil 0, doors snapped to what the
// snapshot implies, aim snapped to the current target (or rest), particles and tracers cleared,
// and each turret's last-flashed tick seeded to the restored tick, so a restored BF_FIRING is not
// replayed as a new shot. A new id in a building slot drops that slot's state. Pause resets nothing.

import { ALIEN_KINDS, B, CARRY_CAPACITY, U, alienInfo } from '../sim/kinds.ts';
import { BF_ACTIVE, BF_COMPLETE, BF_FIRING, BF_STARVED, US_BUILDING, US_RECLAIMING } from '../sim/schema.ts';
import { wrapPi } from './walk.ts';
import { smoothstep } from './workshop/noise.ts';

/** Gate doors open for a player unit this close to any of the gate's tiles (tiles). */
export const GATE_RANGE = 2;
/** W23 door drive (look/src/w23/walls/gate.ts): full travel time, and the hold after the last unit leaves. */
export const DOOR_TIME = 1.1;
export const DOOR_HOLD = 0.4;
/** Turret aim without a target: held this long, then eased back to rest over AIM_EASE (seconds). */
export const AIM_HOLD = 1;
export const AIM_EASE = 2;
/** Rest aim: north (where the waves come from), level. */
export const REST_YAW = Math.PI / 2;
/** Pitch limits of the kit's cradles (radians). */
export const PITCH_MIN = -0.35;
export const PITCH_MAX = 1.1;
/** Muzzle flash life, seconds of effect clock (W21's muzzle flash is 0.06 s; a little longer reads at the game camera). */
export const FLASH_LIFE = 0.08;
/** Largest effect-clock step per frame (seconds). */
export const MAX_STEP = 0.1;
/** Aliens are drawn this many times their simulation size (models.ts). */
export const ALIEN_SCALE = 1.5;
/** Turrets aim at this height above the ground: the drawn body's centre. */
export const ALIEN_AIM_HEIGHT: readonly number[] = ALIEN_KINDS.map((_, k) => alienInfo(k).radius * ALIEN_SCALE);

/**
 * W20's barrel recoil cycle (look/src/bench/recoil.ts RECOIL, pure): 0.16 tiles back in 0.05 s, held
 * 0.04 s, returned in 0.4 s. The kit scales the travel per kind (KindFrame.recoilScale).
 */
export const RECOIL = { travel: 0.16, kickTime: 0.05, holdTime: 0.04, returnTime: 0.4 } as const;

/** Barrel offset (tiles, rearwards) `age` seconds after a shot (W20's cycle from rest). */
export function recoilOffset(age: number): number {
  const s = RECOIL;
  if (!(age >= 0) || !Number.isFinite(age)) return 0;
  if (age < s.kickTime) {
    const u = age / s.kickTime;
    return s.travel * (1 - (1 - u) * (1 - u));
  }
  if (age < s.kickTime + s.holdTime) return s.travel;
  if (age < s.kickTime + s.holdTime + s.returnTime) {
    const u = (age - s.kickTime - s.holdTime) / s.returnTime;
    return s.travel * (1 - u * u * (3 - 2 * u));
  }
  return 0;
}

/** Pitch of the straight line from a pivot to a point (dx, dy, dz) away: the game's flat projectiles. */
export function flatPitch(dx: number, dy: number, dz: number): number {
  return Math.atan2(dy, Math.hypot(dx, dz));
}

// ---- inputs: one function per row of the matrix ------------------------------------------------

/**
 * Build or reclaim beam of a unit: false when off; else true, with which and the target id written
 * to `out`. Presence of the target is checked by the caller's lookup.
 */
export function beamOf(state: number, work: number, out: { reclaim: boolean; id: number }): boolean {
  if (work <= 0 || (state !== US_BUILDING && state !== US_RECLAIMING)) return false;
  out.reclaim = state === US_RECLAIMING;
  out.id = work - 1;
  return true;
}

/** Carry pod load 0..1 of a unit (0: no pod). Engineers only. */
export function carryLoad(kind: number, carry: number): number {
  if (kind !== U.engineer || !(carry > 0)) return 0;
  return Math.min(1, carry / CARRY_CAPACITY);
}

/** Extractors and the generator run when complete (they never get BF_ACTIVE). */
export const runsWhenComplete = (kind: number): boolean => kind === B.massExtractor || kind === B.rareExtractor || kind === B.generator;
/** Machines that work only while active, supplied and making progress. */
export const isMachine = (kind: number): boolean => kind === B.smelter || kind === B.assembler || kind === B.shredder;
/** Turret kinds that recoil and flash (the beam turret draws its beam instead). */
export const recoils = (kind: number): boolean => kind === B.gun || kind === B.area || kind === B.heavy || kind === B.tempTurret;
export const isTurret = (kind: number): boolean => recoils(kind) || kind === B.beam;

/**
 * Whether a player unit in `units` (interpolated positions) is within GATE_RANGE of a gate's tiles
 * [tx, tx + fw) × [ty, ty + fh). Aliens are not passed in: they never open gates.
 */
export function gateWanted(units: { count: number; x: ArrayLike<number>; z: ArrayLike<number> }, tx: number, ty: number, fw: number, fh: number): boolean {
  const x1 = tx + fw;
  const z1 = ty + fh;
  const r2 = GATE_RANGE * GATE_RANGE;
  for (let r = 0; r < units.count; r++) {
    const x = units.x[r]!;
    const z = units.z[r]!;
    if (x < tx - GATE_RANGE || x > x1 + GATE_RANGE || z < ty - GATE_RANGE || z > z1 + GATE_RANGE) continue;
    const dx = x < tx ? tx - x : x > x1 ? x - x1 : 0;
    const dz = z < ty ? ty - z : z > z1 ? z - z1 : 0;
    if (dx * dx + dz * dz <= r2) return true;
  }
  return false;
}

// ---- the effect clock and the reset signal ------------------------------------------------------

/** Detects a global reset: the world epoch changed, or the tick went backwards. The first call is not a reset. */
export class ResetWatch {
  private tick = -1;
  private world: number | null = null;

  check(tick: number, world: number): boolean {
    const reset = this.world !== null && (world !== this.world || tick < this.tick);
    this.tick = tick;
    this.world = world;
    return reset;
  }
}

export interface EffectTime {
  /** Seconds of effect clock since the start. */
  t: number;
  /** This frame's advance (0 while paused and on a reset). */
  dt: number;
  /** This frame is a global reset (a new world epoch, or the tick went backwards). */
  reset: boolean;
}

export class EffectClock implements EffectTime {
  t = 0;
  dt = 0;
  reset = false;
  private readonly watch = new ResetWatch();

  /**
   * Advances by `frameSeconds` (real time since the last frame) × `speed`; by 0 when paused; at most
   * MAX_STEP. `tick` and `world` are the current snapshot's tick and the worker's world epoch.
   */
  advance(frameSeconds: number, speed: number, paused: boolean, tick: number, world: number): this {
    this.reset = this.watch.check(tick, world);
    const step = frameSeconds * speed;
    this.dt = this.reset || paused || !(step > 0) ? 0 : Math.min(MAX_STEP, step);
    this.t += this.dt;
    return this;
  }
}

// ---- per-slot effect state -------------------------------------------------------------------

const NONE = 0xffffffff;

/**
 * Effect state per building slot, advanced once per frame by the effect clock. models.ts calls
 * `begin` once per frame, then `building` for every building row before asking for that row's
 * door, aim, recoil, machine phase or extractor time.
 */
export class Animator {
  t = 0;
  dt = 0;
  /** The current frame is a global reset. */
  reset = false;
  tick = 0;
  private readonly id: Uint32Array;
  readonly door: Float32Array;
  private readonly doorClear: Float32Array;
  /** Seconds since the last shot (Infinity: at rest). */
  private readonly recoilAge: Float64Array;
  private readonly flashTick: Float64Array;
  readonly yaw: Float32Array;
  readonly pitch: Float32Array;
  private readonly heldYaw: Float32Array;
  private readonly heldPitch: Float32Array;
  private readonly lostFor: Float32Array;
  /** Running time of extractors, the generator and machines (seconds of motion). */
  private readonly run: Float64Array;
  private readonly workPrev: Float32Array;
  private readonly workTick: Float64Array;
  /** Work progress per tick last measured (machines). */
  private readonly rate: Float32Array;
  /** The slot last passed to `motion` is in motion this frame. */
  working = false;
  /** Fresh this frame (a new id in the slot, or a reset): its state was just dropped. */
  private fresh = false;

  constructor(capacity: number) {
    this.id = new Uint32Array(capacity).fill(NONE);
    this.door = new Float32Array(capacity);
    this.doorClear = new Float32Array(capacity);
    this.recoilAge = new Float64Array(capacity).fill(Infinity);
    this.flashTick = new Float64Array(capacity).fill(-1);
    this.yaw = new Float32Array(capacity).fill(REST_YAW);
    this.pitch = new Float32Array(capacity);
    this.heldYaw = new Float32Array(capacity).fill(REST_YAW);
    this.heldPitch = new Float32Array(capacity);
    this.lostFor = new Float32Array(capacity).fill(1e9);
    this.run = new Float64Array(capacity);
    this.workPrev = new Float32Array(capacity);
    this.workTick = new Float64Array(capacity).fill(-1);
    this.rate = new Float32Array(capacity);
  }

  private first = true;

  /**
   * Once per frame: the snapshot tick and the effect clock. Returns true on a global reset (the
   * clock's `reset`). The renderer's first frame counts as one (a loaded game shows its doors and
   * aims as the snapshot implies, and a BF_FIRING in it is not a new shot).
   */
  begin(tick: number, time: EffectTime): boolean {
    this.reset = time.reset || this.first;
    this.first = false;
    this.tick = tick;
    this.t = time.t;
    this.dt = this.reset ? 0 : Math.max(0, time.dt);
    return this.reset;
  }

  /** Building row in slot `s` with id `id` and `work`: drops the slot's state on a new id or a reset. */
  building(s: number, id: number, work: number): void {
    const fresh = this.id[s] !== id;
    this.fresh = fresh || this.reset;
    if (!this.fresh) return;
    this.id[s] = id;
    this.recoilAge[s] = Infinity;
    // a reset seeds the restored tick (a restored BF_FIRING is not a new shot); a new id has not fired
    this.flashTick[s] = this.reset ? this.tick : -1;
    this.lostFor[s] = 1e9;
    this.heldYaw[s] = this.yaw[s] = REST_YAW;
    this.heldPitch[s] = this.pitch[s] = 0;
    this.run[s] = 0;
    this.workPrev[s] = work;
    this.workTick[s] = this.tick;
    this.rate[s] = 0;
    this.doorClear[s] = 1e9;
    if (fresh) this.door[s] = 0;
  }

  /** Gate doors in slot `s`: `want` = a player unit in range. Snapped on a reset; driven otherwise. Returns 0 shut … 1 open. */
  gate(s: number, want: boolean): number {
    if (this.reset) {
      this.door[s] = want ? 1 : 0;
      this.doorClear[s] = want ? 0 : 1e9;
      return this.door[s]!;
    }
    // W23's drive: a short hold after the last unit leaves, so the doors do not twitch at the edge
    this.doorClear[s] = want ? 0 : this.doorClear[s]! + this.dt;
    const open = want || this.doorClear[s]! < DOOR_HOLD;
    const step = this.dt / DOOR_TIME;
    const d = this.door[s]! + (open ? step : -step);
    this.door[s] = d < 0 ? 0 : d > 1 ? 1 : d;
    return this.door[s]!;
  }

  /**
   * Turret aim in slot `s`. With a target (yaw and pitch towards its interpolated position, worked
   * out by the caller with flatPitch), aims at it at once; without one, holds the last aim for
   * AIM_HOLD, then eases back to rest over AIM_EASE. Results in `yaw[s]` and `pitch[s]`.
   */
  aim(s: number, target: boolean, yaw: number, pitch: number): void {
    if (target) {
      const p = pitch < PITCH_MIN ? PITCH_MIN : pitch > PITCH_MAX ? PITCH_MAX : pitch;
      this.yaw[s] = this.heldYaw[s] = yaw;
      this.pitch[s] = this.heldPitch[s] = p;
      this.lostFor[s] = 0;
      return;
    }
    if (this.reset || this.fresh) {
      this.yaw[s] = this.heldYaw[s] = REST_YAW;
      this.pitch[s] = this.heldPitch[s] = 0;
      this.lostFor[s] = 1e9;
      return;
    }
    this.lostFor[s]! += this.dt;
    const u = smoothstep(AIM_HOLD, AIM_HOLD + AIM_EASE, this.lostFor[s]!);
    this.yaw[s] = this.heldYaw[s]! + wrapPi(REST_YAW - this.heldYaw[s]!) * u;
    this.pitch[s] = this.heldPitch[s]! * (1 - u);
  }

  /**
   * Recoil and flash of a recoiling turret in slot `s`: BF_FIRING in a snapshot whose tick is newer
   * than the last one this turret flashed for starts a recoil cycle. Returns true when this frame
   * flashes (at most once per turret per snapshot tick). The barrel offset is `recoil(s)`.
   */
  fire(s: number, flags: number): boolean {
    if (Number.isFinite(this.recoilAge[s]!)) this.recoilAge[s]! += this.dt;
    if (!(flags & BF_FIRING) || this.tick <= this.flashTick[s]!) return false;
    this.flashTick[s] = this.tick;
    this.recoilAge[s] = 0;
    return true;
  }

  /** Barrel offset of slot `s`, tiles rearwards (before the kind's recoil scale). */
  recoil(s: number): number {
    return recoilOffset(this.recoilAge[s]!);
  }

  /**
   * Extractors and the generator (`running` = complete), and machines (`running` = BF_ACTIVE, not
   * BF_STARVED, `work` advancing): seconds of motion so far, advanced by the effect clock × a rate.
   * Machines: the rate follows work progress per tick between snapshots (relative to 1/30 per
   * tick, clamped 0.5–3); the rate is measured when the tick changes, so repeated snapshots of the
   * same tick and batched snapshots (several ticks) both give the right figure. Sets `working`:
   * whether the slot is in motion this frame (a machine working, an extractor or generator running).
   */
  motion(s: number, kind: number, flags: number, work: number): number {
    let speed = 0;
    if (runsWhenComplete(kind)) speed = flags & BF_COMPLETE ? 1 : 0;
    else if (isMachine(kind)) {
      if (this.tick !== this.workTick[s]) {
        const ticks = this.tick - this.workTick[s]!;
        let d = work - this.workPrev[s]!;
        // work wraps to 0 when an item is made: what was left of the last cycle plus the new progress
        if (d < -1e-6) d = 1 - this.workPrev[s]! + work;
        this.rate[s] = ticks > 0 ? Math.max(0, d) / ticks : 0;
        this.workPrev[s] = work;
        this.workTick[s] = this.tick;
      }
      const on = flags & BF_ACTIVE && !(flags & BF_STARVED) && this.rate[s]! > 1e-6;
      speed = on ? Math.min(3, Math.max(0.5, this.rate[s]! * 30)) : 0;
    }
    this.working = speed > 0;
    this.run[s]! += this.dt * speed;
    return this.run[s]!;
  }
}
