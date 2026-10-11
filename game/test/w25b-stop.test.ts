// W25b: Stop clears unstarted queued buildings (Richard, 2026-10-09: "stop should clear them").
// Stop (the X key and the panel button both send the `stop` command) empties the selected units'
// queues by the same rule as an unshifted replace (queue.ts dropOrphans): every reserved site that
// no unit still has queued is removed; a started site stays, part-built; a wall run that no unit
// holds any more loses its reserved tiles and its run-table slot, and keeps its started tiles.

import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world.ts';
import { B, U } from '../src/sim/kinds.ts';
import { BF_COMPLETE, BF_STARTED, isReserved } from '../src/sim/schema.ts';
import { runById, runProgress } from '../src/sim/runs.ts';
import type { Command } from '../src/sim/commands.ts';
import { flatWorld } from './fixtures.ts';

const flat = () => flatWorld(48, 48, { rich: true });
const ordersOf = (w: World, id: number) => w.orders[w.units.slotForId(id)] ?? [];
const exists = (w: World, site: number) => w.buildings.slotForId(site) >= 0;
const flagsOf = (w: World, site: number) => w.buildings.cols.flags[w.buildings.slotForId(site)]!;
const siteAt = (w: World, tx: number, ty: number) => {
  const s = w.occupancy[ty * w.terrain.w + tx]! - 1;
  return s < 0 ? -1 : w.buildings.id(s);
};

function apply(w: World, cmd: Command): void {
  const why = w.submit(cmd);
  if (why) throw new Error(`refused: ${why}`);
  const rejected = w.applyRejected.length;
  w.step();
  if (w.applyRejected.length !== rejected) throw new Error(`refused at its tick: ${w.applyRejected[w.applyRejected.length - 1]!.reason}`);
}
function build(w: World, ids: number[], kind: number, tx: number, ty: number, queue: boolean): number {
  apply(w, { t: 'build', ids, kind, tx, ty, queue });
  const site = siteAt(w, tx, ty);
  expect(site, `site at ${tx},${ty}`).toBeGreaterThanOrEqual(0);
  return site;
}

describe('W25b: Stop clears unstarted queued buildings', () => {
  it('Stop on A, where A holds X and Y reserved and B also holds Y: X is removed and Y stays', () => {
    const w = flat();
    // far from the sites, so nothing is started while the orders are given
    const a = w.spawnUnit(U.engineer, 44.5, 44.5);
    const b = w.spawnUnit(U.engineer, 44.5, 40.5);
    const X = build(w, [a], B.gun, 6, 6, true);
    const Y = build(w, [a, b], B.gun, 12, 6, true);
    expect(isReserved(flagsOf(w, X)) && isReserved(flagsOf(w, Y))).toBe(true);
    apply(w, { t: 'stop', ids: [a] });
    expect(ordersOf(w, a)).toEqual([]);
    expect(exists(w, X)).toBe(false);
    expect(exists(w, Y)).toBe(true);
    expect(ordersOf(w, b).map((o) => (o.t === 'build' ? o.id : -1))).toEqual([Y]);
  });

  it('a started site stays part-built; the reserved ones queued behind it go', () => {
    const w = flat();
    const a = w.spawnUnit(U.engineer, 8.5, 9.5);
    const X = build(w, [a], B.gun, 8, 6, true);
    const Y = build(w, [a], B.gun, 20, 6, true);
    let t = 0;
    while (!(flagsOf(w, X) & BF_STARTED) && t++ < 100) w.step();
    expect(flagsOf(w, X) & BF_STARTED).toBeTruthy();
    expect(flagsOf(w, X) & BF_COMPLETE).toBeFalsy();
    apply(w, { t: 'stop', ids: [a] });
    expect(exists(w, X)).toBe(true);
    expect(isReserved(flagsOf(w, X))).toBe(false);
    expect(exists(w, Y)).toBe(false);
  });

  it('a wall run whose only builder stops loses its reserved tiles and its slot; its started tiles stay', () => {
    const w = flat();
    const e = w.spawnUnit(U.engineer, 8.5, 10.5);
    apply(w, { t: 'buildRun', ids: [e], from: [10, 10], to: [19, 10], depth: 1 });
    const run = w.runs.find((r) => r !== null)!;
    while (runProgress(w, run).started === 0) w.step();
    apply(w, { t: 'stop', ids: [e] });
    expect(runById(w, run.id)).toBeNull();
    const p = runProgress(w, run);
    expect(p.reserved).toBe(0);
    expect(p.started + p.complete).toBe(1);
    expect(p.gone).toBe(9);
  });

  it('a wall run another builder still works on keeps all its tiles when one builder stops', () => {
    const w = flat();
    const e1 = w.spawnUnit(U.engineer, 8.5, 10.5);
    const e2 = w.spawnUnit(U.engineer, 8.5, 12.5);
    apply(w, { t: 'buildRun', ids: [e1, e2], from: [10, 10], to: [19, 10], depth: 1 });
    const run = w.runs.find((r) => r !== null)!;
    const before = run.sites.length;
    apply(w, { t: 'stop', ids: [e1] });
    expect(runById(w, run.id)).toBe(run);
    expect(runProgress(w, run).gone).toBe(0);
    expect(run.sites.length).toBe(before);
  });

  it('Stop with nothing queued changes nothing, and a gate site is never removed by it', () => {
    const w = flat();
    for (let x = 10; x <= 14; x++) w.placeBuilding(B.wall, x, 20, true);
    const a = w.spawnUnit(U.engineer, 40.5, 40.5);
    apply(w, { t: 'gate', ids: [a], tx: 12, ty: 20 });
    const gate = siteAt(w, 12, 20);
    expect(isReserved(flagsOf(w, gate))).toBe(true);
    apply(w, { t: 'stop', ids: [a] });
    expect(exists(w, gate)).toBe(true);
    const count = w.buildings.count;
    apply(w, { t: 'stop', ids: [a] });
    expect(w.buildings.count).toBe(count);
  });
});
