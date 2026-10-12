// W24 gates. A gate is converted from finished walls: GATE_WIDTH (3) wall tiles along the run,
// as deep as the wall (1 to GATE_MAX_DEPTH rows). The placement predicate is W23's, ported
// unchanged (look/src/w23/walls/grid.ts checkGateAxis and checkGate), over a grid view of the
// world: `plainWall` = a wall building on the tile (any construction state), `solid` = a wall or
// a gate. The world then also requires every footprint tile to be a complete wall (no reserved or
// started tile), and converts atomically: the footprint's walls are removed and the gate site is
// created in the same tick, at tier 1, with no refund for the walls (balance.ts GATE_COST_MULT).
// W32: a footprint wall being demolished (demolish > 0), or one a unit holds a demolish order on,
// refuses the conversion with a reason.
//
// Passability (world.ts rebuildGrids): player units may pass only through the centre column of a
// complete gate (the corridor, 1 tile wide, through every row); the two outer columns are solid
// for everyone. Aliens treat every footprint tile as a wall, and the flow field's corner rule
// stops them cutting diagonally past a gate's corners. Each footprint tile's flow cost uses the
// gate's hit points ÷ depth, so breaking the gate is charged once along a route (flowfield.ts).

import { B, buildingInfo } from './kinds.ts';
import { constructionState } from './schema.ts';
import { gateStats } from './balance.ts';
import type { World } from './world.ts';

export const GATE_WIDTH = 3;
export const GATE_MAX_DEPTH = 4;
export const AXIS_X = 0;
export const AXIS_Z = 1;

export interface GateCheck {
  ok: boolean;
  /** Why it was refused (empty when ok). */
  reason: string;
  axis: 'x' | 'z';
  lo: number;
  hi: number;
  tiles: Array<[number, number]>;
}

/** The two questions W23's predicate asks of the grid. */
export interface GateGrid {
  /** Wall or gate: what the autotiler joins to. */
  solid(x: number, z: number): boolean;
  /** A wall tile that is not part of a gate. */
  plainWall(x: number, z: number): boolean;
}

/**
 * Whether a gate fits with its centre on (cx, cz) along `axis`. A gate is GATE_WIDTH (3) tiles
 * along the wall and as deep as the wall (1–4 rows): every tile of the 3 × depth block must be
 * plain wall, the wall must continue past both ends on every row (the gate joins the wall on
 * both sides), and the ground just in front of and behind the block must be clear (the gate
 * passes right through a straight run, not into a corner, a T or a wider block).
 * (W23 grid.ts checkGateAxis, unchanged but for taking the grid as a parameter.)
 */
export function checkGateAxis(g: GateGrid, cx: number, cz: number, axis: 'x' | 'z'): GateCheck {
  const ax = axis === 'x' ? 1 : 0;
  const az = axis === 'x' ? 0 : 1;
  // across the run
  const bx = az;
  const bz = ax;
  const half = (GATE_WIDTH - 1) / 2;
  const at = (u: number, v: number): [number, number] => [cx + ax * u + bx * v, cz + az * u + bz * v];
  const rowWall = (v: number) => {
    for (let u = -half; u <= half; u++) if (!g.plainWall(...at(u, v))) return false;
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
    if (!g.plainWall(...at(-half - 1, v)) || !g.plainWall(...at(half + 1, v))) return fail('the wall must continue past both ends');
  }
  for (let u = -half; u <= half; u++) {
    if (g.solid(...at(u, lo - 1)) || g.solid(...at(u, hi + 1))) return fail('not a straight run (something joins the side)');
  }
  const tiles: Array<[number, number]> = [];
  for (let v = lo; v <= hi; v++) for (let u = -half; u <= half; u++) tiles.push(at(u, v));
  return { ok: true, reason: '', axis, lo, hi, tiles };
}

