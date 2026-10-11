// W24 run 2a, criterion 5: the wall topology is rebuilt only when the layout key changes. Hit-point
// and progress changes reach the drawn instances as per-instance data (damage state, build cut)
// with 0 rebuilds; each of tile added, tile removed, tier upgrade, reserved → started, wall → gate
// conversion and gate axis change is exactly 1 rebuild, and the drawn parts follow it.

import { describe, expect, it } from 'vitest';
import { InstancedMesh } from 'three';
import { B } from '../src/sim/kinds.ts';
import { BF_COMPLETE, BF_STARTED } from '../src/sim/schema.ts';
import type { Snapshot } from '../src/sim/snapshot.ts';
import { slotOf } from '../src/sim/table.ts';
import { World } from '../src/sim/world.ts';
import { draw, renderer, rowOf, snapshotOf, terrain } from './w24r2a-fixtures.ts';

const { r } = renderer();

/** A straight run of complete walls (x0 … x1, row y), plus extra tiles. */
function walls(x0: number, x1: number, y: number, more: Array<[number, number]> = []): { w: World; ids: number[] } {
  const w = new World(1, terrain, { waves: false });
  const ids: number[] = [];
  for (let x = x0; x <= x1; x++) ids.push(w.placeBuilding(B.wall, x, y, true));
  for (const [x, z] of more) ids.push(w.placeBuilding(B.wall, x, z, true));
  if (ids.some((i) => i < 0)) throw new Error('wall placement failed');
  return { w, ids };
}

/** Rebuilds caused by drawing `s` (after a baseline draw of `base`). */
function rebuildsBetween(base: Snapshot, s: Snapshot): number {
  draw(r, base);
  const n0 = r.walls.rebuilds;
  draw(r, s);
  return r.walls.rebuilds - n0;
}

/** Drawn wall part ids (any level-0 batch with instances). */
function drawnParts(): Set<string> {
  const out = new Set<string>();
  r.group.traverse((o) => {
    if (o instanceof InstancedMesh && o.visible && o.count > 0 && o.userData.part && o.userData.level === 0) out.add(o.userData.part as string);
  });
  return out;
}

/** Instance data (glow, damage, cut) of the level-0 instances on tile (x, y). */
function dataOn(x: number, y: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  r.group.traverse((o) => {
    if (!(o instanceof InstancedMesh) || !o.visible || o.count === 0 || !o.instanceColor || o.userData.level !== 0) return;
    const p = o.userData.part as string | undefined;
    if (!p || !(p.startsWith('core/') || p.startsWith('face/'))) return;
    const a = o.instanceMatrix.array as Float32Array;
    const c = o.instanceColor.array as Float32Array;
    for (let i = 0; i < o.count; i++) if (Math.floor(a[i * 16 + 12]!) === x && Math.floor(a[i * 16 + 14]!) === y) out.push([c[i * 3]!, c[i * 3 + 1]!, c[i * 3 + 2]!]);
  });
  return out;
}

