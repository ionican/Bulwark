// W20's fire control (src/bench/brain.ts, recoil.ts) moved into flat typed arrays so hundreds of
// turrets update without one object per turret per frame. Pure: no three.js, no DOM, no random
// numbers, so the unit tests run it beside W20's TurretBrain on the same inputs.
//
// The arithmetic is W20's, step for step: the same target rule (keep the current target while its
// position from the previous update is in range and it is still alive, else take the nearest in
// range, the earlier slot winning a tie, as the earlier list entry does in W20), the same
// ballistic intercept with lead (copied without allocation), stepAxis/axisError/wrapPi from aim.ts
// called on a scratch AxisState, the same scan, the same fire test and the same recoil cycle. Only
// automatic fire is carried over (no manual aim, no construction hold).
//
// Target search uses a uniform grid over the aliens (AlienGrid), rebuilt once per frame, so a
// turret only looks at the cells within its range instead of every alien.

import { ELEVATION, TRAVERSE, axisError, barrelDir, stepAxis, wrapPi, type AxisState } from '../bench/aim.ts';
import { FIRE_TOLERANCE, GUN, IDLE_DELAY, SCAN_AMPLITUDE, SCAN_OMEGA, SCAN_PITCH, type GunSpec } from '../bench/brain.ts';
import { RECOIL, type RecoilSpec } from '../bench/recoil.ts';

/** Alien state as the fire control sees it (structure of arrays, indexed by slot). */
export interface AlienView {
  readonly cap: number;
  readonly id: Int32Array;
  readonly alive: Uint8Array;
  /** Aim point (centre of the alien), tiles. */
  readonly ax: Float64Array;
  readonly ay: Float64Array;
  readonly az: Float64Array;
  /** Velocity, tiles/s. */
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly vz: Float64Array;
  /** Hit radius, tiles. */
  readonly radius: Float64Array;
}

export function alienView(cap: number): AlienView {
  return {
    cap,
    id: new Int32Array(cap),
    alive: new Uint8Array(cap),
    ax: new Float64Array(cap),
    ay: new Float64Array(cap),
    az: new Float64Array(cap),
    vx: new Float64Array(cap),
    vy: new Float64Array(cap),
    vz: new Float64Array(cap),
    radius: new Float64Array(cap),
  };
}

/**
 * Uniform grid of alien slots by aim-point x/z (counting sort, rebuilt per frame). Cells are
 * listed in ascending slot order, so a scan that breaks ties by slot is independent of cell order.
 * Aliens outside the grid are clamped into the edge cells; every query still tests real distances.
 */
export class AlienGrid {
  readonly start: Int32Array;
  readonly items: Int32Array;
  private fill: Int32Array;

  constructor(
    readonly cap: number,
    readonly cell = 8,
    readonly x0 = -320,
    readonly z0 = -320,
    readonly nx = 96,
    readonly nz = 96,
  ) {
    this.start = new Int32Array(nx * nz + 1);
    this.fill = new Int32Array(nx * nz);
    this.items = new Int32Array(cap);
  }

  cx(x: number): number {
    const c = Math.floor((x - this.x0) / this.cell);
    return c < 0 ? 0 : c >= this.nx ? this.nx - 1 : c;
  }

  cz(z: number): number {
    const c = Math.floor((z - this.z0) / this.cell);
    return c < 0 ? 0 : c >= this.nz ? this.nz - 1 : c;
  }

  build(a: AlienView): void {
    const n = this.nx * this.nz;
    const cnt = this.fill;
    cnt.fill(0);
    for (let s = 0; s < a.cap; s++) if (a.alive[s]) cnt[this.cz(a.az[s]!) * this.nx + this.cx(a.ax[s]!)]!++;
    let acc = 0;
    for (let c = 0; c < n; c++) {
      this.start[c] = acc;
      acc += cnt[c]!;
      cnt[c] = this.start[c]!;
    }
    this.start[n] = acc;
    for (let s = 0; s < a.cap; s++) {
      if (!a.alive[s]) continue;
      const c = this.cz(a.az[s]!) * this.nx + this.cx(a.ax[s]!);
      this.items[cnt[c]!++] = s;
    }
  }
}

/** One shot fired this update. */
export interface ShotRecord {
  turret: number;
  from: [number, number, number];
  vel: [number, number, number];
  targetId: number;
  time: number;
}

export const MODE_IDLE = 0;
export const MODE_SCAN = 1;
export const MODE_TRACK = 2;
export const MODE_NAMES = ['idle', 'scan', 'track'] as const;

const _ax: AxisState = { angle: 0, rate: 0 };

