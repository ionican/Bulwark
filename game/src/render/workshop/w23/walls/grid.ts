// Ported from look/src/w23/walls/grid.ts for W24 run 2a (game/src/render/workshop/README: copies, adapted only where noted).
// W23 wall grid: one wall per tile, with a tier (1–3, W7: tiers raise strength), a damage state
// (0 intact, 1 scuffed and cracked, 2 heavily damaged with the frame exposed) and an optional gate.
// Pure logic, no three.js, so the tests run it directly.
//
// Directions are indexed E = 0, S = 1, W = 2, N = 3 (world +x, +z, −x, −z; north is −z as in the
// game). A quarter turn k maps the canonical +x direction onto direction k (rotK in layout.ts), so
// "rotation" in this file is always a direction index.
//
// Autotiling: the orthogonal 4-neighbour mask (bit d set when the tile in direction d is wall or
// gate) picks the piece and its rotation:
//
//   mask bits  piece     canonical shape (rotation 0)        rotation k
//   0          post      no arms                               0
//   1          end       one arm to E                          direction of the arm
//   2          straight  arms E and W                          0 (E–W) or 1 (N–S)
//   2 adjacent corner    arms E and S                          k when the arms are k and k+1
//   3          tee       arms E, S and W (N open)              (open direction + 1) mod 4
//   4          cross     all four arms                         0
//
// Quadrant q of a tile lies between directions q and q+1 (q = 0 SE, 1 SW, 2 NW, 3 NE). Its diagonal
// neighbour decides whether a 2 × 2 block of wall fills in (layout.ts).

export const E = 0;
export const S = 1;
export const W = 2;
export const N = 3;
export const DX = [1, 0, -1, 0] as const;
export const DZ = [0, 1, 0, -1] as const;
/** Diagonal offsets of quadrants SE, SW, NW, NE. */
export const QX = [1, -1, -1, 1] as const;
export const QZ = [1, 1, -1, -1] as const;
export const DIR_NAMES = ['E', 'S', 'W', 'N'] as const;

export type Piece = 'post' | 'end' | 'straight' | 'corner' | 'tee' | 'cross';
export const PIECES: Piece[] = ['post', 'end', 'straight', 'corner', 'tee', 'cross'];

export const MAX_TIER = 3;
export const GATE_WIDTH = 3;
export const GATE_MAX_DEPTH = 4;

/** Piece and rotation for a 4-neighbour mask (bit d = neighbour in direction d). */
export function pieceFor(mask: number): { piece: Piece; rot: number } {
  const m = mask & 15;
  const bits = [0, 1, 2, 3].filter((d) => m & (1 << d));
  switch (bits.length) {
    case 0:
      return { piece: 'post', rot: 0 };
    case 1:
      return { piece: 'end', rot: bits[0]! };
    case 2: {
      const [a, b] = bits as [number, number];
      if (b - a === 2) return { piece: 'straight', rot: a };
      // adjacent pair: the arms are k and k+1 (mod 4)
      return { piece: 'corner', rot: b - a === 1 ? a : b };
    }
    case 3: {
      const open = [0, 1, 2, 3].find((d) => !(m & (1 << d)))!;
      return { piece: 'tee', rot: (open + 1) % 4 };
    }
    default:
      return { piece: 'cross', rot: 0 };
  }
}

/** Arms of a piece at a rotation, as a mask (the inverse of pieceFor). */
export function maskOf(piece: Piece, rot: number): number {
  const canon: Record<Piece, number[]> = { post: [], end: [E], straight: [E, W], corner: [E, S], tee: [E, S, W], cross: [E, S, W, N] };
  let m = 0;
  for (const d of canon[piece]) m |= 1 << ((d + rot) % 4);
  return m;
}

export interface Gate {
  id: number;
  /** Centre tile (middle of the run, on the centre row). */
  cx: number;
  cz: number;
  /** Run axis: 'x' = along E–W, 'z' = along N–S. */
  axis: 'x' | 'z';
  /** Rows across the run, as offsets from the centre row (lo ≤ 0 ≤ hi). */
  lo: number;
  hi: number;
  tier: number;
  tiles: Array<[number, number]>;
}

export interface GateCheck {
  ok: boolean;
  /** Why it was refused (empty when ok). */
  reason: string;
  axis: 'x' | 'z';
  lo: number;
  hi: number;
  tiles: Array<[number, number]>;
}

