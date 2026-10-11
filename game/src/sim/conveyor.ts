// Advanced-part chain: salvage depot -> one-lane belts -> machines -> parts stock.
//
// Belts hold one item per tile; an item crosses a tile at BELT_TILES_PER_SECOND and then moves to
// the tile ahead if that slot is free, otherwise it waits at the end of its tile, so a blocked
// machine backs the belt up tile by tile. Belts take items from behind and from either side (not
// from the front). A splitter sends items alternately to its left and right; a merger takes from
// behind, left and right in turn when more than one input is waiting.
// A machine takes items from a belt pointing into it (only its input kind; capacity two batches),
// and puts its output on a belt whose back faces it. The depot does the same with salvage the
// engineers delivered. The assembler's parts go straight into the shared parts stock.
// Belts are processed downstream first, so a moving queue advances together in one tick.
// W29: with belts on, an extractor puts its buffer on a belt whose back faces it, one mass or rare
// item per tick while the buffer holds at least 1 (the depot's rule). The core takes mass and rare
// items from a belt pointing into any of its perimeter cells (each belt tile moves at most one item
// a tick, so one item per input cell per tick) and adds each to the pool; it refuses every other
// item, and everything while disabled, so the belt backs up.

import { BF_ACTIVE, BF_COMPLETE, BF_DISABLED, BF_STARVED } from './schema.ts';
import { B, BELT_TILES_PER_SECOND, ITEM_MASS, ITEM_NONE, ITEM_PART, ITEM_RARE, ITEM_SALVAGE, TICK_SECONDS, buildingInfo, isBelt } from './kinds.ts';
import type { World } from './world.ts';

const DT = TICK_SECONDS;
const SPEED = BELT_TILES_PER_SECOND * DT;
/** An extractor buffer this close to 1 holds a whole item (f32 sums of 0.1 land either side of 1). */
const WHOLE = 1 - 1e-4;
/** Belt direction 0..3: +x, +z, -x, -z. */
export const BDX = [1, 0, -1, 0] as const;
export const BDZ = [0, 1, 0, -1] as const;

function frontCell(w: World, s: number, d: number): number {
  const c = w.buildings.cols;
  const x = c.tx[s]! + BDX[d]!;
  const z = c.ty[s]! + BDZ[d]!;
  if (x < 0 || z < 0 || x >= w.terrain.w || z >= w.terrain.h) return -1;
  return z * w.terrain.w + x;
}

const isComplete = (w: World, s: number) => (w.buildings.cols.flags[s]! & BF_COMPLETE) !== 0;

/** Downstream-first processing order for belt pieces. */
function computeOrder(w: World): void {
  const b = w.buildings;
  const c = b.cols;
  const depth = new Map<number, number>();
  const slots: number[] = [];
  for (let s = 0; s < b.highWater; s++) if (b.alive[s] && isBelt(c.kind[s]!)) slots.push(s);
  const visiting = new Set<number>();
  const depthOf = (s: number): number => {
    const known = depth.get(s);
    if (known !== undefined) return known;
    if (visiting.has(s)) return 0; // a loop: break it anywhere
    visiting.add(s);
    const outs = c.kind[s] === B.splitter ? [(c.dir[s]! + 1) & 3, (c.dir[s]! + 3) & 3] : [c.dir[s]!];
    let d = 0;
    for (const o of outs) {
      const cell = frontCell(w, s, o);
      const t = cell < 0 ? -1 : w.occupancy[cell]! - 1;
      if (t >= 0 && isBelt(c.kind[t]!)) d = Math.max(d, depthOf(t) + 1);
    }
    visiting.delete(s);
    depth.set(s, d);
    return d;
  };
  for (const s of slots) depthOf(s);
  slots.sort((a, z) => depth.get(a)! - depth.get(z)! || a - z);
  w.beltOrder = Int32Array.from(slots);
  w.beltsDirty = false;
}