/** Every turret's fire control and recoil state, one entry per array index. */
export class TurretBank {
  readonly cap: number;
  n = 0;
  lead = true;
  readonly spec: GunSpec;
  readonly recoilSpec: RecoilSpec;
  // placement
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pz: Float64Array;
  // axes
  readonly yaw: Float64Array;
  readonly yawRate: Float64Array;
  readonly pitch: Float64Array;
  readonly pitchRate: Float64Array;
  // fire control
  readonly mode: Uint8Array;
  readonly cooldown: Float64Array;
  readonly idleFor: Float64Array;
  readonly wantYaw: Float64Array;
  readonly wantPitch: Float64Array;
  readonly scanHome: Float64Array;
  readonly scanPhase: Float64Array;
  /** Key of the previous update's wanted angles: target id, −1 none, −2 scan; NaN = no previous. */
  readonly prevKey: Float64Array;
  readonly prevYaw: Float64Array;
  readonly prevPitch: Float64Array;
  readonly tgtSlot: Int32Array;
  readonly tgtId: Int32Array;
  /** Target position (x, z) at the previous update: W20 tests the range on the previous snapshot. */
  readonly tgtX: Float64Array;
  readonly tgtZ: Float64Array;
  readonly solTime: Float64Array;
  readonly hasSol: Uint8Array;
  readonly shots: Uint32Array;
  // recoil (W20 Recoil)
  readonly rT: Float64Array;
  readonly rOff: Float64Array;
  readonly rFrom: Float64Array;
  readonly rEjected: Uint8Array;

  constructor(cap: number, spec: GunSpec = GUN, recoil: RecoilSpec = RECOIL) {
    this.cap = cap;
    this.spec = spec;
    this.recoilSpec = recoil;
    const f = () => new Float64Array(cap);
    this.px = f();
    this.py = f();
    this.pz = f();
    this.yaw = f();
    this.yawRate = f();
    this.pitch = f();
    this.pitchRate = f();
    this.mode = new Uint8Array(cap);
    this.cooldown = f();
    this.idleFor = f();
    this.wantYaw = f();
    this.wantPitch = f();
    this.scanHome = f();
    this.scanPhase = f();
    this.prevKey = f();
    this.prevYaw = f();
    this.prevPitch = f();
    this.tgtSlot = new Int32Array(cap);
    this.tgtId = new Int32Array(cap);
    this.tgtX = f();
    this.tgtZ = f();
    this.solTime = f();
    this.hasSol = new Uint8Array(cap);
    this.shots = new Uint32Array(cap);
    this.rT = f();
    this.rOff = f();
    this.rFrom = f();
    this.rEjected = new Uint8Array(cap);
  }

  /** Resets turret i at a position with a starting yaw (TurretBrain's constructor state). */
  init(i: number, x: number, y: number, z: number, yaw = 0): void {
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.yaw[i] = yaw;
    this.yawRate[i] = 0;
    this.pitch[i] = 0;
    this.pitchRate[i] = 0;
    this.mode[i] = MODE_IDLE;
    this.cooldown[i] = 0;
    this.idleFor[i] = 0;
    this.wantYaw[i] = 0;
    this.wantPitch[i] = 0;
    this.scanHome[i] = 0;
    this.scanPhase[i] = 0;
    this.prevKey[i] = NaN;
    this.prevYaw[i] = 0;
    this.prevPitch[i] = 0;
    this.tgtSlot[i] = -1;
    this.tgtId[i] = 0;
    this.tgtX[i] = 0;
    this.tgtZ[i] = 0;
    this.solTime[i] = 0;
    this.hasSol[i] = 0;
    this.shots[i] = 0;
    this.rT[i] = Infinity;
    this.rOff[i] = 0;
    this.rFrom[i] = 0;
    this.rEjected[i] = 1;
  }

  private inRangeXZ(i: number, x: number, z: number): boolean {
    return Math.hypot(x - this.px[i]!, z - this.pz[i]!) <= this.spec.range;
  }

