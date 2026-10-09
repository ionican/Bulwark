// Keeps the last two snapshots and produces interpolated positions for mobiles.
// Rendering runs one tick behind the simulation: at time `now` it shows prev -> curr at
// alpha = (now - arrival of curr) / tick length.
//
// W25c (review finding 4): discontinuities are found here, between the two snapshots, before any
// interpolation. A unit or alien is not interpolated, and is drawn at its new position from the
// first frame, when
//   - its id is new in its slot (or it was not in the previous snapshot);
//   - it moved more than RESET_JUMP (2 tiles) since the previous snapshot, or more than 1.5 × the
//     furthest it can walk in the ticks between them when that is further (`maxStepPerTick`: sandbox
//     speed tuning up to 10× and several ticks per snapshot at game speed 3×);
//   - the tick went backwards (rewind, load) or the world was replaced (`push`'s `world`, the
//     worker's counter of loads and rewinds): every row, projectiles included.
// Such a row's `cut` holds the number of the snapshot that cut it (0 = none), and walk.ts Tracks
// resets the entity's gait and rig once for it. Interpolated per-frame displacement used to be the
// only test, so a 5-tile teleport became small steps and the legs walked it.

import { TICK_SECONDS } from '../sim/kinds.ts';
import { slotOf } from '../sim/table.ts';
import type { Snapshot } from '../sim/snapshot.ts';
import { RESET_JUMP } from './walk.ts';

export interface MobileView {
  count: number;
  id: Uint32Array;
  kind: Uint8Array;
  x: Float32Array;
  z: Float32Array;
  /** Interpolated facing (unit vector). */
  fx: Float32Array;
  fz: Float32Array;
  /** W25c: per row, the number of the snapshot whose arrival cut the row (not interpolated; header), or 0. */
  cut?: Uint32Array;
}

export interface InterpOptions {
  /** The furthest a unit or alien of `kind` can walk in one tick in snapshot `s` (tiles; header). */
  maxStepPerTick?: (group: 'units' | 'aliens', kind: number, s: Snapshot) => number;
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
    cut: new Uint32Array(cap),
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
  /** Snapshots pushed so far (the `cut` numbers), the world counter of the last push, and whether it replaced the world. */
  private serial = 0;
  private world = 0;
  private replaced = true;

  /** `capacity`: the simulation's table capacities (sim/world.ts CAPACITY; W24 run 2a passes them in). */
  constructor(
    capacity: { aliens: number; units: number; projectiles: number },
    private readonly opts: InterpOptions = {},
  ) {
    this.aliens = mobileView(capacity.aliens);
    this.units = mobileView(capacity.units);
    this.projectiles = mobileView(capacity.projectiles);
    this.prevRowAliens = new Int32Array(capacity.aliens);
    this.prevRowUnits = new Int32Array(capacity.units);
    this.prevRowProjectiles = new Int32Array(capacity.projectiles);
  }

  /**
   * Adds a snapshot; returns the snapshot that dropped out (its buffer can be recycled). `world`:
   * the worker's counter of world replacements (loads, rewinds); a change cuts every row (header).
   */
  push(snap: Snapshot, now: number, world = this.world): Snapshot | null {
    const dropped = this.prev;
    this.prev = this.curr;
    this.curr = snap;
    this.currAt = now;
    this.serial++;
    this.replaced = !this.prev || world !== this.world || snap.tick < this.prev.tick;
    this.world = world;
    if (this.prev) {
      this.index(this.prev.aliens, this.prevRowAliens);
      this.index(this.prev.units, this.prevRowUnits);
      this.index(this.prev.projectiles, this.prevRowProjectiles);
    }
    this.cuts('aliens', snap.aliens, this.prev?.aliens ?? null, this.prevRowAliens, this.aliens.cut!);
    this.cuts('units', snap.units, this.prev?.units ?? null, this.prevRowUnits, this.units.cut!);
    this.projectiles.cut!.fill(this.replaced ? this.serial : 0, 0, snap.projectiles.count);
    // Re-point the views at the new snapshot now: the dropped one's buffer is about to be
    // transferred back to the worker, and a view left on it would read a detached buffer.
    this.update(now);
    return dropped;
  }

  /** Marks the rows of `cur` that are not interpolated from `prev` (header). */
  private cuts(group: 'units' | 'aliens', cur: MobileSection, prev: MobileSection | null, prevRows: Int32Array, out: Uint32Array) {
    const ticks = prev && this.curr && this.prev ? Math.max(1, this.curr.tick - this.prev.tick) : 1;
    const step = this.opts.maxStepPerTick;
    for (let r = 0; r < cur.count; r++) {
      let cut = this.replaced || !prev;
      if (!cut) {
        const pr = prevRows[slotOf(cur.id[r]!)]!;
        if (pr < 0 || prev!.id[pr] !== cur.id[r]) cut = true;
        else {
          const d = Math.hypot(cur.cols.x[r]! - prev!.cols.x[pr]!, cur.cols.z[r]! - prev!.cols.z[pr]!);
          const limit = step ? Math.max(RESET_JUMP, 1.5 * ticks * step(group, cur.cols.kind[r]!, this.curr!)) : RESET_JUMP;
          cut = d > limit;
        }
      }
      out[r] = cut ? this.serial : 0;
    }
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
      if (prev && !out.cut![r]) {
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