/** Side of `src` cell relative to belt piece t: 0 behind, 1 left, 2 right, 3 front, -1 not adjacent. */
function sideOf(w: World, t: number, srcCell: number): number {
  const c = w.buildings.cols;
  const d = c.dir[t]!;
  const cands = [(d + 2) & 3, (d + 1) & 3, (d + 3) & 3, d];
  for (let i = 0; i < 4; i++) if (frontCell(w, t, cands[i]!) === srcCell) return i;
  return -1;
}

/** True if the belt piece on side `side` of merger t has an item waiting to enter t. */
function waitingAt(w: World, t: number, side: number): boolean {
  const c = w.buildings.cols;
  const d = c.dir[t]!;
  const sd = side === 0 ? (d + 2) & 3 : side === 1 ? (d + 1) & 3 : (d + 3) & 3;
  const cell = frontCell(w, t, sd);
  if (cell < 0) return false;
  const n = w.occupancy[cell]! - 1;
  if (n < 0 || !isBelt(c.kind[n]!) || c.item[n] === ITEM_NONE || c.itemPos[n]! < 1) return false;
  const tCell = c.ty[t]! * w.terrain.w + c.tx[t]!;
  return frontCell(w, n, c.dir[n]!) === tCell;
}

/** Offers `item` from `srcCell` to the occupant of `cell`. Returns true if it was taken. */
function offer(w: World, srcCell: number, cell: number, item: number, carry: number): boolean {
  if (cell < 0) return false;
  const t = w.occupancy[cell]! - 1;
  if (t < 0 || !isComplete(w, t)) return false;
  const c = w.buildings.cols;
  const kind = c.kind[t]!;
  if (kind === B.core) {
    if (c.flags[t]! & BF_DISABLED || (item !== ITEM_MASS && item !== ITEM_RARE)) return false;
    const k = item === ITEM_MASS ? 0 : 1;
    const res = item === ITEM_MASS ? 0 : 2;
    w.pool[res] = w.pool[res]! + 1;
    w.delivered[k] = w.delivered[k]! + 1;
    const r = w.deliveryCursor * 2 + k;
    w.deliveryRing[r] = w.deliveryRing[r]! + 1;
    return true;
  }
  if (isBelt(kind)) {
    if (c.item[t] !== ITEM_NONE) return false;
    const side = sideOf(w, t, srcCell);
    if (side < 0 || side === 3) return false; // never from the front
    if (kind === B.merger) {
      const pref = c.rr[t]!;
      if (side !== pref && waitingAt(w, t, pref)) return false;
      c.rr[t] = (side + 1) % 3;
    }
    c.item[t] = item;
    c.itemPos[t] = Math.min(Math.max(0, carry), 0.5);
    c.moved[t] = w.tick;
    return true;
  }
  const m = buildingInfo(kind).machine;
  if (m && m.input === item && c.inBuf[t]! < m.inputPerOutput * 2) {
    c.inBuf[t] = c.inBuf[t]! + 1;
    return true;
  }
  return false;
}

/** Puts `item` on a belt whose back faces building s (round-robin). */
function output(w: World, s: number, item: number): boolean {
  const c = w.buildings.cols;
  const fw = c.fw[s]!;
  const fh = c.fh[s]!;
  const tx = c.tx[s]!;
  const ty = c.ty[s]!;
  const W = w.terrain.w;
  // Perimeter cells with the direction pointing away from the footprint (for a square footprint
  // the same order as W13's: east, south, west, north for each i).
  const ring: Array<[number, number, number]> = [];
  for (let i = 0; i < Math.max(fw, fh); i++) {
    if (i < fh) ring.push([tx + fw, ty + i, 0]);
    if (i < fw) ring.push([tx + i, ty + fh, 1]);
    if (i < fh) ring.push([tx - 1, ty + i, 2]);
    if (i < fw) ring.push([tx + i, ty - 1, 3]);
  }
  const n = ring.length;
  for (let k = 0; k < n; k++) {
    const [x, z, away] = ring[(c.rr[s]! + k) % n]!;
    if (x < 0 || z < 0 || x >= W || z >= w.terrain.h) continue;
    const t = w.occupancy[z * W + x]! - 1;
    if (t < 0 || !isBelt(c.kind[t]!) || !isComplete(w, t) || c.dir[t] !== away || c.item[t] !== ITEM_NONE) continue;
    c.item[t] = item;
    c.itemPos[t] = 0;
    c.moved[t] = w.tick;
    c.rr[s] = (c.rr[s]! + k + 1) % n;
    return true;
  }
  return false;
}

