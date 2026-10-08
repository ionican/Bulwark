// Keeps the last two snapshots and produces interpolated positions for mobiles.
// Rendering runs one tick behind the simulation: at time `now` it shows prev -> curr at
// alpha = (now - arrival of curr) / tick length.

import { TICK_SECONDS } from '../sim/kinds.ts';
import { slotOf } from '../sim/table.ts';
import type { Snapshot } from '../sim/snapshot.ts';

export interface MobileView {
  count: number;
  id: Uint32Array;
  kind: Uint8Array;
  x: Float32Array;
  z: Float32Array;
  /** Interpolated facing (unit vector). */
  fx: Float32Array;
  fz: Float32Array;
}

function mobileView(cap: number): MobileView {
  return {
    count: 0,
    id: new Uint32Array(0),
    kind: new Uint8Array(0),
    x: new Float32Array(cap),
    z: new Float32Array(cap),
    fx: new Float32Array(cap),
    fz: new Float32Array(cap),
  };
}

type MobileSection = Snapshot['aliens'] | Snapshot['units'] | Snapshot['projectiles'];

export class Interpolator {
  prev: Snapshot | null = null;
  curr: Snapshot | null = null;
  private currAt = 0;
  readonly aliens: MobileView;
  readonly units: MobileView;
  readonly projectiles: MobileView;
  private readonly prevRowAliens: Int32Array;
  private readonly prevRowUnits: Int32Array;
  private readonly prevRowProjectiles: Int32Array;

  /** `capacity`: the simulation's table capacities (sim/world.ts CAPACITY; W24 run 2a passes them in). */
  constructor(capacity: { aliens: number; units: number; projectiles: number }) {
    this.aliens = mobileView(capacity.aliens);
    this.units = mobileView(capacity.units);
    this.projectiles = mobileView(capacity.projectiles);
    this.prevRowAliens = new Int32Array(capacity.aliens);
    this.prevRowUnits = new Int32Array(capacity.units);
    this.prevRowProjectiles = new Int32Array(capacity.projectiles);
  }

  /** Adds a snapshot; returns the snapshot that dropped out (its buffer can be recycled). */
  push(snap: Snapshot, now: number): Snapshot | null {
    const dropped = this.prev;
    this.prev = this.curr;
    this.curr = snap;
    this.currAt = now;
    if (this.prev) {
      this.index(this.prev.aliens, this.prevRowAliens);
      this.index(this.prev.units, this.prevRowUnits);
      this.index(this.prev.projectiles, this.prevRowProjectiles);
    }
    // Re-point the views at the new snapshot now: the dropped one's buffer is about to be
    // transferred back to the worker, and a view left on it would read a detached buffer.
    this.update(now);
    return dropped;
  }

  private index(sec: MobileSection, rows: Int32Array) {
    rows.fill(-1);
    for (let r = 0; r < sec.count; r++) rows[slotOf(sec.id[r]!)] = r;
  }

  alpha(now: number): number {
    const a = (now - this.currAt) / (TICK_SECONDS * 1000);
    return a < 0 ? 0 : a > 1 ? 1 : a;
  }

  update(now: number): void {
    if (!this.curr) return;
    const a = this.alpha(now);
    this.fill(this.curr.aliens, this.prev?.aliens ?? null, this.prevRowAliens, this.aliens, a);
    this.fill(this.curr.units, this.prev?.units ?? null, this.prevRowUnits, this.units, a);
    this.fill(this.curr.projectiles, this.prev?.projectiles ?? null, this.prevRowProjectiles, this.projectiles, a);
  }

  private fill(cur: MobileSection, prev: MobileSection | null, prevRows: Int32Array, out: MobileView, a: number) {
    out.count = cur.count;
    out.id = cur.id;
    out.kind = cur.cols.kind;
    const c = cur.cols;
    for (let r = 0; r < cur.count; r++) {
      let x = c.x[r]!;
      let z = c.z[r]!;
      let fx = c.fx[r]!;
      let fz = c.fz[r]!;
      if (prev) {
        const pr = prevRows[slotOf(cur.id[r]!)]!;
        if (pr >= 0 && prev.id[pr] === cur.id[r]) {
          const p = prev.cols;
          x = p.x[pr]! + (x - p.x[pr]!) * a;
          z = p.z[pr]! + (z - p.z[pr]!) * a;
          const ix = p.fx[pr]! + (fx - p.fx[pr]!) * a;
          const iz = p.fz[pr]! + (fz - p.fz[pr]!) * a;
          const l = Math.hypot(ix, iz);
          if (l > 1e-3) {
            fx = ix / l;
            fz = iz / l;
          }
        }
      }
      out.x[r] = x;
      out.z[r] = z;
      out.fx[r] = fx;
      out.fz[r] = fz;
    }
  }
}
