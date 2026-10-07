// Barrel recoil cycle for the W20 bench. Pure (no three.js), unit-tested in look/test/.
//
// On each shot the barrel is driven back `travel` tiles in `kickTime` (ease-out, the recoil
// buffer absorbing the shot), holds for `holdTime`, then the recuperator returns it to battery in
// `returnTime` (ease-in-out). A shot fired before the cycle ends restarts it from the current
// offset, so the barrel never jumps. The breech ejects its casing when the return starts.

export interface RecoilSpec {
  /** Rearward travel, tiles. */
  travel: number;
  kickTime: number;
  holdTime: number;
  returnTime: number;
}

/** 0.16 tiles (32 cm) in 0.05 s, 0.04 s hold, 0.42 s return. */
export const RECOIL: RecoilSpec = { travel: 0.16, kickTime: 0.05, holdTime: 0.04, returnTime: 0.42 };

export class Recoil {
  readonly spec: RecoilSpec;
  /** Time since the last shot, s (Infinity = at rest). */
  t = Infinity;
  /** Current rearward offset, tiles (0 = in battery). */
  offset = 0;
  private from = 0;
  private ejected = true;

  constructor(spec: RecoilSpec = RECOIL) {
    this.spec = spec;
  }

  fire(): void {
    this.from = this.offset;
    this.t = 0;
    this.ejected = false;
  }

  /** Advances the cycle; returns true on the tick the casing should be ejected. */
  update(dt: number): boolean {
    const s = this.spec;
    if (!Number.isFinite(this.t)) {
      this.offset = 0;
      return false;
    }
    this.t += dt;
    const t = this.t;
    let eject = false;
    if (t < s.kickTime) {
      const u = t / s.kickTime;
      const e = 1 - (1 - u) * (1 - u);
      this.offset = this.from + (s.travel - this.from) * e;
    } else if (t < s.kickTime + s.holdTime) {
      this.offset = s.travel;
    } else if (t < s.kickTime + s.holdTime + s.returnTime) {
      if (!this.ejected) {
        this.ejected = true;
        eject = true;
      }
      const u = (t - s.kickTime - s.holdTime) / s.returnTime;
      this.offset = s.travel * (1 - u * u * (3 - 2 * u));
    } else {
      if (!this.ejected) {
        this.ejected = true;
        eject = true;
      }
      this.offset = 0;
      this.t = Infinity;
    }
    return eject;
  }

  get atRest(): boolean {
    return this.offset === 0 && !Number.isFinite(this.t);
  }

  /** 0..1 heat glow / slit pulse, peaking at the shot and fading over 0.35 s. */
  get pulse(): number {
    return Number.isFinite(this.t) ? Math.max(0, 1 - this.t / 0.35) : 0;
  }
}