/** Gate check that picks the axis itself (the run the tile sits in). (W23 grid.ts checkGate, unchanged.) */
export function checkGate(g: GateGrid, cx: number, cz: number): GateCheck {
  const a = checkGateAxis(g, cx, cz, 'x');
  const b = checkGateAxis(g, cx, cz, 'z');
  if (a.ok && b.ok) {
    // both fit (rare: a long block): follow the longer run through the centre
    const run = (dx: number, dz: number) => {
      let n = 0;
      while (g.plainWall(cx + dx * (n + 1), cz + dz * (n + 1))) n++;
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

/** The world as W23's wall grid: wall buildings in any construction state, and gates. */
export function worldGateGrid(w: World): GateGrid {
  const W = w.terrain.w;
  const H = w.terrain.h;
  const kindAt = (x: number, z: number) => {
    if (x < 0 || z < 0 || x >= W || z >= H) return -1;
    const b = w.occupancy[z * W + x]! - 1;
    return b < 0 ? -1 : w.buildings.cols.kind[b]!;
  };
  return {
    solid: (x, z) => {
      const k = kindAt(x, z);
      return k >= 0 && buildingInfo(k).role === 'wall'; // a wall or a gate
    },
    plainWall: (x, z) => kindAt(x, z) === B.wall,
  };
}

/**
 * The gate a `gate` command at centre (cx, cz) would make, or the reason it is refused.
 * `axis` forces one run axis; without it the axis is chosen as W23 does.
 */
export function planGate(w: World, cx: number, cz: number, axis?: 'x' | 'z'): GateCheck {
  const g = worldGateGrid(w);
  const check = axis ? checkGateAxis(g, cx, cz, axis) : checkGate(g, cx, cz);
  if (!check.ok) return check;
  const c = w.buildings.cols;
  for (const [x, z] of check.tiles) {
    const b = w.occupancy[z * w.terrain.w + x]! - 1;
    const state = constructionState(c.flags[b]!);
    if (state !== 'complete') {
      return { ...check, ok: false, reason: `every gate tile must be a finished wall: the wall at ${x},${z} is ${state === 'started' ? 'under construction' : 'reserved (not started)'}`, tiles: [] };
    }
    // W32: conversion would remove a wall that is being demolished, or that an engineer is on its way to demolish
    if (c.demolish[b]! > 0) return { ...check, ok: false, reason: `the wall at ${x},${z} is being demolished`, tiles: [] };
    if (demolishOrdered(w, w.buildings.id(b))) return { ...check, ok: false, reason: `the wall at ${x},${z} has a demolish order`, tiles: [] };
  }
  return check;
}

/** W32: some live unit holds a demolish order on building `id`. */
function demolishOrdered(w: World, id: number): boolean {
  for (let s = 0; s < w.units.highWater; s++) {
    if (!w.units.alive[s]) continue;
    for (const o of w.orders[s] ?? []) if (o.t === 'demolish' && o.id === id) return true;
  }
  return false;
}

/** Anchor tile and footprint of a checked gate: [tx, ty, fw, fh, dir]. */
export function gateFootprint(check: GateCheck): [number, number, number, number, number] {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const [x, z] of check.tiles) {
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x);
    z1 = Math.max(z1, z);
  }
  return [x0, z0, x1 - x0 + 1, z1 - z0 + 1, check.axis === 'x' ? AXIS_X : AXIS_Z];
}

/** Rows across the run (1–4) of a gate building with footprint fw × fh along `dir`. */
export const gateDepth = (fw: number, fh: number, dir: number): number => (dir === AXIS_X ? fh : fw);

/** True when tile (x, z) is in the centre column (the friendly corridor) of the gate anchored at (tx, ty). */
export function inGateCorridor(tx: number, ty: number, dir: number, x: number, z: number): boolean {
  return dir === AXIS_X ? x === tx + 1 : z === ty + 1;
}

/** Tier-1 maximum hit points of a gate with `tiles` footprint tiles (wall hp × tiles), before tuning. */
export const gateBaseHp = (tiles: number): number => gateStats(tiles).hp;

// Gate build and upgrade work: kinds.ts (pure, so the render thread can read it; W25b).
export { gateBuildWork, gateUpgradeWork } from './kinds.ts';
