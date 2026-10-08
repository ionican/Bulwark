// W24 acceptance 12 (determinism and continuation). A 3,000-tick sandbox script (buildRun, gate,
// spawnAt, tune, unlimited, startWave) is run twice; a hash of the full snapshot every 100 ticks
// must match, and each command must have produced its effect (not only equal end states).
// Continuation: save at tick 1,500 with a run half built, a gate built, tuning active and shots
// in flight; load; run to 3,000; the hashes match the uninterrupted run at every 100 ticks.

import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/scenarios.ts';
import { A, B, U, buildingInfo } from '../src/sim/kinds.ts';
import { BF_COMPLETE, T_BUILDING } from '../src/sim/schema.ts';
import { encodeSnapshot, snapshotBytes } from '../src/sim/snapshot.ts';
import { deserializeWorld, serializeWorld } from '../src/sim/save.ts';
import { runProgress } from '../src/sim/runs.ts';
import { TA_HP, TB_DAMAGE, TU_BUILD_RATE } from '../src/sim/tuning.ts';
import { map1 } from '../../model/data/map1.ts';
import type { Command } from '../src/sim/commands.ts';
import type { World } from '../src/sim/world.ts';

const SEED = 3;
const unitIds = (w: World) => {
  const out: number[] = [];
  for (let s = 0; s < w.units.highWater; s++) if (w.units.alive[s]) out.push(w.units.id(s));
  return out;
};

const SCRIPT: Array<[number, (w: World) => Command]> = [
  [1, () => ({ t: 'setUnlimited', on: true })],
  [2, (w) => ({ t: 'buildRun', ids: unitIds(w), from: [58, 58], to: [66, 58], depth: 1 })],
  [500, (w) => ({ t: 'gate', ids: unitIds(w), tx: 62, ty: 58 })],
  [700, () => ({ t: 'tune', target: 'building', kind: B.gun, field: 'damage', mult: 1.5 })],
  [800, () => ({ t: 'place', kind: B.gun, tx: 60, ty: 50 })],
  [1000, () => ({ t: 'spawnAt', kind: A.rusher, x: 61, z: 40, count: 8 })],
  [1200, (w) => ({ t: 'buildRun', ids: unitIds(w), from: [54, 74], to: [62, 74], depth: 2 })],
  [1450, () => ({ t: 'spawnAt', kind: A.hunter, x: 60.5, z: 41.5, count: 6 })],
  [1600, () => ({ t: 'tune', target: 'alien', kind: A.rusher, field: 'hp', mult: 2 })],
  [1700, () => ({ t: 'startWave', index: 0 })],
  [2000, () => ({ t: 'spawnAt', kind: A.breaker, x: 58.5, z: 44.5, count: 3 })],
  [2200, () => ({ t: 'tune', target: 'unit', kind: U.engineer, field: 'buildRate', mult: 2 })],
  [2500, () => ({ t: 'setUnlimited', on: false })],
];

/** FNV-1a over the snapshot's bytes. */
function hash(w: World): number {
  const bytes = snapshotBytes(encodeSnapshot(w));
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193) >>> 0;
  return h;
}

interface Run {
  hashes: Map<number, number>;
  save1500: Uint8Array | null;
  /** Observations proving each command took effect. */
  seen: Record<string, unknown>;
  w: World;
}

/** Steps `w` until tick `end`, applying the script, hashing every 100 ticks and recording effects. */
function play(w: World, end: number, seen: Record<string, unknown> = {}): Run {
  const hashes = new Map<number, number>();
  let save1500: Uint8Array | null = null;
  if (w.tick % 100 === 0) hashes.set(w.tick, hash(w));
  const gunShots: number[] = [];
  while (w.tick < end) {
    if (w.tick === 1500) save1500 = serializeWorld(w);
    const t = w.tick;
    for (const [tick, f] of SCRIPT) if (tick === t) w.enqueue(f(w));
    const aliensBefore = w.aliens.count;
    w.step();
    // Effects, observed right after the command's tick.
    if (t === 1) seen.unlimited = w.unlimited;
    if (t === 2) seen.run1 = w.runs.filter(Boolean).map((r) => r!.sites.length);
    if (t === 499) seen.run1Done = w.runs.every((r) => r === null) && w.buildings.count === 9;
    if (t === 500) {
      let g = -1;
      for (let s = 0; s < w.buildings.highWater; s++) if (w.buildings.alive[s] && w.buildings.cols.kind[s] === B.gate) g = s;
      seen.gate = g < 0 ? null : [w.buildings.cols.tx[g], w.buildings.cols.ty[g], w.buildings.cols.fw[g], w.buildings.cols.fh[g]];
      seen.wallsAfterGate = w.buildings.count; // 9 walls − 3 + 1 gate
    }
    if (t === 700) seen.gunDamageMult = w.tuning.b(B.gun, TB_DAMAGE);
    if (t === 800) seen.gunPlaced = w.occupancy[50 * w.terrain.w + 60]! > 0;
    if (t === 1000 || t === 1450 || t === 2000) seen[`spawned${t}`] = w.aliens.count - aliensBefore;
    if (t === 1200) seen.run2 = w.runs.filter(Boolean).map((r) => r!.sites.length);
    if (t === 1600) seen.rusherHpMult = w.tuning.a(A.rusher, TA_HP);
    if (t === 1700) seen.wave = w.pendingSpawns + w.aliens.count - aliensBefore;
    if (t === 2200) seen.engineerBuildRate = w.tuning.u(U.engineer, TU_BUILD_RATE);
    if (t === 2500) seen.unlimitedOff = !w.unlimited;
    // Every new shot from a gun turret after the tune carries 1.5 × its raw damage.
    for (let s = 0; s < w.projectiles.highWater; s++) {
      if (!w.projectiles.alive[s] || w.projectiles.cols.srcType[s] !== T_BUILDING || w.projectiles.cols.srcKind[s] !== B.gun) continue;
      gunShots.push(w.projectiles.cols.damage[s]!);
    }
    if (w.tick % 100 === 0) hashes.set(w.tick, hash(w));
  }
  if (gunShots.length) seen.gunShotDamage = [...new Set(gunShots)];
  return { hashes, save1500, seen, w };
}

