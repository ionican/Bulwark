// A* on the tile grid for player units (commander, engineers). Units walk on open ground and on
// belt pieces; rock and solid buildings block them. Octile heuristic, deterministic tie-breaks.

import { MinHeap } from './heap.ts';
import { DX, DZ, cornerOk } from './grid.ts';

export class Pathfinder {
  private readonly w: number;
  private readonly h: number;
  private readonly g: Float64Array;
  private readonly from: Int32Array;
  private readonly seen: Uint32Array;
  private stamp = 0;
  private readonly heap: MinHeap;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.g = new Float64Array(w * h);
    this.from = new Int32Array(w * h);
    this.seen = new Uint32Array(w * h);
    this.heap = new MinHeap(4096);
  }

  /**
   * Path from `start` to the first cell satisfying `isGoal`, heading for (gx, gz).
   * `walk[c]` is 1 where a unit may stand. Returns the cells after the start, or null.
   */
  find(walk: Uint8Array, start: number, gx: number, gz: number, isGoal: (cell: number) => boolean, maxExpand = 20000): number[] | null {
    const { w, h, g, from, seen, heap } = this;
    this.stamp = (this.stamp + 1) >>> 0 || 1;
    const st = this.stamp;
    heap.clear();
    const hfun = (c: number) => {
      const x = c % w;
      const z = (c - x) / w;
      const dx = Math.abs(x + 0.5 - gx);
      const dz = Math.abs(z + 0.5 - gz);
      return dx > dz ? dx + 0.4142 * dz : dz + 0.4142 * dx;
    };
    seen[start] = st;
    g[start] = 0;
    from[start] = -1;
    heap.push(hfun(start) * 1e6 + start, start);
    let expanded = 0;
    let best = -1;
    while (heap.size > 0 && expanded++ < maxExpand) {
      const c = heap.pop();
      if (isGoal(c)) {
        best = c;
        break;
      }
      const cx = c % w;
      const cz = (c - cx) / w;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX[d]!;
        const nz = cz + DZ[d]!;
        if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
        const n = nz * w + nx;
        if (!walk[n] || !cornerOk(walk, w, cx, cz, d)) continue;
        const ng = g[c]! + (d & 1 ? 1.4142 : 1);
        if (seen[n] === st && ng >= g[n]!) continue;
        seen[n] = st;
        g[n] = ng;
        from[n] = c;
        heap.push((ng + hfun(n)) * 1e6 + n, n);
      }
    }
    if (best < 0) return null;
    const path: number[] = [];
    for (let c = best; c !== start; c = from[c]!) path.push(c);
    return path.reverse();
  }
}