export class WallGrid {
  readonly tier: Uint8Array;
  readonly damage: Uint8Array;
  /** Gate id per tile, −1 for none. */
  readonly gateAt: Int16Array;
  readonly gates = new Map<number, Gate>();
  /** Bumped on every change; renderers rebuild their instance lists when it moves. */
  version = 0;
  private nextGate = 0;

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.tier = new Uint8Array(w * h);
    this.damage = new Uint8Array(w * h);
    this.gateAt = new Int16Array(w * h).fill(-1);
  }

  inside(x: number, z: number): boolean {
    return x >= 0 && z >= 0 && x < this.w && z < this.h;
  }

  /** Wall or gate: what the autotiler joins to. */
  solid(x: number, z: number): boolean {
    return this.inside(x, z) && this.tier[z * this.w + x]! > 0;
  }

  /** A wall tile that is not part of a gate. */
  plainWall(x: number, z: number): boolean {
    return this.solid(x, z) && this.gateAt[z * this.w + x]! < 0;
  }

  isGate(x: number, z: number): boolean {
    return this.inside(x, z) && this.gateAt[z * this.w + x]! >= 0;
  }

  tierAt(x: number, z: number): number {
    return this.inside(x, z) ? this.tier[z * this.w + x]! : 0;
  }

  damageAt(x: number, z: number): number {
    return this.inside(x, z) ? this.damage[z * this.w + x]! : 0;
  }

  mask(x: number, z: number): number {
    let m = 0;
    for (let d = 0; d < 4; d++) if (this.solid(x + DX[d]!, z + DZ[d]!)) m |= 1 << d;
    return m;
  }

  /** Diagonal neighbour of quadrant q is wall or gate. */
  diag(x: number, z: number, q: number): boolean {
    return this.solid(x + QX[q]!, z + QZ[q]!);
  }

  /** Sets a wall tile (tier 1–3). A gate tile keeps its gate. Returns true if anything changed. */
  set(x: number, z: number, tier: number): boolean {
    if (!this.inside(x, z) || tier < 1 || tier > MAX_TIER) return false;
    const i = z * this.w + x;
    if (this.gateAt[i]! >= 0) return false;
    if (this.tier[i] === tier) return false;
    this.tier[i] = tier;
    this.version++;
    return true;
  }

  /** Removes a wall tile; erasing any tile of a gate removes the whole gate. */
  erase(x: number, z: number): boolean {
    if (!this.inside(x, z)) return false;
    const i = z * this.w + x;
    const g = this.gateAt[i]!;
    if (g >= 0) {
      this.removeGate(g);
      return true;
    }
    if (this.tier[i] === 0) return false;
    this.tier[i] = 0;
    this.damage[i] = 0;
    this.version++;
    return true;
  }

  setDamage(x: number, z: number, d: number): boolean {
    if (!this.solid(x, z)) return false;
    const i = z * this.w + x;
    const v = Math.max(0, Math.min(2, d));
    if (this.damage[i] === v) return false;
    this.damage[i] = v;
    this.version++;
    return true;
  }

  /**
   * A straight line of walls from (x0, z0) along the dominant axis of the drag (Factorio's wall
   * drag): the shorter offset is ignored.
   */
  line(x0: number, z0: number, x1: number, z1: number, tier: number): number {
    let n = 0;
    if (Math.abs(x1 - x0) >= Math.abs(z1 - z0)) {
      const s = Math.sign(x1 - x0) || 1;
      for (let x = x0; x !== x1 + s; x += s) n += +this.set(x, z0, tier);
    } else {
      const s = Math.sign(z1 - z0) || 1;
      for (let z = z0; z !== z1 + s; z += s) n += +this.set(x0, z, tier);
    }
    return n;
  }

  /** Rectangle outline (fill = false) or solid block (fill = true) between two corners. */
  rect(x0: number, z0: number, x1: number, z1: number, tier: number, fill: boolean): number {
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [az, bz] = [Math.min(z0, z1), Math.max(z0, z1)];
    let n = 0;
    for (let z = az; z <= bz; z++)
      for (let x = ax; x <= bx; x++) if (fill || x === ax || x === bx || z === az || z === bz) n += +this.set(x, z, tier);
    return n;
  }

  eraseRect(x0: number, z0: number, x1: number, z1: number): number {
    let n = 0;
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) n += +this.erase(x, z);
    return n;
  }

  /** Damage brush over a rectangle. */
  damageRect(x0: number, z0: number, x1: number, z1: number, d: number): number {
    let n = 0;
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) n += +this.setDamage(x, z, d);
    return n;
  }

  clear(): void {
    this.tier.fill(0);
    this.damage.fill(0);
    this.gateAt.fill(-1);
    this.gates.clear();
    this.version++;
  }

  /**
   * Whether a gate fits with its centre on (cx, cz) along `axis`. A gate is GATE_WIDTH (3) tiles
   * along the wall and as deep as the wall (1–4 rows): every tile of the 3 × depth block must be
   * plain wall, the wall must continue past both ends on every row (the gate joins the wall on
   * both sides), and the ground just in front of and behind the block must be clear (the gate
   * passes right through a straight run, not into a corner, a T or a wider block).
   */
  checkGateAxis(cx: number, cz: number, axis: 'x' | 'z'): GateCheck {
    const ax = axis === 'x' ? 1 : 0;
    const az = axis === 'x' ? 0 : 1;
    // across the run
    const bx = az;
    const bz = ax;
    const half = (GATE_WIDTH - 1) / 2;
    const at = (u: number, v: number): [number, number] => [cx + ax * u + bx * v, cz + az * u + bz * v];
    const rowWall = (v: number) => {
      for (let u = -half; u <= half; u++) if (!this.plainWall(...at(u, v))) return false;
      return true;
    };
    const fail = (reason: string): GateCheck => ({ ok: false, reason, axis, lo: 0, hi: 0, tiles: [] });
    if (!rowWall(0)) return fail(`needs ${GATE_WIDTH} wall tiles in a row`);
    let lo = 0;
    let hi = 0;
    while (rowWall(lo - 1) && hi - lo + 1 <= GATE_MAX_DEPTH) lo--;
    while (rowWall(hi + 1) && hi - lo + 1 <= GATE_MAX_DEPTH) hi++;
    if (hi - lo + 1 > GATE_MAX_DEPTH) return fail(`wall deeper than ${GATE_MAX_DEPTH}`);
    for (let v = lo; v <= hi; v++) {
      if (!this.plainWall(...at(-half - 1, v)) || !this.plainWall(...at(half + 1, v))) return fail('the wall must continue past both ends');
    }
    for (let u = -half; u <= half; u++) {
      if (this.solid(...at(u, lo - 1)) || this.solid(...at(u, hi + 1))) return fail('not a straight run (something joins the side)');
    }
    const tiles: Array<[number, number]> = [];
    for (let v = lo; v <= hi; v++) for (let u = -half; u <= half; u++) tiles.push(at(u, v));
    return { ok: true, reason: '', axis, lo, hi, tiles };
  }

  /** Gate check that picks the axis itself (the run the tile sits in). */
  checkGate(cx: number, cz: number): GateCheck {
    const a = this.checkGateAxis(cx, cz, 'x');
    const b = this.checkGateAxis(cx, cz, 'z');
    if (a.ok && b.ok) {
      // both fit (rare: a long block): follow the longer run through the centre
      const run = (dx: number, dz: number) => {
        let n = 0;
        while (this.plainWall(cx + dx * (n + 1), cz + dz * (n + 1))) n++;
        return n;
      };
      return run(1, 0) + run(-1, 0) >= run(0, 1) + run(0, -1) ? a : b;
    }
    if (a.ok) return a;
    if (b.ok) return b;
    // report the reason for the axis that got further
    const score = (c: GateCheck) => (c.reason.startsWith('needs') ? 0 : 1);
    return score(a) >= score(b) ? a : b;
  }

  placeGate(cx: number, cz: number): Gate | null {
    const c = this.checkGate(cx, cz);
    if (!c.ok) return null;
    const id = this.nextGate++;
    const tier = Math.max(...c.tiles.map(([x, z]) => this.tierAt(x, z)));
    const g: Gate = { id, cx, cz, axis: c.axis, lo: c.lo, hi: c.hi, tier, tiles: c.tiles };
    for (const [x, z] of c.tiles) {
      this.gateAt[z * this.w + x] = id;
      this.damage[z * this.w + x] = 0;
    }
    this.gates.set(id, g);
    this.version++;
    return g;
  }

  /**
   * Adapted for the game (W24 run 2a): a gate whose footprint the simulation already decided
   * (gate.ts in the game ports checkGate). Its tiles become solid gate tiles of `g.tier`.
   */
  addGate(g: Gate): void {
    for (const [x, z] of g.tiles) {
      if (!this.inside(x, z)) continue;
      const i = z * this.w + x;
      this.gateAt[i] = g.id;
      this.tier[i] = g.tier;
      this.damage[i] = 0;
    }
    this.gates.set(g.id, g);
    this.nextGate = Math.max(this.nextGate, g.id + 1);
    this.version++;
  }

  removeGate(id: number): void {
    const g = this.gates.get(id);
    if (!g) return;
    for (const [x, z] of g.tiles) {
      const i = z * this.w + x;
      this.gateAt[i] = -1;
      this.tier[i] = 0;
      this.damage[i] = 0;
    }
    this.gates.delete(id);
    this.version++;
  }

  /** Number of wall tiles (gates included). */
  count(): number {
    let n = 0;
    for (const t of this.tier) if (t) n++;
    return n;
  }
}