describe('W24 determinism: a 3,000-tick sandbox script', () => {
  const a = play(createWorld(SEED, 'sandbox'), 3000);
  const b = play(createWorld(SEED, 'sandbox'), 3000);

  it('gives identical full-snapshot hashes every 100 ticks, run twice', () => {
    expect(a.hashes.size).toBe(31); // ticks 0, 100, ..., 3000
    expect([...a.hashes]).toEqual([...b.hashes]);
    expect(new Set(a.hashes.values()).size).toBe(31); // the state moves every 100 ticks
    expect(a.w.log.length).toBe(SCRIPT.length);
    expect(a.w.applyRejected).toEqual([]);
  });

  it('each command produced its effect', () => {
    const s = a.seen;
    expect(s.unlimited).toBe(true);
    expect(s.run1).toEqual([9]);
    expect(s.run1Done).toBe(true);
    expect(s.gate).toEqual([61, 58, 3, 1]);
    expect(s.wallsAfterGate).toBe(9 - 3 + 1);
    expect(s.gunDamageMult).toBe(1.5);
    expect(s.gunPlaced).toBe(true);
    expect(s.gunShotDamage).toEqual([buildingInfo(B.gun).weapon!.damage * 1.5]);
    expect(s.spawned1000).toBe(8);
    expect(s.run2).toEqual([18]);
    expect(s.spawned1450).toBe(6);
    expect(s.rusherHpMult).toBe(2);
    expect(s.wave).toBe(map1.waves[0]!.groups.reduce((n, g) => n + g.count, 0));
    expect(s.spawned2000).toBe(3);
    expect(s.engineerBuildRate).toBe(2);
    expect(s.unlimitedOff).toBe(true);
    expect(a.w.unlimited).toBe(false);
    expect(a.seen).toEqual(b.seen);
  });

  it('save at 1,500 (run half built, gate built, tuning active, shots in flight), load, run to 3,000: the hashes match every 100 ticks', () => {
    expect(a.save1500).not.toBeNull();
    const loaded = deserializeWorld(a.save1500!);
    expect(loaded.tick).toBe(1500);
    // The state at the save is the one the plan asks for.
    const run = loaded.runs.find((r) => r !== null)!;
    const p = runProgress(loaded, run);
    expect(p.complete).toBeGreaterThan(0);
    expect(p.reserved).toBeGreaterThan(0);
    let gate = -1;
    for (let s = 0; s < loaded.buildings.highWater; s++) if (loaded.buildings.alive[s] && loaded.buildings.cols.kind[s] === B.gate) gate = s;
    expect(loaded.buildings.cols.flags[gate]! & BF_COMPLETE).toBe(BF_COMPLETE);
    expect(loaded.tuning.b(B.gun, TB_DAMAGE)).toBe(1.5);
    expect(loaded.projectiles.count).toBeGreaterThan(0);
    let attributed = 0;
    for (let s = 0; s < loaded.projectiles.highWater; s++) if (loaded.projectiles.alive[s] && loaded.projectiles.cols.srcType[s] !== 0) attributed++;
    expect(attributed).toBe(loaded.projectiles.count);
    expect(loaded.scenario).toBe('sandbox');
    expect(loaded.unlimited).toBe(true);

    const c = play(loaded, 3000);
    for (let t = 1500; t <= 3000; t += 100) expect(c.hashes.get(t), `tick ${t}`).toBe(a.hashes.get(t));
    expect(c.hashes.size).toBe(16);
    expect(Array.from(serializeWorld(c.w))).toEqual(Array.from(serializeWorld(a.w)));
  });
});
