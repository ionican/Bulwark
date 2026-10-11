// Ported from look/src/w23/walls/layout.ts for W24 run 2a (game/src/render/workshop/README: copies, adapted only where noted).
// W23 wall layout: turns a WallGrid into part instances. Pure logic (no three.js); the tests and
// the renderer both use it.
//
// A wall is drawn as a core (the gunmetal frame and walkway deck, shared by every tier) plus face
// armour on every exposed side (per tier). Tile space: centre at the origin, x east, z south, the
// core HALF = 0.3 tiles either side of the tile's centre lines. Pieces are authored for one
// canonical direction and turned by a quarter turn k (rotK): k maps +x onto direction k.
//
//   core/hub       [−h, h]²                         always (unless straight or full)
//   core/arm       [h, ½] × [−h, h]                  one per neighbour, turned to it
//   core/infill    [h, ½]²  (quadrant SE)            quadrant q when both sides AND the diagonal are
//                                                    wall: the joins of a solid block fill in
//   core/straight  [−½, ½] × [−h, h]                 straight pieces (one instance, not three)
//   core/full      [−½, ½]²                          all 8 neighbours wall (inside a thick wall)
//
// Faces, authored on side E (outward +x, face root at x = h), split along z so that a run of tiles
// draws a continuous face (the pieces meet on the tile edges with identical cross-sections):
//   face/prev  z ∈ [−½, −h]  side face of the arm towards direction k−1, when that arm exists and
//                            its side is open (no infill in that quadrant)
//   face/hub   z ∈ [−h, h]   side k of the hub, when there is no neighbour on side k
//   face/next  z ∈ [h, ½]    side face of the arm towards direction k+1
//   face/full  z ∈ [−½, ½]   all three at once (a straight wall's side)
// Corners: convex (a hub corner open on both sides: post, end and corner pieces), concave (two arms
// with no diagonal: the inside of an L). Caps sit on the hub of thin walls by piece type (post,
// end, corner, tee, cross; straight runs have none). Buttresses stand on the outer face of walls at
// least 2 deep (every other tile). Joints: where a face meets a lower-tier face on the next tile,
// the higher tier adds a pilaster over the step, so mixed tiers join cleanly.

import { DX, DZ, GATE_WIDTH, PIECES, WallGrid, pieceFor, type Gate, type Piece } from './grid.ts';

/** Core half-width (tiles): a 1-deep wall's core is 0.6 tiles (1.2 m) wide. */
export const HALF = 0.3;
/** Height of the walkway deck (top of the core), tiles. */
export const DECK = 1.2;

export interface TierSpec {
  /** Face armour thickness outward from the core. */
  face: number;
  /** Parapet top. */
  parapet: number;
  /** Highest point (crenellations, caps). */
  top: number;
}
export const TIERS: Record<number, TierSpec> = {
  1: { face: 0.06, parapet: 1.4, top: 1.42 },
  2: { face: 0.1, parapet: 1.46, top: 1.49 },
  3: { face: 0.14, parapet: 1.44, top: 1.66 },
};

export interface WallInst {
  part: string;
  /** Tile coordinates. */
  x: number;
  z: number;
  /** Quarter turns (direction index the canonical +x maps onto). */
  rot: number;
  /** Offset in the turned frame. */
  off: [number, number, number];
  tier: number;
  damage: number;
}

export interface GateInst {
  gate: Gate;
  /** Centre of the gate (tile coordinates, fractional on the across axis). */
  x: number;
  z: number;
  rot: number;
  depth: number;
  /** Static parts in gate space (x along the run). */
  parts: Array<{ part: string; rot: number; off: [number, number, number] }>;
}

export const CORE_PARTS = ['core/hub', 'core/arm', 'core/infill', 'core/straight', 'core/full'] as const;
export const TIER_PARTS = ['face/full', 'face/hub', 'face/prev', 'face/next', 'convex', 'concave', 'buttress', 'joint', ...PIECES.filter((p) => p !== 'straight').map((p) => `cap/${p}`)] as const;
export const GATE_PARTS = ['gate/pylon', 'gate/cap', 'gate/floor', 'gate/leaf'] as const;

/** Every wall part id (tier parts carry their tier: `face/full/2`). */
export function wallPartIds(): string[] {
  const out: string[] = [...CORE_PARTS];
  for (const t of [1, 2, 3]) for (const p of TIER_PARTS) out.push(`${p}/${t}`);
  out.push(...GATE_PARTS);
  return out;
}

const mod4 = (k: number) => ((k % 4) + 4) % 4;

export interface TileInfo {
  mask: number;
  piece: Piece;
  rot: number;
  /** Quadrants with infill (bit q). */
  infill: number;
}

export function tileInfo(g: WallGrid, x: number, z: number): TileInfo {
  const mask = g.mask(x, z);
  const { piece, rot } = pieceFor(mask);
  let infill = 0;
  for (let q = 0; q < 4; q++) if (mask & (1 << q) && mask & (1 << mod4(q + 1)) && g.diag(x, z, q)) infill |= 1 << q;
  return { mask, piece, rot, infill };
}

/**
 * Instances for one wall tile (not a gate tile). `out` is appended to; returns the number added.
 */