export function stepConveyors(w: World): void {
  if (w.beltsDirty) computeOrder(w);
  const b = w.buildings;
  const c = b.cols;
  const u = w.upkeep;
  const belts = w.belts;
  // This tick's slot of the delivery ring (the income rates' window), written by the core.
  if (belts) {
    w.deliveryRing[w.deliveryCursor * 2] = 0;
    w.deliveryRing[w.deliveryCursor * 2 + 1] = 0;
  }
  // Machines, depots and (belts on) extractors.
  for (let s = 0; s < b.highWater; s++) {
    if (!b.alive[s] || !isComplete(w, s)) continue;
    const kind = c.kind[s]!;
    if (belts && (kind === B.massExtractor || kind === B.rareExtractor)) {
      if (c.stock[s]! >= WHOLE && output(w, s, kind === B.massExtractor ? ITEM_MASS : ITEM_RARE)) c.stock[s] = c.stock[s]! - 1;
      continue;
    }
    if (kind === B.depot) {
      if (c.stock[s]! >= 1 && output(w, s, ITEM_SALVAGE)) c.stock[s] = c.stock[s]! - 1;
      continue;
    }
    const m = buildingInfo(kind).machine;
    if (!m) continue;
    if (c.flags[s]! & BF_ACTIVE) {
      if (u <= 0) c.flags[s] = c.flags[s]! | BF_STARVED;
      c.work[s] = c.work[s]! + (DT * u) / m.seconds;
      if (c.work[s]! >= 1 - 1e-9) {
        c.work[s] = 0;
        c.inBuf[s] = c.inBuf[s]! - m.inputPerOutput;
        if (m.output === ITEM_PART) {
          w.parts += 1;
          w.partsMade += 1;
        } else c.outBuf[s] = c.outBuf[s]! + 1;
      }
    }
    if (c.outBuf[s]! > 0 && output(w, s, m.output)) c.outBuf[s] = c.outBuf[s]! - 1;
  }
  // Belts, downstream first.
  const W = w.terrain.w;
  for (let i = 0; i < w.beltOrder.length; i++) {
    const s = w.beltOrder[i]!;
    if (!b.alive[s] || !isComplete(w, s) || c.item[s] === ITEM_NONE) continue;
    if (c.moved[s] !== w.tick) c.itemPos[s] = Math.min(1, c.itemPos[s]! + SPEED);
    if (c.itemPos[s]! < 1) continue;
    const here = c.ty[s]! * W + c.tx[s]!;
    const item = c.item[s]!;
    const carry = 0;
    let taken = false;
    if (c.kind[s] === B.splitter) {
      const outs = [(c.dir[s]! + 1) & 3, (c.dir[s]! + 3) & 3];
      for (let k = 0; k < 2 && !taken; k++) {
        const o = outs[(c.rr[s]! + k) & 1]!;
        if (offer(w, here, frontCell(w, s, o), item, carry)) {
          taken = true;
          c.rr[s] = (c.rr[s]! + k + 1) & 1;
        }
      }
    } else taken = offer(w, here, frontCell(w, s, c.dir[s]!), item, carry);
    if (taken) {
      c.item[s] = ITEM_NONE;
      c.itemPos[s] = 0;
    }
  }
  if (belts) w.deliveryCursor = (w.deliveryCursor + 1) % (w.deliveryRing.length / 2);
}