  /** W20 pickTarget: keep the current target, else the nearest alive alien in range. */
  private pick(i: number, a: AlienView, grid: AlienGrid | null): void {
    const cur = this.tgtSlot[i]!;
    if (cur >= 0 && this.inRangeXZ(i, this.tgtX[i]!, this.tgtZ[i]!) && a.alive[cur] && a.id[cur] === this.tgtId[i]) {
      this.tgtX[i] = a.ax[cur]!;
      this.tgtZ[i] = a.az[cur]!;
      return;
    }
    this.tgtSlot[i] = -1;
    let best = Infinity;
    let bestSlot = -1;
    const px = this.px[i]!;
    const pz = this.pz[i]!;
    const R = this.spec.range;
    const test = (s: number) => {
      if (!a.alive[s]) return;
      const d = Math.hypot(a.ax[s]! - px, a.az[s]! - pz);
      if (d > R) return;
      if (d < best || (d === best && s < bestSlot)) {
        best = d;
        bestSlot = s;
      }
    };
    if (grid) {
      const x0 = grid.cx(px - R);
      const x1 = grid.cx(px + R);
      const z0 = grid.cz(pz - R);
      const z1 = grid.cz(pz + R);
      for (let cz = z0; cz <= z1; cz++)
        for (let cx = x0; cx <= x1; cx++) {
          const c = cz * grid.nx + cx;
          for (let k = grid.start[c]!; k < grid.start[c + 1]!; k++) test(grid.items[k]!);
        }
    } else for (let s = 0; s < a.cap; s++) test(s);
    if (bestSlot >= 0) {
      this.tgtSlot[i] = bestSlot;
      this.tgtId[i] = a.id[bestSlot]!;
      this.tgtX[i] = a.ax[bestSlot]!;
      this.tgtZ[i] = a.az[bestSlot]!;
    }
  }

  /**
   * solveIntercept (aim.ts) without allocation; same operations in the same order. Writes yaw,
   * pitch and flight time into `out` and returns true, or returns false out of ballistic reach.
   */
  static solve(out: Float64Array, ox: number, oy: number, oz: number, px: number, py: number, pz: number, vx: number, vy: number, vz: number, speed: number, g: number, len: number, iterations = 12): boolean {
    let t = Math.hypot(px - ox, py - oy, pz - oz) / speed;
    let pitch = 0;
    let ax = px;
    let az = pz;
    for (let k = 0; k < iterations; k++) {
      ax = px + vx * t;
      const ay = py + vy * t;
      az = pz + vz * t;
      const dx = ax - ox;
      const dz = az - oz;
      const d = Math.hypot(dx, dz) - len * Math.cos(pitch);
      const dy = ay - oy - len * Math.sin(pitch);
      if (d <= 0.01) return false;
      const s2 = speed * speed;
      const disc = s2 * s2 - g * (g * d * d + 2 * dy * s2);
      if (disc < 0) return false;
      pitch = Math.atan2(s2 - Math.sqrt(disc), g * d);
      t = d / (speed * Math.cos(pitch));
    }
    out[0] = Math.atan2(-(az - oz), ax - ox);
    out[1] = pitch;
    out[2] = t;
    return true;
  }

  private sol = new Float64Array(3);

  /**
   * W20 TurretBrain.update followed by Recoil.update (and Recoil.fire on a shot), as the bench
   * calls them each frame. Returns the shot or null; sets `ejected` when the casing leaves.
   */
  update(i: number, dt: number, a: AlienView, grid: AlienGrid | null, res: { shot: ShotRecord | null; eject: boolean }): void {
    res.shot = null;
    res.eject = false;
    this.cooldown[i] = Math.max(0, this.cooldown[i]! - dt);
    if (dt > 0) res.shot = this.fireControl(i, dt, a, grid);
    res.eject = this.recoilUpdate(i, dt);
    if (res.shot) this.recoilFire(i);
  }