describe('criterion 5: wall layout key', () => {
  const X0 = 50;
  const X1 = 58;
  const Y = 60;

  it('hit points only: 0 rebuilds; the damage state changes on the instances', () => {
    const { w, ids } = walls(X0, X1, Y);
    const base = snapshotOf(w);
    const s = snapshotOf(w);
    const row = rowOf(s, ids[3]!);
    s.buildings.cols.hp[row] = s.buildings.cols.maxHp[row]! * 0.2;
    expect(rebuildsBetween(base, s)).toBe(0);
    const dmg = dataOn(X0 + 3, Y).map((d) => d[1]);
    expect(dmg.length).toBeGreaterThan(0);
    // walls are static structures: damage + 10 (W23's world-space texture flag); 2 = heavily damaged
    expect(new Set(dmg)).toEqual(new Set([12]));
    expect(new Set(dataOn(X0 + 4, Y).map((d) => d[1]))).toEqual(new Set([10]));
  });

  it('progress only (a started tile building up): 0 rebuilds; the cut moves on the instances', () => {
    const { w, ids } = walls(X0, X1, Y);
    const a = snapshotOf(w);
    const row = rowOf(a, ids[2]!);
    a.buildings.cols.flags[row] = BF_STARTED;
    a.buildings.cols.progress[row] = 0.2;
    const b = snapshotOf(w);
    b.buildings.cols.flags[row] = BF_STARTED;
    b.buildings.cols.progress[row] = 0.6;
    draw(r, a);
    const cutA = dataOn(X0 + 2, Y)[0]![2];
    expect(rebuildsBetween(a, b)).toBe(0);
    const cutB = dataOn(X0 + 2, Y)[0]![2];
    expect(cutB).toBeGreaterThan(cutA);
  });

  it('a tile added: exactly 1 rebuild', () => {
    const before = walls(X0, X1, Y);
    const after = walls(X0, X1 + 1, Y);
    expect(rebuildsBetween(snapshotOf(before.w), snapshotOf(after.w))).toBe(1);
  });

  it('a tile removed: exactly 1 rebuild', () => {
    const { w, ids } = walls(X0, X1, Y);
    const base = snapshotOf(w);
    w.removeBuilding(slotOf(ids[4]!));
    expect(rebuildsBetween(base, snapshotOf(w))).toBe(1);
  });

  it('a tier upgrade: exactly 1 rebuild, and the tier-2 faces are drawn', () => {
    const { w, ids } = walls(X0, X1, Y);
    const base = snapshotOf(w);
    const s = snapshotOf(w);
    s.buildings.cols.tier[rowOf(s, ids[4]!)] = 2;
    expect(rebuildsBetween(base, s)).toBe(1);
    expect([...drawnParts()].some((p) => p.endsWith('/2'))).toBe(true);
    // a second, identical frame does not rebuild
    expect(rebuildsBetween(s, s)).toBe(0);
  });

  it('reserved → started: exactly 1 rebuild (a started tile joins its neighbours)', () => {
    const { w, ids } = walls(X0, X1, Y);
    const a = snapshotOf(w);
    const row = rowOf(a, ids[5]!);
    a.buildings.cols.flags[row] = 0;
    a.buildings.cols.progress[row] = 0;
    const b = snapshotOf(w);
    b.buildings.cols.flags[row] = BF_STARTED;
    b.buildings.cols.progress[row] = 0.01;
    expect(rebuildsBetween(a, b)).toBe(1);
    // started → complete changes nothing structural
    const c = snapshotOf(w);
    c.buildings.cols.flags[row] = BF_STARTED | BF_COMPLETE;
    expect(rebuildsBetween(b, c)).toBe(0);
  });

  it('wall → gate conversion: exactly 1 rebuild, and gate parts are drawn', () => {
    const { w } = walls(X0, X1, Y);
    const base = snapshotOf(w);
    // the simulation's conversion: the three middle tiles removed, a gate placed in the same tick
    for (const x of [X0 + 3, X0 + 4, X0 + 5]) w.removeBuilding(w.occupancy[Y * terrain.w + x]! - 1);
    expect(w.placeBuilding(B.gate, X0 + 3, Y, true, 0, 3, 1)).toBeGreaterThanOrEqual(0);
    expect(rebuildsBetween(base, snapshotOf(w))).toBe(1);
    expect(drawnParts().has('gate/pylon')).toBe(true);
  });

  it('gate axis changed on the same 3 × 3 footprint: exactly 1 rebuild', () => {
    const w = new World(1, terrain, { waves: false });
    const gate = w.placeBuilding(B.gate, 52, 60, true, 0, 3, 3);
    expect(gate).toBeGreaterThanOrEqual(0);
    const a = snapshotOf(w);
    const b = snapshotOf(w);
    b.buildings.cols.dir[rowOf(b, gate)] = 1;
    expect(rebuildsBetween(a, b)).toBe(1);
  });
});
