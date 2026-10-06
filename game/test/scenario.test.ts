// Headless map 1 scenario (M2 verify 2): the commander and engineers build an economy, the
// salvage chain and three defences; groups of each alien kind arrive; the defences kill them,
// engineers reclaim the wrecks, the chain turns salvage into parts, and the heavy cannon fires them.

import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/scenarios.ts';
import { A, B, U } from '../src/sim/kinds.ts';
import { BF_COMPLETE } from '../src/sim/schema.ts';
import type { World } from '../src/sim/world.ts';

const ids = (w: World, kind?: number) => {
  const out: number[] = [];
  for (let s = 0; s < w.units.highWater; s++) if (w.units.alive[s] && (kind === undefined || w.units.cols.kind[s] === kind)) out.push(w.units.id(s));
  return out;
};

function runUntil(w: World, pred: () => boolean, maxTicks: number): number {
  for (let i = 0; i < maxTicks; i++) {
    if (pred()) return i;
    w.step();
  }
  return pred() ? maxTicks : -1;
}

function allComplete(w: World): boolean {
  for (let s = 0; s < w.buildings.highWater; s++) if (w.buildings.alive[s] && !(w.buildings.cols.flags[s]! & BF_COMPLETE)) return false;
  return true;
}

function count(w: World, kind: number): number {
  let n = 0;
  for (let s = 0; s < w.buildings.highWater; s++) if (w.buildings.alive[s] && w.buildings.cols.kind[s] === kind && w.buildings.cols.flags[s]! & BF_COMPLETE) n++;
  return n;
}

function reclaimAll(w: World) {
  const eng = ids(w, U.engineer);
  for (let s = 0; s < w.wrecks.highWater; s++) {
    if (!w.wrecks.alive[s]) continue;
    w.enqueue({ t: 'reclaim', ids: eng, wreck: w.wrecks.id(s) });
    return;
  }
}

describe('headless map 1 scenario', () => {
  it('builds, defends, reclaims, makes parts and fires them', () => {
    const w = createWorld(11, 'map1');
    const all = ids(w);
    expect(all.length).toBe(3); // commander + 2 engineers (W12 startCount)
    const build = (kind: number, tx: number, ty: number, dir = 0) => w.enqueue({ t: 'build', ids: all, kind, tx, ty, dir, queue: true });
    build(B.massExtractor, 54, 50);
    build(B.massExtractor, 72, 49);
    build(B.generator, 58, 66);
    // Salvage chain along z = 70: depot -> belt -> shredder -> belt -> smelter -> belt -> assembler.
    build(B.depot, 50, 70);
    build(B.belt, 52, 70);
    build(B.belt, 53, 70);
    build(B.shredder, 54, 70);
    build(B.belt, 56, 70);
    build(B.belt, 57, 70);
    build(B.smelter, 58, 70);
    build(B.belt, 60, 70);
    build(B.belt, 61, 70);
    build(B.assembler, 62, 70);
    build(B.gun, 62, 54);
    build(B.area, 66, 54);
    build(B.heavy, 59, 56);
    w.step();
    expect(w.buildings.count).toBe(16);

    const built = runUntil(w, () => allComplete(w), 9000);
    expect(built, 'everything built').toBeGreaterThan(0);
    expect(count(w, B.heavy)).toBe(1);
    expect(w.parts).toBe(0);

    // Wave A: swarm rushers.
    w.enqueue({ t: 'spawn', kind: A.rusher, entry: 0, count: 16 });
    w.step();
    expect(runUntil(w, () => w.pendingSpawns === 0 && w.aliens.count === 0, 3000), 'rushers killed').toBeGreaterThanOrEqual(0);
    expect(w.kills).toBe(16);
    expect(w.salvageFromKills).toBe(16 * 2);

    // Wave B: hunters and saboteurs.
    w.enqueue({ t: 'spawn', kind: A.hunter, entry: 0, count: 4 });
    w.enqueue({ t: 'spawn', kind: A.saboteur, entry: 0, count: 6 });
    reclaimAll(w);
    w.step();
    expect(runUntil(w, () => w.pendingSpawns === 0 && w.aliens.count === 0, 3000), 'hunters and saboteurs killed').toBeGreaterThanOrEqual(0);
    expect(w.kills).toBe(26);
    expect(w.commanderSlot()).toBeGreaterThanOrEqual(0);

    // Reclaim every wreck until the chain has made parts.
    for (let round = 0; round < 40 && w.partsMade < 8; round++) {
      reclaimAll(w);
      runUntil(w, () => false, 300);
    }
    expect(w.salvageDelivered, 'salvage delivered to the depot').toBeGreaterThan(20);
    expect(w.partsMade, 'parts made by the chain').toBeGreaterThanOrEqual(8);
    const partsBefore = w.parts;

    // Wave C: wall-breakers, which the heavy cannon prefers.
    w.enqueue({ t: 'spawn', kind: A.breaker, entry: 0, count: 3 });
    w.step();
    expect(runUntil(w, () => w.pendingSpawns === 0 && w.aliens.count === 0, 4000), 'breakers killed').toBeGreaterThanOrEqual(0);
    expect(w.kills).toBe(29);
    expect(w.partsUsed, 'heavy cannon fired parts').toBeGreaterThan(0);
    expect(w.parts).toBeLessThan(partsBefore + (w.partsMade - 8) + 1e-9);
    expect(w.outcome).toBe(0);
    console.log(JSON.stringify({ built, tick: w.tick, kills: w.kills, salvageKills: w.salvageFromKills, reclaimed: +w.salvageReclaimed.toFixed(1), delivered: +w.salvageDelivered.toFixed(1), partsMade: w.partsMade, partsUsed: w.partsUsed, parts: w.parts, cmdrHp: w.units.cols.hp[w.commanderSlot()], buildings: w.buildings.count, pool: Array.from(w.pool).map((x) => Math.round(x)), fieldBuilds: w.fieldBuilds }));
  });
});