export function tileInstances(g: WallGrid, x: number, z: number, out: WallInst[]): number {
  const n0 = out.length;
  const tier = g.tierAt(x, z);
  if (!tier || g.isGate(x, z)) return 0;
  const damage = g.damageAt(x, z);
  const { mask, piece, rot, infill } = tileInfo(g, x, z);
  const nb = (d: number) => !!(mask & (1 << mod4(d)));
  const quad = (q: number) => !!(infill & (1 << mod4(q)));
  const add = (part: string, r: number, off: [number, number, number] = [0, 0, 0], t = tier) => out.push({ part, x, z, rot: mod4(r), off, tier: t, damage });
  const h = HALF;

  // core
  if (mask === 15 && infill === 15) add('core/full', 0);
  else if (piece === 'straight') add('core/straight', rot);
  else {
    add('core/hub', 0);
    for (let d = 0; d < 4; d++) if (nb(d)) add('core/arm', d);
    for (let q = 0; q < 4; q++) if (quad(q)) add('core/infill', q);
  }

  // faces, side by side
  for (let d = 0; d < 4; d++) {
    const hub = !nb(d);
    // the arm towards d+1 shows its side-d face unless quadrant d (between d and d+1) is filled
    const next = nb(d + 1) && !quad(d);
    // the arm towards d−1 shows its side-d face unless quadrant d−1 is filled
    const prev = nb(d - 1) && !quad(d - 1);
    if (hub && next && prev) add(`face/full/${tier}`, d);
    else {
      if (hub) add(`face/hub/${tier}`, d);
      if (next) add(`face/next/${tier}`, d);
      if (prev) add(`face/prev/${tier}`, d);
    }
    // joints: a face segment that ends on a tile edge where the next tile's face is a lower tier
    const lower = (dd: number) => {
      const t2 = g.tierAt(x + DX[mod4(dd)]!, z + DZ[mod4(dd)]!);
      return t2 > 0 && t2 < tier && !g.isGate(x + DX[mod4(dd)]!, z + DZ[mod4(dd)]!);
    };
    if (next && lower(d + 1)) add(`joint/${tier}`, d, [h, 0, 0.5]);
    if (prev && lower(d - 1)) add(`joint/${tier}`, d, [h, 0, -0.5]);
    // buttress on the outer face of a wall at least two deep, every other tile along the face
    const along = d % 2 === 0 ? z : x;
    if (hub && nb(d + 2) && (nb(d + 1) || nb(d - 1)) && (along & 1) === 0) add(`buttress/${tier}`, d);
  }

  // corners
  for (let q = 0; q < 4; q++) {
    if (!nb(q) && !nb(q + 1)) add(`convex/${tier}`, q);
    else if (nb(q) && nb(q + 1) && !quad(q)) add(`concave/${tier}`, q);
  }

  // caps on thin walls (no infill anywhere on the tile); straight runs have none
  if (piece !== 'straight' && infill === 0) add(`cap/${piece}/${tier}`, rot);
  return out.length - n0;
}

/** Every wall instance of the grid (gate tiles excluded), in tile order. */
export function wallInstances(g: WallGrid): WallInst[] {
  const out: WallInst[] = [];
  for (let z = 0; z < g.h; z++) for (let x = 0; x < g.w; x++) if (g.tierAt(x, z)) tileInstances(g, x, z, out);
  return out;
}

/** Width of a gate pylon along the run (tiles); the opening between the pylons is 2 tiles (4 m). */
export const PYLON_W = 0.5;
/** Pylon height. */
export const PYLON_H = 1.9;
/** Door leaf height. */
export const LEAF_H = 1.42;

/** Gate pieces in gate space: x along the run (−1.5 … 1.5), z across (rows), origin at the centre. */
export function gateInstance(g: Gate): GateInst {
  const depth = g.hi - g.lo + 1;
  const rot = g.axis === 'x' ? 0 : 1;
  const mid = (g.lo + g.hi) / 2;
  // across offset in world tiles: axis x → rows along z; axis z → rows along x
  const x = g.cx + (g.axis === 'z' ? mid : 0);
  const z = g.cz + (g.axis === 'x' ? mid : 0);
  const parts: GateInst['parts'] = [];
  // pylon centre: the pylons fill the outer half tile at each end of the run
  const px = GATE_WIDTH / 2 - PYLON_W / 2;
  for (let r = 0; r < depth; r++) {
    const v = r - (depth - 1) / 2;
    parts.push({ part: 'gate/floor', rot: 0, off: [0, 0, v] });
    // pylons at both ends: authored for the +x end (inner face towards −x); the −x end is the same
    // piece turned half round
    parts.push({ part: 'gate/pylon', rot: 0, off: [px, 0, v] });
    parts.push({ part: 'gate/pylon', rot: 2, off: [px, 0, -v] });
  }
  // end caps on the open faces of the pylons (authored facing +z, centred on the pylon)
  for (const s of [-1, 1]) {
    parts.push({ part: 'gate/cap', rot: 0, off: [s * px, 0, depth / 2] });
    parts.push({ part: 'gate/cap', rot: 2, off: [s * px, 0, depth / 2] });
  }
  return { gate: g, x, z, rot, depth, parts };
}

/**
 * Door leaves: two telescoping pairs, sliding apart along the run into the pylons. Leaf centres
 * (gate space x) at open fraction `o`; inner leaves travel twice as far as outer ones and sit on
 * the other side of the door line so they nest inside the pylon.
 */
export const LEAF_W = 0.5;
export const LEAF_Z = 0.05;
export function leafOffsets(open: number): Array<[number, number, number]> {
  const o = Math.max(0, Math.min(1, open));
  const inner = 0.25 + 1.0 * o;
  const outer = 0.75 + 0.5 * o;
  return [
    [inner, 0, -LEAF_Z],
    [outer, 0, LEAF_Z],
    [-inner, 0, LEAF_Z],
    [-outer, 0, -LEAF_Z],
  ];
}

export function gateInstances(g: WallGrid): GateInst[] {
  return [...g.gates.values()].map(gateInstance);
}

/** Totals for checks and the readout. */
export function summarise(list: WallInst[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of list) {
    const k = i.part.replace(/\/\d$/, '');
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