  private fireControl(i: number, dt: number, a: AlienView, grid: AlienGrid | null): ShotRecord | null {
    const spec = this.spec;
    let wantYaw = this.yaw[i]!;
    let wantPitch = this.pitch[i]!;
    let ffYaw = 0;
    let ffPitch = 0;
    let aligned = false;
    let targetId = -1;
    let key = -1;
    this.pick(i, a, grid);
    const t = this.tgtSlot[i]!;
    if (t >= 0) {
      this.mode[i] = MODE_TRACK;
      this.idleFor[i] = 0;
      targetId = key = a.id[t]!;
      const lead = this.lead;
      const ok = TurretBank.solve(this.sol, this.px[i]!, this.py[i]! + spec.trunnionHeight, this.pz[i]!, a.ax[t]!, a.ay[t]!, a.az[t]!, lead ? a.vx[t]! : 0, lead ? a.vy[t]! : 0, lead ? a.vz[t]! : 0, spec.speed, spec.gravity, spec.barrelLength);
      this.hasSol[i] = ok ? 1 : 0;
      if (ok) {
        wantYaw = this.sol[0]!;
        wantPitch = this.sol[1]!;
        this.solTime[i] = this.sol[2]!;
        aligned = wantPitch >= ELEVATION.min! && wantPitch <= ELEVATION.max!;
      }
    } else {
      this.hasSol[i] = 0;
      this.idleFor[i]! += dt;
      if (this.idleFor[i]! >= IDLE_DELAY) {
        if (this.mode[i] !== MODE_SCAN) {
          this.mode[i] = MODE_SCAN;
          this.scanHome[i] = this.yaw[i]!;
          this.scanPhase[i] = 0;
        }
        this.scanPhase[i]! += SCAN_OMEGA * dt;
        const ph = this.scanPhase[i]!;
        wantYaw = wrapPi(this.scanHome[i]! + SCAN_AMPLITUDE * Math.sin(ph));
        wantPitch = SCAN_PITCH;
        ffYaw = SCAN_AMPLITUDE * SCAN_OMEGA * Math.cos(ph);
        key = -2;
      } else this.mode[i] = MODE_IDLE;
    }
    if (key >= 0 && this.prevKey[i] === key) {
      ffYaw = wrapPi(wantYaw - this.prevYaw[i]!) / dt;
      ffPitch = (wantPitch - this.prevPitch[i]!) / dt;
    }
    this.prevKey[i] = key;
    this.prevYaw[i] = wantYaw;
    this.prevPitch[i] = wantPitch;
    this.wantYaw[i] = wantYaw;
    this.wantPitch[i] = wantPitch;

    _ax.angle = this.yaw[i]!;
    _ax.rate = this.yawRate[i]!;
    stepAxis(_ax, wantYaw, ffYaw, dt, TRAVERSE);
    this.yaw[i] = _ax.angle;
    this.yawRate[i] = _ax.rate;
    const yawErr = axisError(_ax, wantYaw, TRAVERSE);
    _ax.angle = this.pitch[i]!;
    _ax.rate = this.pitchRate[i]!;
    stepAxis(_ax, wantPitch, ffPitch, dt, ELEVATION);
    this.pitch[i] = _ax.angle;
    this.pitchRate[i] = _ax.rate;
    const pitchErr = axisError(_ax, wantPitch, ELEVATION);

    const ready = this.cooldown[i]! <= 0;
    if (!(aligned && ready && Math.abs(yawErr) < FIRE_TOLERANCE && Math.abs(pitchErr) < FIRE_TOLERANCE)) return null;
    this.cooldown[i] = spec.interval;
    this.shots[i]!++;
    const d = barrelDir(this.yaw[i]!, this.pitch[i]!);
    const L = spec.barrelLength;
    const ox = this.px[i]!;
    const oy = this.py[i]! + spec.trunnionHeight;
    const oz = this.pz[i]!;
    const s = spec.speed;
    return { turret: i, from: [ox + d[0] * L, oy + d[1] * L, oz + d[2] * L], vel: [d[0] * s, d[1] * s, d[2] * s], targetId, time: this.hasSol[i] ? this.solTime[i]! : 0 };
  }

  private recoilFire(i: number): void {
    this.rFrom[i] = this.rOff[i]!;
    this.rT[i] = 0;
    this.rEjected[i] = 0;
  }

  /** W20 Recoil.update; returns true on the update the casing is ejected. */
  private recoilUpdate(i: number, dt: number): boolean {
    const s = this.recoilSpec;
    if (!Number.isFinite(this.rT[i]!)) {
      this.rOff[i] = 0;
      return false;
    }
    this.rT[i]! += dt;
    const t = this.rT[i]!;
    let eject = false;
    if (t < s.kickTime) {
      const u = t / s.kickTime;
      const e = 1 - (1 - u) * (1 - u);
      this.rOff[i] = this.rFrom[i]! + (s.travel - this.rFrom[i]!) * e;
    } else if (t < s.kickTime + s.holdTime) {
      this.rOff[i] = s.travel;
    } else if (t < s.kickTime + s.holdTime + s.returnTime) {
      if (!this.rEjected[i]) {
        this.rEjected[i] = 1;
        eject = true;
      }
      const u = (t - s.kickTime - s.holdTime) / s.returnTime;
      this.rOff[i] = s.travel * (1 - u * u * (3 - 2 * u));
    } else {
      if (!this.rEjected[i]) {
        this.rEjected[i] = 1;
        eject = true;
      }
      this.rOff[i] = 0;
      this.rT[i] = Infinity;
    }
    return eject;
  }

  /** Slit glow pulse (Recoil.pulse). */
  pulse(i: number): number {
    const t = this.rT[i]!;
    return Number.isFinite(t) ? Math.max(0, 1 - t / 0.35) : 0;
  }
}
