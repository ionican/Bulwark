// W29b: the shape each belt tile is drawn with, from the snapshot alone (kinds, directions and
// neighbours). The simulation does not change: a belt takes from behind and from both sides
// whatever it is drawn as.
//
//   fed from one side only (nothing behind)   corner: the belt sweeps 90° from that side to the front
//   fed from behind and from a side          join: the straight run with the side lane running in
//   fed from both sides, nothing behind      join on both sides
//   otherwise                                straight
//
// "Right" is the right of the flow: direction (d + 1) mod 4, the model's +z side (models.ts turns
// the +x model by BELT_YAW). Splitters and mergers keep their own models. Rows are keyed per tile,
// and the shapes are worked out again only when the key changes (a belt laid, removed, turned).

import { B, BDX as DX, BDZ as DZ, outputDirs } from '../sim/kinds.ts';
import { BF_COMPLETE, BF_STARTED } from '../sim/schema.ts';
import type { Snapshot } from '../sim/snapshot.ts';

export const BELT_STRAIGHT = 0;
export const BELT_CORNER_R = 1;
export const BELT_CORNER_L = 2;
/** Join flags (both may be set). */
export const BELT_JOIN_R = 4;
export const BELT_JOIN_L = 8;

/** The W17 model of each shape (procedural/buildings.ts BELT_SHAPE_MAKERS; 0 is the plain belt). */
export const BELT_SHAPE_MODEL: Readonly<Record<number, string>> = {
  [BELT_STRAIGHT]: 'belt',
  [BELT_CORNER_R]: 'beltCornerR',
  [BELT_CORNER_L]: 'beltCornerL',
  [BELT_JOIN_R]: 'beltJoinR',
  [BELT_JOIN_L]: 'beltJoinL',
  [BELT_JOIN_R | BELT_JOIN_L]: 'beltJoinLR',
};

const KIND_BELT = 1;
const KIND_SPLITTER = 2;
const KIND_MERGER = 3;

export class BeltShapes {
  /** Per tile: 0 none, else kind code | dir << 2. */
  private key: Uint8Array;
  private next: Uint8Array;
  private readonly shape: Uint8Array;
  /** Debug (the W29b negative control): every belt drawn straight. */
  private straight = false;

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.key = new Uint8Array(w * h);
    this.next = new Uint8Array(w * h);
    this.shape = new Uint8Array(w * h);
  }

  /** The shape at tile index z * w + x (BELT_STRAIGHT for anything but a shaped belt). */
  shapeAt(tile: number): number {
    return this.straight ? BELT_STRAIGHT : (this.shape[tile] ?? BELT_STRAIGHT);
  }

  /** Debug: draw every belt straight (true) or by its neighbours (false). */
  forceStraight(on: boolean): void {
    this.straight = on;
  }

  /** Reads the snapshot's belts; works the shapes out again if they changed. True on a rebuild. */
  update(s: Snapshot): boolean {
    const k = this.next;
    k.fill(0);
    const c = s.buildings.cols;
    for (let r = 0; r < s.buildings.count; r++) {
      const kind = c.kind[r]!;
      const code = kind === B.belt ? KIND_BELT : kind === B.splitter ? KIND_SPLITTER : kind === B.merger ? KIND_MERGER : 0;
      // a reserved site has nothing drawn yet (models.ts draws its outline only)
      if (!code || !(c.flags[r]! & (BF_STARTED | BF_COMPLETE))) continue;
      const x = c.tx[r]!;
      const z = c.ty[r]!;
      if (x < 0 || z < 0 || x >= this.w || z >= this.h) continue;
      k[z * this.w + x] = code | ((c.dir[r]! & 3) << 2);
    }
    let same = true;
    for (let i = 0; i < k.length && same; i++) if (k[i] !== this.key[i]) same = false;
    if (same) return false;
    this.next = this.key;
    this.key = k;
    this.rebuild();
    return true;
  }

  /** Does the piece at (x, z) put items into its neighbour in direction `toward` (from the piece)? */
  private feeds(x: number, z: number, toward: number): boolean {
    if (x < 0 || z < 0 || x >= this.w || z >= this.h) return false;
    const k = this.key[z * this.w + x]!;
    if (!k) return false;
    const kind = (k & 3) === KIND_SPLITTER ? B.splitter : (k & 3) === KIND_MERGER ? B.merger : B.belt;
    return outputDirs(kind, k >> 2).includes(toward);
  }

  private rebuild(): void {
    const W = this.w;
    this.shape.fill(BELT_STRAIGHT);
    for (let i = 0; i < this.key.length; i++) {
      const k = this.key[i]!;
      if ((k & 3) !== KIND_BELT) continue;
      const d = k >> 2;
      const x = i % W;
      const z = (i - x) / W;
      /** The neighbour on side `s` of this tile feeds it. */
      const from = (s: number) => this.feeds(x + DX[s]!, z + DZ[s]!, (s + 2) % 4);
      const back = from((d + 2) % 4);
      const right = from((d + 1) % 4);
      const left = from((d + 3) % 4);
      if (!back && right !== left) this.shape[i] = right ? BELT_CORNER_R : BELT_CORNER_L;
      else this.shape[i] = (right ? BELT_JOIN_R : 0) | (left ? BELT_JOIN_L : 0);
    }
  }
}

/**
 * Where an item at progress p (0 at the tile's back or input edge, 1 at its front) sits on a tile of
 * `shape` facing `dir`, relative to the tile centre, and the direction it travels (unit vector).
 * A corner's path is the quarter circle of radius ½ round the tile corner between its input edge
 * and its front edge; every other shape runs straight back to front.
 */
export function itemOnBelt(shape: number, dir: number, p: number, out: { x: number; z: number; tx: number; tz: number }): typeof out {
  const fx = DX[dir & 3]!;
  const fz = DZ[dir & 3]!;
  if (shape !== BELT_CORNER_R && shape !== BELT_CORNER_L) {
    out.x = fx * (p - 0.5);
    out.z = fz * (p - 0.5);
    out.tx = fx;
    out.tz = fz;
    return out;
  }
  // the side the item comes in from: right (d + 1) or left (d + 3) of the flow
  const s = shape === BELT_CORNER_R ? (dir + 1) % 4 : (dir + 3) % 4;
  const sx = DX[s]!;
  const sz = DZ[s]!;
  // the arc's centre: the tile corner between the input side and the front, ½ along each
  const cx = (fx + sx) / 2;
  const cz = (fz + sz) / 2;
  // from the input edge's midpoint (½ toward the side) to the front edge's midpoint (½ forward)
  const a = (p * Math.PI) / 2;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  // start offset from the centre: −½ forward; it turns toward −½ sideways
  out.x = cx - 0.5 * (fx * ca + sx * sa);
  out.z = cz - 0.5 * (fz * ca + sz * sa);
  // the derivative of the position, normalised: ½ (fx sin a − sx cos a) · π/2
  const tx = fx * sa - sx * ca;
  const tz = fz * sa - sz * ca;
  out.tx = tx;
  out.tz = tz;
  return out;
}
