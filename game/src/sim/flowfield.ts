// Flow fields (one per alien target category). A Dijkstra flood from the goal cells gives every
// cell its cost-to-goal and the direction of its next step. Player buildings are passable at an
// extra cost that rises with their hit points, so the cheapest route goes round a wall when the
// detour is shorter than breaking through, and through the weakest wall otherwise.
// Integer costs, a deterministic heap order (cell index breaks ties), no floating-point drift.
//
// W24 costs (built in world.ts rebuildGrids): a reserved construction site costs nothing extra (it
// is not there yet for aliens); a started site costs as a building at its current hit points.
// A gate is one entity spread over 3 × depth tiles: each of its tiles costs as a building with the
// gate's hit points ÷ depth, so a route crossing all `depth` rows pays for breaking the gate once,
// not once per row. Gate tiles are never `open`, so no diagonal step cuts past a gate's corner.

import { DIR_NONE, DX, DZ, stepCost } from './grid.ts';

export const UNREACHED = 0x3fffffff;

export class FlowField {
  readonly w: number;
  readonly h: number;
  readonly dist: Int32Array;
  readonly dir: Int8Array;
  // Dial's bucket queue: circular buckets indexed by distance, entries in a node pool.
  private bucketHead: Int32Array;
  private poolCell: Int32Array;
  private poolNext: Int32Array;
  /** Tick of the last rebuild (for diagnostics). */
  builtAt = -1;
  goalCount = 0;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.dist = new Int32Array(w * h);
    this.dir = new Int8Array(w * h);
    this.bucketHead = new Int32Array(1024);
    this.poolCell = new Int32Array(w * h * 4);
    this.poolNext = new Int32Array(w * h * 4);
  }

  /**
   * @param cost  entering cost per cell (10 = open ground, more for buildings), -1 = impassable
   * @param open  1 where a diagonal may pass the corner (no rock, no solid building)
   * @param goals goal cells; they cost nothing to enter
   */
  build(cost: Int32Array, open: Uint8Array, goals: ArrayLike<number>, goalCount: number): void {
    const { w, h, dist, dir } = this;
    dist.fill(UNREACHED);
    dir.fill(DIR_NONE);
    this.goalCount = goalCount;
    // Bucket count must exceed the largest single step cost.
    let maxCost = 14;
    for (let i = 0; i < cost.length; i++) if (cost[i]! > maxCost) maxCost = cost[i]!;
    const need = stepCost(maxCost, 1) + 2;
    if (this.bucketHead.length < need) this.bucketHead = new Int32Array(1 << Math.ceil(Math.log2(need)));
    const B = this.bucketHead.length;
    const mask = B - 1;
    const head = this.bucketHead;
    head.fill(-1);
    let poolCell = this.poolCell;
    let poolNext = this.poolNext;
    let used = 0;
    let queued = 0;
    const push = (d: number, c: number) => {
      if (used === poolCell.length) {
        const pc = new Int32Array(poolCell.length * 2);
        pc.set(poolCell);
        const pn = new Int32Array(poolNext.length * 2);
        pn.set(poolNext);
        this.poolCell = poolCell = pc;
        this.poolNext = poolNext = pn;
      }
      const b = d & mask;
      poolCell[used] = c;
      poolNext[used] = head[b]!;
      head[b] = used++;
      queued++;
    };
    for (let i = 0; i < goalCount; i++) {
      const c = goals[i]!;
      if (dist[c] === 0) continue;
      dist[c] = 0;
      push(0, c);
    }
    let cur = 0;
    while (queued > 0) {
      const e = head[cur & mask]!;
      if (e < 0) {
        cur++;
        continue;
      }
      head[cur & mask] = poolNext[e]!;
      queued--;
      const c = poolCell[e]!;
      if (dist[c] !== cur) continue; // stale entry
      const cx = c % w;
      const cz = (c - cx) / w;
      // Entering c from a neighbour costs c's own cost, except that reaching a goal costs one step.
      const enter = cur === 0 ? 10 : cost[c]!;
      for (let d = 0; d < 8; d++) {
        const nx = cx - DX[d]!;
        const nz = cz - DZ[d]!;
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const n = nz * w + nx;
        if (cost[n]! < 0) continue;
        if (d & 1 && (open[nz * w + cx] !== 1 || open[cz * w + nx] !== 1)) continue; // corner rule
        const nd = cur + (d & 1 ? ((enter * 14 + 5) / 10) | 0 : enter);
        if (nd < dist[n]!) {
          dist[n] = nd;
          dir[n] = d; // from n, step in direction d to reach c
          if (used === poolCell.length) {
            push(nd, n);
            poolCell = this.poolCell;
            poolNext = this.poolNext;
          } else {
            const b = nd & mask;
            poolCell[used] = n;
            poolNext[used] = head[b]!;
            head[b] = used++;
            queued++;
          }
        }
      }
    }
  }

  /** Next cell from `cell`, or -1 at a goal or where no route exists. */
  next(cell: number): number {
    const d = this.dir[cell]!;
    if (d < 0) return -1;
    return cell + DX[d]! + DZ[d]! * this.w;
  }

  /** Follows the field from `cell` until a goal or `maxSteps`; returns the visited cells including the start. */
  trace(cell: number, maxSteps = 1024): number[] {
    const out = [cell];
    let c = cell;
    for (let i = 0; i < maxSteps; i++) {
      const n = this.next(c);
      if (n < 0) break;
      out.push(n);
      c = n;
    }
    return out;
  }
}
